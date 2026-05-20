// @ts-check
/// <reference types="ses"/>

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import fs from 'node:fs';

import { q } from '@endo/errors';

/** @import { GitBackend, GitCommit, GitRef } from './git.js' */

const execFileAsync = promisify(execFile);

const gitNullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

// Every git invocation prepends these.  Together with the sanitized
// environment below, they neutralize the configuration surfaces a
// committed-in `.git/config` or repository-local hook could otherwise
// use to execute code or fork-attack the daemon.
const GIT_BASE_ARGS = harden([
  // No pager (stdin would otherwise wait for a terminal).
  '--no-pager',
  // Treat pathspecs literally; no glob expansion in our internal calls.
  '--literal-pathspecs',
  // Suppress hooks.
  '-c',
  'core.hooksPath=/dev/null',
  // Suppress filesystem-monitor helpers (they can exec a binary).
  '-c',
  'core.fsmonitor=false',
  // No `.gitattributes` filtering (textconv, filter drivers).
  '-c',
  'core.attributesFile=/dev/null',
  // No commit / tag signing prompts.
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
]);
// Note: diff.external is suppressed per-command via `--no-ext-diff`
// (see `diff`).  Setting it as a -c override resolves to empty-string
// which git tries to exec, producing "external diff died".

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const TOOL_OUTPUT_LIMIT = 50_000;

/**
 * Sanitized environment for every git invocation.  Removes ambient
 * configuration channels (`HOME` config, global config, system config,
 * credential helpers) without losing the PATH the daemon was launched
 * with — without PATH, exec finds no `git` at all.
 *
 * @param {string} repoRoot
 */
const makeGitEnv = repoRoot => ({
  PATH: process.env.PATH || '',
  // Anchor HOME / XDG inside the worktree at a daemon-managed
  // subdirectory that does not yet contain anything; git will not
  // read or write user-level config through it.
  HOME: `${repoRoot}/.git-endo-home`,
  XDG_CONFIG_HOME: `${repoRoot}/.git-endo-home`,
  // Disable the system config file (typically /etc/gitconfig).
  GIT_CONFIG_NOSYSTEM: '1',
  // Redirect the global config to the null device.
  GIT_CONFIG_GLOBAL: gitNullDevice,
  // No interactive prompts.
  GIT_TERMINAL_PROMPT: '0',
  // Force the pager to a passthrough.
  GIT_PAGER: 'cat',
  // Stable locale for deterministic parsing.
  LANG: 'C',
  LC_ALL: 'C',
  // Default commit identity.  A daemon-managed guest agent that has
  // its own identity will override these per-invocation; without a
  // default, `git commit` fails with "Please tell me who you are".
  GIT_AUTHOR_NAME: 'Endo',
  GIT_AUTHOR_EMAIL: 'endo@invalid.local',
  GIT_COMMITTER_NAME: 'Endo',
  GIT_COMMITTER_EMAIL: 'endo@invalid.local',
});

/**
 * Limits the bytes one tool call's output can balloon to, so a runaway
 * `git log` cannot fill the worker's CapTP buffer.
 *
 * @param {string} output
 * @returns {string}
 */
const truncateOutput = output => {
  if (output.length > TOOL_OUTPUT_LIMIT) {
    return `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n\n... (truncated, ${output.length} chars total)`;
  }
  return output;
};

/**
 * Reject empty, non-string, or NUL-containing values at the public
 * boundary so they cannot reach exec arguments.
 *
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
const requireNonEmptyString = (value, fieldName) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  if (value.includes('\0')) {
    throw new Error(`${fieldName} must not contain NUL bytes`);
  }
  return value;
};

/**
 * Revision arguments must additionally not start with `-` — git would
 * otherwise interpret them as flags.
 *
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
const requireRevision = (value, fieldName) => {
  const revision = requireNonEmptyString(value, fieldName);
  if (revision.startsWith('-')) {
    throw new Error(`${fieldName} must not start with "-"`);
  }
  return revision;
};

// Repository-local configurations that can execute code on read/write
// paths and must be refused before any user-facing op runs.
const EXECUTABLE_REPO_CONFIG = /^(filter\..*\.(clean|smudge|process)|merge\..*\.driver)$/u;

/**
 * Map a `git status --porcelain=v1` index-column code to the design's
 * `GitStatusEntry.index` enum.
 *
 * @param {string} code
 * @returns {'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted'}
 */
const indexCodeToStatus = code => {
  switch (code) {
    case ' ':
      return 'clean';
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
    case 'T':
      // 'T' is type change (e.g. symlink ↔ regular); fold into modified.
      return code === 'U' ? 'conflicted' : 'modified';
    default:
      // '?' (untracked) and '!' (ignored) — the index has no entry,
      // so 'clean' is the closest match in the design's vocabulary.
      return 'clean';
  }
};

/**
 * Map a `git status --porcelain=v1` worktree-column code to the
 * design's `GitStatusEntry.worktree` enum.
 *
 * @param {string} code
 * @param {string} indexCode
 * @returns {'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted'}
 */
const worktreeCodeToStatus = (code, indexCode) => {
  if (indexCode === '?' && code === '?') return 'untracked';
  if (indexCode === '!' && code === '!') return 'ignored';
  switch (code) {
    case ' ':
      return 'clean';
    case 'M':
    case 'T':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'U':
      return 'conflicted';
    default:
      return 'clean';
  }
};

/**
 * @typedef {object} RawStatusEntry
 * @property {string} path  Repository-relative path with forward slashes.
 * @property {ReturnType<typeof indexCodeToStatus>} index
 * @property {ReturnType<typeof worktreeCodeToStatus>} worktree
 * @property {string} [renamedFrom]  When the index is 'renamed' or 'copied'.
 */

/**
 * Construct the native-git backend.  The backend runs the system `git`
 * binary in a confined environment derived from the
 * fae-git-tool-reference work: sanitized environment, base args that
 * suppress hooks / monitors / external filters, timeout-and-buffer
 * caps, and a repository-root verification that runs once at
 * construction time and is cached.
 *
 * Phase 1: the infrastructure plus the simplest inspection methods
 * (revParse, currentBranch, branches, show, log, assertRepositoryRoot,
 * assertNoExecutableRepoConfig).  Phase 2 adds status, diff, and the
 * mutation surface.
 *
 * @param {object} args
 * @param {string} args.repoRoot  The host-private worktree root the
 *   git formula instantiator pulled from the mount's backing.
 * @returns {GitBackend}
 */
export const makeNativeGitBackend = ({ repoRoot }) => {
  /** @type {Promise<void> | undefined} */
  let rootVerification;

  /**
   * One-time verification.  After construction, every method assumes
   * the verification ran; assertRepositoryRoot is also wired as the
   * formula instantiator's pre-flight so unauthorized worktrees fail
   * before any user op.
   */
  const verifyRepositoryRoot = async () => {
    if (!rootVerification) {
      rootVerification = (async () => {
        // Resolve symlinks before comparison.  Without this, macOS's
        // /var → /private/var aliasing makes the mount root and git's
        // `--show-toplevel` look mismatched even when they identify
        // the same physical directory.
        const resolvedMountRoot = await fs.promises.realpath(repoRoot);
        const { stdout } = await execFileAsync(
          'git',
          [...GIT_BASE_ARGS, 'rev-parse', '--show-toplevel'],
          {
            cwd: resolvedMountRoot,
            env: makeGitEnv(resolvedMountRoot),
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
          },
        );
        const actualRoot = await fs.promises.realpath(stdout.trim());
        if (actualRoot !== resolvedMountRoot) {
          throw new Error(
            `Git worktree root mismatch: mount root is ${q(resolvedMountRoot)} but git reports ${q(actualRoot)}`,
          );
        }
      })();
    }
    return rootVerification;
  };

  /**
   * Run a sanitized git invocation and return its raw stdout, untrimmed.
   * Used by parsers (status, diff) where whitespace is significant.
   *
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  const runGitRaw = async args => {
    await verifyRepositoryRoot();
    try {
      const { stdout } = await execFileAsync(
        'git',
        [...GIT_BASE_ARGS, ...args],
        {
          cwd: repoRoot,
          env: makeGitEnv(repoRoot),
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
        },
      );
      return stdout;
    } catch (err) {
      const error =
        /** @type {Error & { stdout?: string, stderr?: string, code?: number }} */ (
          err
        );
      const detail =
        error.stderr || error.stdout || error.message || 'unknown git error';
      throw new Error(
        `git ${args[0]} failed (exit ${error.code ?? 'unknown'}):\n${truncateOutput(detail.trim())}`,
      );
    }
  };

  /**
   * Run a sanitized git invocation.  Always preceded by a
   * verification of the repository root.  Returns trimmed stdout
   * (or '(no output)' if nothing was printed) on success; raises a
   * structured error including the exit code and a truncated stderr
   * on failure.  Suitable for human-display ops; parsers should call
   * `runGitRaw` instead so leading whitespace and per-record framing
   * are preserved.
   *
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  const runGit = async args => {
    await verifyRepositoryRoot();
    try {
      const { stdout, stderr } = await execFileAsync(
        'git',
        [...GIT_BASE_ARGS, ...args],
        {
          cwd: repoRoot,
          env: makeGitEnv(repoRoot),
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
        },
      );
      const output = `${stdout}${stderr ? `\n[stderr]:\n${stderr}` : ''}`;
      return truncateOutput(output.trim() || '(no output)');
    } catch (err) {
      const error =
        /** @type {Error & { stdout?: string, stderr?: string, code?: number }} */ (
          err
        );
      const detail =
        error.stderr || error.stdout || error.message || 'unknown git error';
      throw new Error(
        `git ${args[0]} failed (exit ${error.code ?? 'unknown'}):\n${truncateOutput(detail.trim())}`,
      );
    }
  };

  /**
   * Refuse to proceed if the repository's local config enables an
   * executable filter or merge driver.  Called at the top of every
   * mutating operation (Phase 2+); included here so the contract is
   * complete.  Re-exposed on the returned backend for completeness.
   */
  const assertNoExecutableRepoConfig = async () => {
    await verifyRepositoryRoot();
    const { stdout } = await execFileAsync(
      'git',
      [...GIT_BASE_ARGS, 'config', '--local', '--name-only', '--list'],
      {
        cwd: repoRoot,
        env: makeGitEnv(repoRoot),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    const offending = stdout
      .split('\n')
      .filter(name => EXECUTABLE_REPO_CONFIG.test(name));
    if (offending.length > 0) {
      throw new Error(
        `Refusing git operation because repository config can execute commands: ${offending.join(', ')}`,
      );
    }
  };

  // Surface the assertion so phases that add mutation can call it.
  // Kept on the returned backend record below.

  const fail = name => {
    throw new Error(`Git backend method ${q(name)} is not yet implemented`);
  };

  return harden({
    assertRepositoryRoot: verifyRepositoryRoot,
    // Exposed for the phase that adds mutation surfaces; callable
    // already so the contract is complete.
    assertNoExecutableRepoConfig,

    /**
     * Parses `git status --porcelain=v1 -z`.  The NUL-delimited format
     * is what we want here: it has a well-defined, ambiguity-free
     * encoding (paths with whitespace or special characters arrive
     * verbatim) and rename/copy records embed the source-path field
     * inline rather than escaping it.
     *
     * Returns the raw structural list.  The public Git exo wraps each
     * entry into a `GitStatusEntry` by minting an `EndoMountEntry` on
     * the bound mount — the backend has no mount cap to mint with.
     *
     * @returns {Promise<RawStatusEntry[]>}
     */
    status: async () => {
      // Use the raw runner: porcelain=v1 records start with a column-
      // sensitive XY code (e.g. ' D' for a worktree-only deletion);
      // runGit's trim() would strip a leading space and shift the path.
      const out = await runGitRaw([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);
      if (out === '') {
        return harden([]);
      }
      // `--porcelain=v1 -z` separates records with NUL.  A rename / copy
      // record is followed by its source path in a second NUL-delimited
      // field.  trailing empty strings (from a final NUL) are filtered.
      const parts = out.split('\0').filter(part => part !== '');
      /** @type {RawStatusEntry[]} */
      const entries = [];
      let i = 0;
      while (i < parts.length) {
        const record = parts[i];
        if (record.length < 3) {
          i += 1;
        } else {
          const indexCode = record[0];
          const wtCode = record[1];
          const filePath = record.slice(3);
          const indexStatus = indexCodeToStatus(indexCode);
          const worktreeStatus = worktreeCodeToStatus(wtCode, indexCode);
          if (
            (indexStatus === 'renamed' || indexStatus === 'copied') &&
            i + 1 < parts.length
          ) {
            entries.push(
              harden({
                path: filePath,
                index: indexStatus,
                worktree: worktreeStatus,
                renamedFrom: parts[i + 1],
              }),
            );
            i += 2;
          } else {
            entries.push(
              harden({
                path: filePath,
                index: indexStatus,
                worktree: worktreeStatus,
              }),
            );
            i += 1;
          }
        }
      }
      return harden(entries);
    },

    /**
     * @param {object} options
     * @param {boolean} [options.cached]    Use the index instead of the worktree.
     * @param {string} [options.base]       Base revision (resolved to a string).
     * @param {string} [options.head]       Head revision (resolved to a string).
     * @param {string[]} [options.paths]    Repo-relative paths to limit the diff.
     */
    diff: async (options = {}) => {
      const opts = /** @type {{ cached?: boolean, base?: string, head?: string, paths?: string[] }} */ (
        options
      );
      // --no-ext-diff suppresses any external diff program a guest may
      // have committed into the repo config.  Combined with the rest of
      // the hardening envelope (hooks off, filters off), guests cannot
      // make `git diff` execute arbitrary code.
      const args = ['diff', '--no-ext-diff'];
      if (opts.cached) args.push('--cached');
      if (opts.base !== undefined) {
        args.push(requireRevision(opts.base, 'diff.base'));
      }
      if (opts.head !== undefined) {
        args.push(requireRevision(opts.head, 'diff.head'));
      }
      if (Array.isArray(opts.paths) && opts.paths.length > 0) {
        for (const p of opts.paths) {
          requireNonEmptyString(p, 'diff path');
        }
        args.push('--', ...opts.paths);
      }
      return runGit(args);
    },

    log: async (options = {}) => {
      const opts = /** @type {{ maxCount?: number, ref?: string }} */ (options);
      const args = ['log', '--pretty=format:%H%x09%s%x09%an%x09%ct'];
      if (typeof opts.maxCount === 'number') {
        if (!Number.isInteger(opts.maxCount) || opts.maxCount <= 0) {
          throw new Error('log.maxCount must be a positive integer');
        }
        args.push(`--max-count=${opts.maxCount}`);
      }
      if (opts.ref !== undefined) {
        args.push(requireRevision(opts.ref, 'log.ref'));
      }
      const stdout = await runGit(args);
      if (stdout === '(no output)') {
        return [];
      }
      /** @type {GitCommit[]} */
      const commits = [];
      for (const line of stdout.split('\n')) {
        if (line !== '') {
          const [oid, summary, author, committedAtStr] = line.split('\t');
          commits.push(
            harden({
              oid,
              summary,
              author,
              committedAt: committedAtStr
                ? Number.parseInt(committedAtStr, 10)
                : undefined,
            }),
          );
        }
      }
      return harden(commits);
    },

    show: async ref => {
      const revision = requireRevision(ref, 'show.ref');
      return runGit(['show', revision]);
    },

    revParse: async ref => {
      const revision = requireRevision(ref, 'revParse.ref');
      const stdout = await runGit(['rev-parse', '--verify', revision]);
      // `rev-parse --verify` returns the resolved object id.  We can't
      // tell branch vs tag vs commit from this alone; tag/branch
      // discrimination is a future enhancement (cat-file --batch-check
      // gives us the object type).
      return harden({
        name: revision,
        kind: /** @type {'commit'} */ ('commit'),
        oid: stdout === '(no output)' ? '' : stdout.trim(),
      });
    },

    /**
     * Stage the given repo-relative paths.  The public Git exo resolves
     * `EndoMountEntry` values into paths before this call.  Per-repo
     * executable filter and merge-driver config is refused at the top of
     * every mutation, in case a guest committed something that would
     * exec on read.
     *
     * @param {string[]} paths
     */
    add: async paths => {
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error('add: paths must be a non-empty array');
      }
      for (const p of paths) {
        requireNonEmptyString(p, 'add path');
      }
      await assertNoExecutableRepoConfig();
      // `--` separates options from pathspecs; with --literal-pathspecs
      // in GIT_BASE_ARGS, the paths are also glob-free.
      await runGit(['add', '--', ...paths]);
    },

    /**
     * Restore the given repo-relative paths from the index (default)
     * or from the worktree if `staged` is true.
     *
     * @param {string[]} paths
     * @param {{ staged?: boolean }} opts
     */
    restore: async (paths, opts = {}) => {
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error('restore: paths must be a non-empty array');
      }
      for (const p of paths) {
        requireNonEmptyString(p, 'restore path');
      }
      await assertNoExecutableRepoConfig();
      const args = ['restore'];
      if (opts.staged) args.push('--staged');
      args.push('--', ...paths);
      await runGit(args);
    },

    /**
     * Create a commit from the current index using the provided message.
     * Returns a `GitCommit` record reflecting the new HEAD.
     *
     * @param {string} message
     */
    commit: async message => {
      requireNonEmptyString(message, 'commit message');
      await assertNoExecutableRepoConfig();
      // -m embeds the message inline; --allow-empty-message is left off
      // so the daemon does not silently accept blank messages.
      await runGit(['commit', '-m', message]);
      // Read back the new HEAD's record so the caller learns the oid.
      const out = await runGit([
        'log',
        '-1',
        '--pretty=format:%H%x09%s%x09%an%x09%ct',
      ]);
      const [oid, summary, author, committedAtStr] = out.split('\t');
      return harden({
        oid,
        summary,
        author,
        committedAt: committedAtStr
          ? Number.parseInt(committedAtStr, 10)
          : undefined,
      });
    },

    currentBranch: async () => {
      // `symbolic-ref --short HEAD` returns the branch name when HEAD
      // is on one, and exits non-zero otherwise (detached HEAD).  We
      // surface undefined for detached and let the caller decide what
      // to do; common consumers fall back to revParse('HEAD').
      try {
        const stdout = await runGit(['symbolic-ref', '--short', 'HEAD']);
        if (stdout === '(no output)') {
          return undefined;
        }
        return harden({
          name: stdout.trim(),
          kind: /** @type {'branch'} */ ('branch'),
        });
      } catch (err) {
        const message = /** @type {Error} */ (err).message || '';
        if (/not a symbolic ref|HEAD is not a symbolic/.test(message)) {
          return undefined;
        }
        throw err;
      }
    },

    branches: async () => {
      const stdout = await runGit([
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/',
      ]);
      if (stdout === '(no output)') {
        return harden([]);
      }
      /** @type {GitRef[]} */
      const refs = [];
      for (const line of stdout.split('\n')) {
        const name = line.trim();
        if (name !== '') {
          refs.push(
            harden({ name, kind: /** @type {'branch'} */ ('branch') }),
          );
        }
      }
      return harden(refs);
    },

    /**
     * @param {string} name
     * @param {{ startPoint?: string, switchAfterCreate?: boolean }} opts
     */
    createBranch: async (name, opts = {}) => {
      requireNonEmptyString(name, 'createBranch.name');
      await assertNoExecutableRepoConfig();
      const args = ['branch', name];
      if (opts.startPoint !== undefined) {
        args.push(requireRevision(opts.startPoint, 'createBranch.startPoint'));
      }
      await runGit(args);
      if (opts.switchAfterCreate) {
        await runGit(['switch', name]);
      }
      return harden({ name, kind: /** @type {'branch'} */ ('branch') });
    },

    /**
     * @param {string} name
     * @param {{ force?: boolean }} opts
     */
    deleteBranch: async (name, opts = {}) => {
      requireNonEmptyString(name, 'deleteBranch.name');
      await assertNoExecutableRepoConfig();
      const flag = opts.force ? '-D' : '-d';
      await runGit(['branch', flag, name]);
    },

    renameBranch: async (from, to) => {
      requireNonEmptyString(from, 'renameBranch.from');
      requireNonEmptyString(to, 'renameBranch.to');
      await assertNoExecutableRepoConfig();
      await runGit(['branch', '-m', from, to]);
    },

    switch: async ref => {
      const target = requireRevision(ref, 'switch.ref');
      await assertNoExecutableRepoConfig();
      await runGit(['switch', target]);
    },

    merge: async () => fail('merge'),

    rebase: async () => fail('rebase'),

    stashPush: async () => fail('stashPush'),

    stashList: async () => fail('stashList'),

    stashShow: async () => fail('stashShow'),

    stashApply: async () => fail('stashApply'),

    stashPop: async () => fail('stashPop'),

    stashDrop: async () => fail('stashDrop'),

    tree: async () => fail('tree'),
  });
};
harden(makeNativeGitBackend);

// Internal helpers exported for tests.  Not part of the public surface.
export const internalHelpers = harden({
  GIT_BASE_ARGS,
  GIT_TIMEOUT_MS,
  TOOL_OUTPUT_LIMIT,
  makeGitEnv,
  truncateOutput,
  requireNonEmptyString,
  requireRevision,
});
