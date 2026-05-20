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
  // No external diff.
  '-c',
  'diff.external=',
  // No commit / tag signing prompts.
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
]);

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
   * Run a sanitized git invocation.  Always preceded by a
   * verification of the repository root.  Returns trimmed stdout
   * (or '(no output)' if nothing was printed) on success; raises a
   * structured error including the exit code and a truncated stderr
   * on failure.
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

    status: async () => fail('status'),

    diff: async () => fail('diff'),

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

    add: async () => fail('add'),

    restore: async () => fail('restore'),

    commit: async () => fail('commit'),

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

    createBranch: async () => fail('createBranch'),

    deleteBranch: async () => fail('deleteBranch'),

    renameBranch: async () => fail('renameBranch'),

    switch: async () => fail('switch'),

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
