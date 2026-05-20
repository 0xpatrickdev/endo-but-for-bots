// @ts-check

import { q } from '@endo/errors';
import { E } from '@endo/far';
import { makeExo } from '@endo/exo';

import { GitInterface } from './interfaces.js';

/** @import { EndoMount, EndoMountEntry, GitPowers } from './types.js' */

const GIT_OUTPUT_LIMIT = 50_000;

/**
 * @param {string} output
 * @returns {string}
 */
const truncateOutput = output => {
  if (output.length > GIT_OUTPUT_LIMIT) {
    return `${output.slice(0, GIT_OUTPUT_LIMIT)}\n\n... (truncated, ${output.length} chars total)`;
  }
  return output;
};
harden(truncateOutput);

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
const requireNonEmptyString = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  if (value.includes('\0')) {
    throw new Error(`${name} must not contain NUL bytes`);
  }
  return value;
};
harden(requireNonEmptyString);

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
const requireRevision = (value, name) => {
  if (typeof value === 'object' && value !== null) {
    const ref = /** @type {{ name?: unknown, oid?: unknown }} */ (value);
    return requireRevision(ref.oid || ref.name, name);
  }
  const revision = requireNonEmptyString(value, name);
  if (revision.startsWith('-')) {
    throw new Error(`${name} must not start with "-"`);
  }
  return revision;
};
harden(requireRevision);

/**
 * @param {string} name
 * @param {string} oid
 * @returns {{ kind: 'commit', name: string, oid: string }}
 */
const makeCommitRef = (name, oid) => harden({ kind: 'commit', name, oid });
harden(makeCommitRef);

/**
 * @param {string} name
 * @returns {{ kind: 'branch', name: string }}
 */
const makeBranchRef = name => harden({ kind: 'branch', name });
harden(makeBranchRef);

/**
 * @param {object} args
 * @param {EndoMount} args.worktree
 * @param {string} args.repoRoot
 * @param {GitPowers} args.gitPowers
 * @returns {object}
 */
export const makeGit = ({ worktree, repoRoot, gitPowers }) => {
  /** @type {Promise<string> | undefined} */
  let verifiedRepoRoot;

  const getRepoRoot = () => {
    if (verifiedRepoRoot === undefined) {
      verifiedRepoRoot = gitPowers.getRepositoryRoot(repoRoot);
    }
    return verifiedRepoRoot;
  };

  /**
   * @param {string[]} args
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  const runGitRaw = async args => {
    const root = await getRepoRoot();
    try {
      return await gitPowers.runGit(root, args);
    } catch (error) {
      const err =
        /** @type {Error & { stdout?: string, stderr?: string, code?: number }} */ (
          error
        );
      const detail = err.stderr || err.stdout || err.message || 'unknown error';
      throw new Error(
        `git ${args[0]} failed (exit ${err.code ?? 'unknown'}):\n${truncateOutput(detail.trim())}`,
      );
    }
  };

  /**
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  const runGit = async args => {
    const { stdout, stderr } = await runGitRaw(args);
    const output = `${stdout}${stderr ? `\n[stderr]:\n${stderr}` : ''}`;
    return truncateOutput(output.trim() || '(no output)');
  };

  const assertNoExecutableRepoConfig = async () => {
    await gitPowers.assertNoExecutableRepoConfig(await getRepoRoot());
  };

  /**
   * @param {unknown} branchName
   * @param {string} fieldName
   */
  const requireBranchName = async (branchName, fieldName) => {
    const name = requireRevision(branchName, fieldName);
    await gitPowers.checkRefFormat(await getRepoRoot(), name);
    return name;
  };

  /**
   * Convert mount-scoped entry descriptors into git pathspecs. The
   * worktree stat call is the provenance gate: it rejects entries that
   * were not minted for this mount root, while still allowing missing
   * logical entries that git needs for deleted or newly-created paths.
   *
   * @param {EndoMountEntry[]} entries
   * @param {string} fieldName
   * @returns {Promise<string[]>}
   */
  const pathspecsFromEntries = async (entries, fieldName) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`${fieldName} must be a non-empty array`);
    }
    return Promise.all(
      entries.map(async entry => {
        await E(worktree).stat(entry);
        const segments = await E(entry).path();
        if (!Array.isArray(segments)) {
          throw new Error(`${fieldName} entries must expose mount paths`);
        }
        for (const segment of segments) {
          if (
            typeof segment !== 'string' ||
            segment === '' ||
            segment === '.' ||
            segment === '..' ||
            segment.includes('/') ||
            segment.includes('\0')
          ) {
            throw new Error(
              `${fieldName} contains invalid mount path segment ${q(segment)}`,
            );
          }
        }
        return segments.length === 0 ? '.' : segments.join('/');
      }),
    );
  };

  const commitFromHead = async subjectFallback => {
    const { stdout } = await runGitRaw([
      'log',
      '-1',
      '--format=%H%x00%s',
      'HEAD',
    ]);
    const [oid, subject] = stdout.trim().split('\0');
    return harden({
      oid,
      subject: subject || subjectFallback,
    });
  };

  const help =
    'Local repository Git capability tied to one EndoMount worktree. ' +
    'Read operations include status, diff, log, show, revParse, branches, ' +
    'and stash inspection. Write operations include add, restore, commit, ' +
    'branch management, switch, merge, rebase, and stash workflows. ' +
    'Path-bearing write operations require EndoMountEntry values from the ' +
    'same worktree mount. Network operations are exposed by GitRemote.';

  return makeExo('EndoGit', GitInterface, {
    help: () => help,
    worktree: () => worktree,

    async status() {
      return runGit(['status', '--short', '--branch']);
    },

    async diff(options = {}) {
      const { staged = false, base, head, entries } = options;
      const command = ['diff', '--no-ext-diff', '--no-textconv'];
      if (staged) {
        command.push('--cached');
      }
      if (base !== undefined) {
        command.push(requireRevision(base, 'base'));
      }
      if (head !== undefined) {
        command.push(requireRevision(head, 'head'));
      }
      if (entries !== undefined) {
        command.push(
          '--',
          ...(await pathspecsFromEntries(entries, 'entries')),
        );
      }
      return runGit(command);
    },

    async log(options = {}) {
      const { maxCount = 20, ref } = options;
      if (!Number.isSafeInteger(maxCount) || maxCount <= 0) {
        throw new Error('maxCount must be a positive safe integer');
      }
      const command = [
        'log',
        '--oneline',
        '--decorate',
        `--max-count=${maxCount}`,
      ];
      if (ref !== undefined) {
        command.push(requireRevision(ref, 'ref'));
      }
      return runGit(command);
    },

    async show(ref) {
      return runGit([
        'show',
        '--no-ext-diff',
        '--no-textconv',
        '--stat',
        '--oneline',
        '--decorate',
        requireRevision(ref, 'ref'),
      ]);
    },

    async revParse(ref) {
      const name = requireRevision(ref, 'ref');
      const { stdout } = await runGitRaw(['rev-parse', '--verify', name]);
      const oid = stdout.trim();
      return makeCommitRef(name, oid);
    },

    async add(entries) {
      await assertNoExecutableRepoConfig();
      return runGit(['add', '--', ...(await pathspecsFromEntries(entries, 'entries'))]);
    },

    async restore(entries, options = {}) {
      const { staged = false } = options;
      await assertNoExecutableRepoConfig();
      const command = ['restore'];
      if (staged) {
        command.push('--staged');
      }
      command.push('--', ...(await pathspecsFromEntries(entries, 'entries')));
      return runGit(command);
    },

    async commit(message) {
      const subject = requireNonEmptyString(message, 'message');
      await runGit([
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        subject,
      ]);
      return commitFromHead(subject);
    },

    async currentBranch() {
      const { stdout } = await runGitRaw(['branch', '--show-current']);
      const name = stdout.trim();
      return name === '' ? undefined : makeBranchRef(name);
    },

    async branches(options = {}) {
      const { all = false } = options;
      const { stdout } = await runGitRaw([
        'branch',
        '--format=%(refname:short)',
        ...(all ? ['--all'] : []),
      ]);
      const output = stdout.trim();
      if (output === '(no output)') {
        return harden([]);
      }
      return harden(output.split('\n').filter(Boolean).map(makeBranchRef));
    },

    async createBranch(branch, options = {}) {
      const { startPoint, switchAfterCreate = false } = options;
      const name = await requireBranchName(branch, 'branch');
      if (switchAfterCreate) {
        await assertNoExecutableRepoConfig();
      }
      const command = switchAfterCreate
        ? ['switch', '-c', name]
        : ['branch', name];
      if (startPoint !== undefined) {
        command.push(requireRevision(startPoint, 'startPoint'));
      }
      await runGit(command);
      return makeBranchRef(name);
    },

    async deleteBranch(branch, options = {}) {
      const { force = false } = options;
      return runGit([
        'branch',
        force ? '-D' : '-d',
        await requireBranchName(branch, 'branch'),
      ]);
    },

    async renameBranch(branch, newName) {
      return runGit([
        'branch',
        '-m',
        await requireBranchName(branch, 'branch'),
        await requireBranchName(newName, 'newName'),
      ]);
    },

    async switch(ref, options = {}) {
      const { create = false, detach = false, startPoint } = options;
      if (create && detach) {
        throw new Error('switch cannot combine create and detach');
      }
      await assertNoExecutableRepoConfig();
      const command = ['switch'];
      if (create) {
        command.push('-c', await requireBranchName(ref, 'ref'));
      } else if (detach) {
        command.push('--detach', requireRevision(ref, 'ref'));
      } else {
        command.push(requireRevision(ref, 'ref'));
      }
      if (startPoint !== undefined) {
        if (!create) {
          throw new Error('startPoint is only valid when create is true');
        }
        command.push(requireRevision(startPoint, 'startPoint'));
      }
      return runGit(command);
    },

    async merge(ref, options = {}) {
      const { noFastForward = false } = options;
      await assertNoExecutableRepoConfig();
      return runGit([
        'merge',
        '--no-edit',
        '--no-verify',
        ...(noFastForward ? ['--no-ff'] : []),
        requireRevision(ref, 'ref'),
      ]);
    },

    async rebase(options) {
      const { mode, upstream, branch } = options;
      switch (mode) {
        case 'start': {
          await assertNoExecutableRepoConfig();
          const command = [
            'rebase',
            '--no-verify',
            requireRevision(upstream, 'upstream'),
          ];
          if (branch !== undefined) {
            command.push(requireRevision(branch, 'branch'));
          }
          return runGit(command);
        }
        case 'continue':
          await assertNoExecutableRepoConfig();
          return runGit(['rebase', '--continue']);
        case 'abort':
          await assertNoExecutableRepoConfig();
          return runGit(['rebase', '--abort']);
        case 'skip':
          await assertNoExecutableRepoConfig();
          return runGit(['rebase', '--skip']);
        default:
          throw new Error('mode must be one of: start, continue, abort, skip');
      }
    },

    async stashPush(options = {}) {
      const { message, includeUntracked = false, entries } = options;
      const command = ['stash', 'push'];
      await assertNoExecutableRepoConfig();
      if (includeUntracked) {
        command.push('--include-untracked');
      }
      if (message !== undefined) {
        command.push('-m', requireNonEmptyString(message, 'message'));
      }
      if (entries !== undefined) {
        command.push(
          '--',
          ...(await pathspecsFromEntries(entries, 'entries')),
        );
      }
      return runGit(command);
    },

    async stashList() {
      return runGit(['stash', 'list']);
    },

    async stashShow(stash = undefined) {
      const command = [
        'stash',
        'show',
        '--patch',
        '--no-ext-diff',
        '--no-textconv',
      ];
      if (stash !== undefined) {
        command.push(requireRevision(stash, 'stash'));
      }
      return runGit(command);
    },

    async stashApply(stash = undefined) {
      await assertNoExecutableRepoConfig();
      const command = ['stash', 'apply'];
      if (stash !== undefined) {
        command.push(requireRevision(stash, 'stash'));
      }
      return runGit(command);
    },

    async stashPop(stash = undefined) {
      await assertNoExecutableRepoConfig();
      const command = ['stash', 'pop'];
      if (stash !== undefined) {
        command.push(requireRevision(stash, 'stash'));
      }
      return runGit(command);
    },

    async stashDrop(stash = undefined) {
      const command = ['stash', 'drop'];
      if (stash !== undefined) {
        command.push(requireRevision(stash, 'stash'));
      }
      return runGit(command);
    },

    async tree(ref) {
      await getRepoRoot();
      const treeRef = requireRevision(ref, 'ref');
      throw new Error(
        `Git tree provider for ${q(treeRef)} is not implemented yet`,
      );
    },
  });
};
harden(makeGit);
