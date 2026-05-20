// @ts-check
/* global globalThis */

import { bytesToText } from '@endo/bytes/to-string.js';
import { q } from '@endo/errors';
import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { encodeHex } from '@endo/hex';

import {
  BlobInterface,
  GitCredentialControllerInterface,
  GitCredentialInterface,
  GitInterface,
  GitRemoteControllerInterface,
  GitRemoteInterface,
  GitTreeInterface,
} from './interfaces.js';
import { makeNativeGitBackend } from './native-git-backend.js';
import { makeReaderRef } from './reader-ref.js';

/** @import { EndoMount, EndoMountEntry, GitCredentialMetadata, GitCredentialUse, GitPowers, GitRemoteAuditRecord, GitRemotePolicy } from './types.js' */

const GIT_OUTPUT_LIMIT = 50_000;
const DEFAULT_REMOTE_PROTOCOLS = harden(['https']);
const CREDENTIAL_SECRET_FIELDS = harden([
  'token',
  'password',
  'secret',
  'privateKey',
  'passphrase',
]);

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
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
const sha256Bytes = async bytes => {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle === undefined) {
    throw new Error('SHA-256 digest support is not available');
  }
  return encodeHex(
    new Uint8Array(await subtle.digest('SHA-256', bytes.slice())),
  );
};
harden(sha256Bytes);

/**
 * @param {string} segment
 */
const assertGitPathSegment = segment => {
  if (
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\0')
  ) {
    throw new Error(`Invalid git tree path segment ${q(segment)}`);
  }
};
harden(assertGitPathSegment);

/**
 * @param {string | string[]} pathArg
 * @returns {string[]}
 */
const gitTreePathFromArg = pathArg => {
  const segments =
    typeof pathArg === 'string' ? pathArg.split('/') : [...pathArg];
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      throw new Error('Git tree path segments must be strings');
    }
    assertGitPathSegment(segment);
  }
  return segments;
};
harden(gitTreePathFromArg);

/**
 * @param {string[]} segments
 */
const gitTreeDisplayPath = segments =>
  segments.length === 0 ? '.' : segments.join('/');
harden(gitTreeDisplayPath);

/**
 * @param {string} output
 * @returns {Array<{ mode: string, type: string, oid: string, name: string }>}
 */
const parseLsTree = output => {
  const entries = [];
  for (const record of output.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new Error(`Unexpected git ls-tree record ${q(record)}`);
    }
    const fields = record.slice(0, tab).split(' ');
    if (fields.length !== 3) {
      throw new Error(`Unexpected git ls-tree metadata ${q(record)}`);
    }
    const [mode, type, oid] = fields;
    entries.push(harden({ mode, type, oid, name: record.slice(tab + 1) }));
  }
  return harden(entries);
};
harden(parseLsTree);

/**
 * @param {string} code
 * @returns {'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted'}
 */
const gitIndexStatus = code => {
  switch (code) {
    case '.':
      return 'clean';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflicted';
    case 'M':
    case 'T':
      return 'modified';
    default:
      throw new Error(`Unsupported git index status ${q(code)}`);
  }
};
harden(gitIndexStatus);

/**
 * @param {string} code
 * @returns {'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted'}
 */
const gitWorktreeStatus = code => {
  switch (code) {
    case '.':
      return 'clean';
    case '?':
      return 'untracked';
    case '!':
      return 'ignored';
    case 'D':
      return 'deleted';
    case 'U':
      return 'conflicted';
    case 'M':
    case 'A':
    case 'R':
    case 'C':
    case 'T':
      return 'modified';
    default:
      throw new Error(`Unsupported git worktree status ${q(code)}`);
  }
};
harden(gitWorktreeStatus);

/**
 * @param {string} record
 * @param {number} fieldsBeforePath
 */
const pathFromStatusRecord = (record, fieldsBeforePath) => {
  let spaces = 0;
  for (let i = 0; i < record.length; i += 1) {
    if (record[i] === ' ') {
      spaces += 1;
      if (spaces === fieldsBeforePath) {
        if (i === record.length - 1) {
          throw new Error(`Unexpected git status record ${q(record)}`);
        }
        return record.slice(i + 1);
      }
    }
  }
  throw new Error(`Unexpected git status record ${q(record)}`);
};
harden(pathFromStatusRecord);

/**
 * @param {string} record
 */
const statusPathFromRecord = record => {
  switch (record[0]) {
    case '1':
      return pathFromStatusRecord(record, 8);
    case '2':
      return pathFromStatusRecord(record, 9);
    case 'u':
      return pathFromStatusRecord(record, 10);
    default:
      throw new Error(`Unexpected git status record ${q(record)}`);
  }
};
harden(statusPathFromRecord);

/**
 * @param {string} output
 * @returns {Array<{
 *   path: string,
 *   index: 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted',
 *   worktree: 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted',
 *   renamedFrom?: string,
 * }>}
 */
const parseStatusPorcelainV2 = output => {
  const records = output.split('\0');
  /** @type {Array<{
   *   path: string,
   *   index: 'clean' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted',
   *   worktree: 'clean' | 'modified' | 'deleted' | 'untracked' | 'ignored' | 'conflicted',
   *   renamedFrom?: string,
   * }>} */
  const entries = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === '' || record.startsWith('# ')) {
      // skip
    } else if (record[0] === '?' || record[0] === '!') {
      const tag = record[0];
      const path = record.slice(2);
      entries.push(
        harden({
          path,
          index: 'clean',
          worktree: tag === '?' ? 'untracked' : 'ignored',
        }),
      );
    } else if (record[0] === '1' || record[0] === '2' || record[0] === 'u') {
      const tag = record[0];
      const xy = record.slice(2, 4);
      const path = statusPathFromRecord(record);
      const entry = {
        path,
        index: tag === 'u' ? 'conflicted' : gitIndexStatus(xy[0]),
        worktree: tag === 'u' ? 'conflicted' : gitWorktreeStatus(xy[1]),
      };
      if (tag === '2') {
        i += 1;
        if (i >= records.length) {
          throw new Error(`Missing rename source for git status record ${q(record)}`);
        }
        Object.assign(entry, { renamedFrom: records[i] });
      }
      entries.push(harden(entry));
    } else {
      throw new Error(`Unexpected git status record ${q(record)}`);
    }
  }
  return harden(entries);
};
harden(parseStatusPorcelainV2);

/**
 * @param {object} args
 * @param {EndoMount} args.worktree
 * @param {string} args.repoRoot
 * @param {GitPowers} args.gitPowers
 * @param {boolean} [args.readOnly]
 * @param {(tree: object, archiveTar: () => Promise<unknown>) => void} [args.registerArchiveTree]
 * @returns {object}
 */
export const makeGit = ({
  worktree,
  repoRoot,
  gitPowers,
  readOnly = false,
  registerArchiveTree = undefined,
}) => {
  const backend = makeNativeGitBackend({ repoRoot, gitPowers });

  const assertWritable = () => {
    if (readOnly) {
      throw new Error('Git capability is read-only');
    }
  };

  const {
    runGitRaw,
    runGitBytesRaw,
    runGitReaderRaw,
    runGit,
    assertNoExecutableRepoConfig,
  } = backend;


  /**
   * @param {unknown} branchName
   * @param {string} fieldName
   */
  const requireBranchName = async (branchName, fieldName) => {
    const name = requireRevision(branchName, fieldName);
    return backend.checkBranchName(name);
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
        const segments = await E(entry).segments();
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

  /**
   * @param {string} statusPath
   */
  const entryFromGitPath = statusPath => {
    const segments = statusPath === '' ? [] : statusPath.split('/');
    return E(worktree).entry(harden(segments));
  };

  const statusEntries = async () => {
    const { stdout } = await runGitRaw([
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--ignored=matching',
    ]);
    return Promise.all(
      parseStatusPorcelainV2(stdout).map(async rawEntry => {
        const entry = await entryFromGitPath(rawEntry.path);
        const liveNode = (await E(entry).exists())
          ? await E(worktree).lookup(entry).catch(() => undefined)
          : undefined;
        return harden({
          ...rawEntry,
          entry,
          ...(liveNode !== undefined && { node: liveNode }),
        });
      }),
    );
  };

  /** @type {Map<string, Promise<Array<{
   *   mode: string,
   *   type: string,
   *   oid: string,
   *   name: string,
   * }>>>} */
  const treeEntriesByOid = new Map();

  /**
   * @param {string} treeOid
   */
  const getTreeEntries = treeOid => {
    let entriesP = treeEntriesByOid.get(treeOid);
    if (entriesP === undefined) {
      entriesP = runGitRaw(['ls-tree', '-z', treeOid]).then(({ stdout }) =>
        parseLsTree(stdout),
      );
      treeEntriesByOid.set(treeOid, entriesP);
    }
    return entriesP;
  };

  /**
   * @param {string} treeOid
   * @param {string} name
   */
  const getTreeEntry = async (treeOid, name) => {
    const entries = await getTreeEntries(treeOid);
    return entries.find(entry => entry.name === name);
  };

  /**
   * @param {string} treeOid
   * @param {string[]} segments
   */
  const resolveTreeOid = async (treeOid, segments) => {
    let currentTreeOid = treeOid;
    for (const segment of segments) {
      // eslint-disable-next-line no-await-in-loop -- each segment depends on the previously resolved tree.
      const entry = await getTreeEntry(currentTreeOid, segment);
      if (entry === undefined) {
        throw new TypeError(`Unknown name: ${JSON.stringify(segment)}`);
      }
      if (entry.type !== 'tree') {
        throw new TypeError(
          `Git tree entry ${JSON.stringify(segment)} is not a tree`,
        );
      }
      currentTreeOid = entry.oid;
    }
    return currentTreeOid;
  };

  /**
   * @param {string} oid
   * @param {string[]} displaySegments
   */
  const makeGitBlob = async (oid, displaySegments) => {
    const { stdout: bytes } = await runGitBytesRaw(['cat-file', 'blob', oid]);
    const sha256 = await sha256Bytes(bytes);
    const displayPath = gitTreeDisplayPath(displaySegments);
    return makeExo('EndoGitBlob', BlobInterface, {
      help: () => `Immutable git blob ${oid} at ${displayPath}`,
      sha256: () => sha256,
      streamBase64: () => makeReaderRef([bytes]),
      text: async () => bytesToText(bytes),
      json: async () => JSON.parse(bytesToText(bytes)),
    });
  };

  /**
   * @param {string} treeOid
   * @param {string[]} displaySegments
   */
  const makeGitTree = async (treeOid, displaySegments) => {
    const { stdout: bytes } = await runGitBytesRaw([
      'cat-file',
      'tree',
      treeOid,
    ]);
    const sha256 = await sha256Bytes(bytes);
    const displayPath = gitTreeDisplayPath(displaySegments);
    const help = () => `Immutable git tree ${treeOid} at ${displayPath}`;
    const archiveTar = async () => {
      const tarReader = await runGitReaderRaw([
        'archive',
        '--format=tar',
        treeOid,
      ]);
      return makeReaderRef(tarReader);
    };
    const tree = makeExo('EndoGitTree', GitTreeInterface, {
      help,
      sha256: () => sha256,
      archiveTar,

      async has(...pathSegments) {
        for (const segment of pathSegments) {
          assertGitPathSegment(segment);
        }
        if (pathSegments.length === 0) {
          return true;
        }
        try {
          const [leaf, ...parentsReversed] = [...pathSegments].reverse();
          const parentSegments = parentsReversed.reverse();
          const parentTreeOid = await resolveTreeOid(treeOid, parentSegments);
          return (await getTreeEntry(parentTreeOid, leaf)) !== undefined;
        } catch {
          return false;
        }
      },

      async list(...pathSegments) {
        for (const segment of pathSegments) {
          assertGitPathSegment(segment);
        }
        const targetTreeOid = await resolveTreeOid(treeOid, pathSegments);
        const entries = await getTreeEntries(targetTreeOid);
        return harden(entries.map(({ name }) => name));
      },

      async lookup(pathArg) {
        const segments = gitTreePathFromArg(pathArg);
        if (segments.length === 0) {
          throw new TypeError('Unknown name: undefined');
        }
        const [leaf, ...parentsReversed] = [...segments].reverse();
        const parentSegments = parentsReversed.reverse();
        const parentTreeOid = await resolveTreeOid(treeOid, parentSegments);
        const entry = await getTreeEntry(parentTreeOid, leaf);
        if (entry === undefined) {
          throw new TypeError(`Unknown name: ${JSON.stringify(leaf)}`);
        }
        const childDisplaySegments = [...displaySegments, ...segments];
        if (entry.type === 'tree') {
          return makeGitTree(entry.oid, childDisplaySegments);
        }
        if (entry.type === 'blob') {
          return makeGitBlob(entry.oid, childDisplaySegments);
        }
        throw new TypeError(
          `Git tree entry ${JSON.stringify(leaf)} has unsupported type ${q(
            entry.type,
          )}`,
        );
      },
    });
    registerArchiveTree?.(tree, archiveTar);
    return tree;
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
      return harden(await statusEntries());
    },

    async statusText() {
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
      if (
        typeof maxCount !== 'number' ||
        !Number.isSafeInteger(maxCount) ||
        maxCount <= 0
      ) {
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
      assertWritable();
      await assertNoExecutableRepoConfig();
      return runGit(['add', '--', ...(await pathspecsFromEntries(entries, 'entries'))]);
    },

    async restore(entries, options = {}) {
      assertWritable();
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
      assertWritable();
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
      assertWritable();
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
      assertWritable();
      const { force = false } = options;
      return runGit([
        'branch',
        force ? '-D' : '-d',
        await requireBranchName(branch, 'branch'),
      ]);
    },

    async renameBranch(branch, newName) {
      assertWritable();
      return runGit([
        'branch',
        '-m',
        await requireBranchName(branch, 'branch'),
        await requireBranchName(newName, 'newName'),
      ]);
    },

    async switch(ref, options = {}) {
      assertWritable();
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
      assertWritable();
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
      assertWritable();
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
      assertWritable();
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
      assertWritable();
      await assertNoExecutableRepoConfig();
      const command = ['stash', 'apply'];
      if (stash !== undefined) {
        command.push(requireRevision(stash, 'stash'));
      }
      return runGit(command);
    },

    async stashPop(stash = undefined) {
      assertWritable();
      await assertNoExecutableRepoConfig();
      const command = ['stash', 'pop'];
      if (stash !== undefined) {
        command.push(requireRevision(stash, 'stash'));
      }
      return runGit(command);
    },

    async stashDrop(stash = undefined) {
      assertWritable();
      const command = ['stash', 'drop'];
      if (stash !== undefined) {
        command.push(requireRevision(stash, 'stash'));
      }
      return runGit(command);
    },

    async tree(ref) {
      const treeRef = requireRevision(ref, 'ref');
      const { stdout } = await runGitRaw([
        'rev-parse',
        '--verify',
        `${treeRef}^{tree}`,
      ]);
      return makeGitTree(stdout.trim(), []);
    },

    async readOnly() {
      const readOnlyWorktree = await E(worktree).readOnly();
      return makeGit({
        worktree: readOnlyWorktree,
        repoRoot,
        gitPowers,
        readOnly: true,
        registerArchiveTree,
      });
    },
  });
};
harden(makeGit);

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
const requireRemoteToken = (value, name) => {
  const token = requireNonEmptyString(value, name);
  if (token.startsWith('-')) {
    throw new Error(`${name} must not start with "-"`);
  }
  return token;
};
harden(requireRemoteToken);

/**
 * @param {string} ref
 * @param {string} allowed
 */
const refMatchesPolicy = (ref, allowed) => {
  const target = ref.startsWith('+') ? ref.slice(1) : ref;
  if (allowed.endsWith('*')) {
    return target.startsWith(allowed.slice(0, -1));
  }
  if (allowed.endsWith('/')) {
    return target.startsWith(allowed);
  }
  return target === allowed;
};
harden(refMatchesPolicy);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
const remoteProtocolsFromPolicy = value => {
  if (value === undefined) {
    return DEFAULT_REMOTE_PROTOCOLS;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('allowedProtocols must be a non-empty array');
  }
  return harden(
    value.map(protocol => {
      const name = requireRemoteToken(protocol, 'allowedProtocols entry');
      if (!/^[a-z][a-z0-9+.-]*$/u.test(name)) {
        throw new Error(`Invalid remote protocol ${q(name)}`);
      }
      return name;
    }),
  );
};
harden(remoteProtocolsFromPolicy);

/**
 * @param {string} remoteUrl
 * @returns {string}
 */
const remoteProtocolForUrl = remoteUrl => {
  if (/^[^@/\s]+@[^:\s]+:.+/u.test(remoteUrl)) {
    return 'ssh';
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(remoteUrl)) {
    return new URL(remoteUrl).protocol.slice(0, -1);
  }
  return 'file';
};
harden(remoteProtocolForUrl);

/**
 * @param {string} remoteUrl
 * @param {string[]} allowedProtocols
 */
const assertAllowedRemoteUrl = (remoteUrl, allowedProtocols) => {
  const protocol = remoteProtocolForUrl(remoteUrl);
  if (!allowedProtocols.includes(protocol)) {
    throw new Error(
      `Git remote protocol ${q(protocol)} is not allowed; allowed protocols: ${allowedProtocols.join(', ')}`,
    );
  }
  return protocol;
};
harden(assertAllowedRemoteUrl);

/**
 * @param {string} ref
 */
const isTagRef = ref =>
  ref.startsWith('refs/tags/') || ref.startsWith('tags/');
harden(isTagRef);

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
const requireRemoteRef = (value, fieldName) => {
  const ref = requireRevision(value, fieldName);
  if (ref.startsWith('+') || ref.includes(':')) {
    throw new Error(`${fieldName} must be a single ref, not a refspec`);
  }
  return ref;
};
harden(requireRemoteRef);

/**
 * @param {unknown} value
 */
const validateCredentialPolicy = value => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('credential must be a record');
  }
  const credential = /** @type {Record<string, unknown>} */ (value);
  for (const field of CREDENTIAL_SECRET_FIELDS) {
    if (field in credential) {
      throw new Error(
        `Git remote credential policy must not contain secret field ${q(field)}`,
      );
    }
  }
  const type = requireRemoteToken(credential.type, 'credential.type');
  const sanitized = {
    type,
    ...(credential.label !== undefined && {
      label: requireRemoteToken(credential.label, 'credential.label'),
    }),
    ...(credential.audience !== undefined && {
      audience: requireRemoteToken(credential.audience, 'credential.audience'),
    }),
  };
  return harden(sanitized);
};
harden(validateCredentialPolicy);

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {Array<'fetch' | 'pull' | 'push'>}
 */
const remoteDirectionsFrom = (value, fieldName) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  return harden(
    value.map(direction => {
      const text = requireRemoteToken(direction, `${fieldName} entry`);
      if (!['fetch', 'pull', 'push'].includes(text)) {
        throw new Error(`Unsupported git remote direction ${text}`);
      }
      return /** @type {'fetch' | 'pull' | 'push'} */ (text);
    }),
  );
};
harden(remoteDirectionsFrom);

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string[] | undefined}
 */
const remoteRefsFrom = (value, fieldName) => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return harden(
    value.map(ref => requireRemoteToken(ref, `${fieldName} entry`)),
  );
};
harden(remoteRefsFrom);

/**
 * @param {unknown} value
 */
const remoteAllowedProtocolsFrom = value =>
  value === undefined ? undefined : remoteProtocolsFromPolicy(value);
harden(remoteAllowedProtocolsFrom);

/**
 * @param {GitRemotePolicy} base
 * @param {Partial<GitRemotePolicy>} overlay
 * @returns {GitRemotePolicy}
 */
const mergeRemotePolicy = (base, overlay = {}) => {
  const allowedProtocols = remoteAllowedProtocolsFrom(
    overlay.allowedProtocols ?? base.allowedProtocols,
  );
  return harden({
    ...base,
    ...overlay,
    remote: requireRemoteToken(overlay.remote ?? base.remote, 'remote'),
    directions: remoteDirectionsFrom(
      overlay.directions ?? base.directions,
      'directions',
    ),
    allowedRefs: remoteRefsFrom(
      overlay.allowedRefs ?? base.allowedRefs,
      'allowedRefs',
    ),
    ...(allowedProtocols !== undefined && { allowedProtocols }),
    credential: validateCredentialPolicy(overlay.credential ?? base.credential),
  });
};
harden(mergeRemotePolicy);

/**
 * @typedef {{
 *   read: () => Promise<{
 *     revoked: boolean,
 *     policy: Partial<GitRemotePolicy>,
 *     audit: GitRemoteAuditRecord[],
 *   }>,
 *   updatePolicy: (policy: Partial<GitRemotePolicy>) => Promise<void>,
 *   revoke: () => Promise<void>,
 *   appendAudit: (record: GitRemoteAuditRecord) => Promise<void>,
 *   getCredentialUse: (id: string) => Promise<GitCredentialUse>,
 *   getCredentialMetadata: (id: string) => Promise<GitCredentialMetadata>,
 * }} GitRemoteState
 */

/**
 * @param {string} remoteUrl
 * @param {GitCredentialUse} credential
 */
const assertCredentialAudience = (remoteUrl, credential) => {
  const audience = credential.audience;
  if (audience === '') {
    throw new Error('Git credential audience is required');
  }
  let remoteOrigin;
  try {
    remoteOrigin = new URL(remoteUrl).origin;
  } catch {
    throw new Error('Git credentials can only be used with URL remotes');
  }
  if (audience !== remoteOrigin && !remoteUrl.startsWith(audience)) {
    throw new Error(
      `Git credential audience ${q(audience)} does not match remote ${q(remoteUrl)}`,
    );
  }
};
harden(assertCredentialAudience);

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {GitPowers} args.gitPowers
 * @param {GitRemotePolicy} args.policy
 * @param {GitRemoteState} [args.state]
 * @returns {object}
 */
export const makeGitRemote = ({ repoRoot, gitPowers, policy, state }) => {
  /** @type {Promise<string> | undefined} */
  let verifiedRepoRoot;
  const basePolicy = mergeRemotePolicy(policy, {});

  const getRepoRoot = () => {
    if (verifiedRepoRoot === undefined) {
      verifiedRepoRoot = gitPowers.getRepositoryRoot(repoRoot);
    }
    return verifiedRepoRoot;
  };

  const readRemoteState = async () =>
    state === undefined
      ? harden({ revoked: false, policy: harden({}), audit: harden([]) })
      : state.read();

  const effectivePolicy = async () => {
    const remoteState = await readRemoteState();
    return harden({
      policy: mergeRemotePolicy(basePolicy, remoteState.policy),
      revoked: remoteState.revoked,
    });
  };

  /**
   * @param {string[]} args
   * @param {GitCredentialUse | undefined} credentialUse
   */
  const runGitRaw = async (args, credentialUse = undefined) => {
    const root = await getRepoRoot();
    try {
      return credentialUse === undefined
        ? await gitPowers.runGit(root, args)
        : await gitPowers.runGitCredentialed(root, args, credentialUse);
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
   * @param {GitCredentialUse | undefined} credentialUse
   */
  const runGit = async (args, credentialUse = undefined) => {
    const { stdout, stderr } = await runGitRaw(args, credentialUse);
    const output = `${stdout}${stderr ? `\n[stderr]:\n${stderr}` : ''}`;
    return truncateOutput(output.trim() || '(no output)');
  };

  /**
   * @param {GitRemotePolicy} currentPolicy
   * @param {boolean} revoked
   * @param {'fetch' | 'pull' | 'push'} direction
   */
  const assertAllowed = (currentPolicy, revoked, direction) => {
    if (revoked) {
      throw new Error('Git remote has been revoked');
    }
    if (!new Set(currentPolicy.directions).has(direction)) {
      throw new Error(`Git remote does not allow ${direction}`);
    }
  };

  /**
   * @param {GitRemotePolicy} currentPolicy
   * @param {string} ref
   */
  const assertAllowedRef = (currentPolicy, ref) => {
    const { allowedRefs } = currentPolicy;
    if (
      allowedRefs !== undefined &&
      !allowedRefs.some(allowed => refMatchesPolicy(ref, allowed))
    ) {
      throw new Error(`Git remote policy does not allow ref ${q(ref)}`);
    }
  };

  /**
   * @param {GitRemotePolicy} currentPolicy
   * @param {unknown} value
   * @param {string} fieldName
   */
  const pushRefFrom = (currentPolicy, value, fieldName) => {
    const ref = requireRemoteRef(value, fieldName);
    if (!currentPolicy.allowTags && isTagRef(ref)) {
      throw new Error('Git remote does not allow tag push');
    }
    assertAllowedRef(currentPolicy, ref);
    return ref;
  };

  /**
   * @param {GitRemotePolicy} currentPolicy
   */
  const remoteTarget = async currentPolicy => {
    const expectedUrl =
      currentPolicy.url === undefined
        ? undefined
        : requireRemoteToken(currentPolicy.url, 'url');
    const allowedProtocols = remoteProtocolsFromPolicy(
      currentPolicy.allowedProtocols,
    );
    if (expectedUrl !== undefined) {
      assertAllowedRemoteUrl(expectedUrl, allowedProtocols);
      return harden({ target: expectedUrl, url: expectedUrl });
    }
    const remoteName = requireRemoteToken(currentPolicy.remote, 'remote');
    const { stdout } = await runGitRaw(['remote', 'get-url', remoteName]);
    const configured = stdout.trim();
    assertAllowedRemoteUrl(configured, allowedProtocols);
    return harden({ target: remoteName, url: configured });
  };

  /**
   * @param {GitRemotePolicy} currentPolicy
   * @param {string} remoteUrl
   */
  const credentialUseFor = async (currentPolicy, remoteUrl) => {
    if (currentPolicy.credentialId === undefined || state === undefined) {
      return undefined;
    }
    const credentialUse = await state.getCredentialUse(
      currentPolicy.credentialId,
    );
    assertCredentialAudience(remoteUrl, credentialUse);
    return credentialUse;
  };

  /**
   * @param {GitRemotePolicy} currentPolicy
   * @param {'fetch' | 'pull' | 'push'} operation
   * @param {string[]} refs
   * @param {string} output
   * @param {GitCredentialUse | undefined} credentialUse
   */
  const summarizeOperation = async (
    currentPolicy,
    operation,
    refs,
    output,
    credentialUse = undefined,
  ) => {
    const summary = harden({
      operation,
      status: 'completed',
      remote: currentPolicy.remote,
      refs: harden(refs),
      diagnostics: harden({ output }),
      output,
    });
    await state?.appendAudit(
      harden({
        timestamp: new Date().toISOString(),
        operation,
        status: 'completed',
        remote: currentPolicy.remote,
        refs: harden(refs),
        ...(credentialUse?.label !== undefined && {
          credentialLabel: credentialUse.label,
        }),
      }),
    );
    return summary;
  };

  const help =
    'Bounded Git remote capability for one local Git worktree. ' +
    'Operations are limited by direction policy and optional ref policy. ' +
    'Credentials are not exposed through this interface.';

  return makeExo('EndoGitRemote', GitRemoteInterface, {
    help: () => help,

    async inspect() {
      const { policy: currentPolicy, revoked } = await effectivePolicy();
      const allowedProtocols = remoteProtocolsFromPolicy(
        currentPolicy.allowedProtocols,
      );
      const credential =
        currentPolicy.credentialId !== undefined && state !== undefined
          ? await state.getCredentialMetadata(currentPolicy.credentialId)
          : validateCredentialPolicy(currentPolicy.credential);
      return harden({
        ...currentPolicy,
        directions: harden([...currentPolicy.directions]),
        allowedProtocols,
        ...(credential !== undefined && { credential }),
        revoked,
      });
    },

    async fetch(options = {}) {
      const { policy: currentPolicy, revoked } = await effectivePolicy();
      assertAllowed(currentPolicy, revoked, 'fetch');
      const { target: gitTarget, url } = await remoteTarget(currentPolicy);
      const credentialUse = await credentialUseFor(currentPolicy, url);
      const { refspecs = [], prune = false } = options;
      for (const refspec of refspecs) {
        assertAllowedRef(currentPolicy, refspec);
      }
      const output = await runGit(
        ['fetch', ...(prune ? ['--prune'] : []), gitTarget, ...refspecs],
        credentialUse,
      );
      return summarizeOperation(
        currentPolicy,
        'fetch',
        refspecs,
        output,
        credentialUse,
      );
    },

    async pull(options = {}) {
      const { policy: currentPolicy, revoked } = await effectivePolicy();
      assertAllowed(currentPolicy, revoked, 'pull');
      const { target: gitTarget, url } = await remoteTarget(currentPolicy);
      const credentialUse = await credentialUseFor(currentPolicy, url);
      const { branch } = options;
      const command = ['pull', '--ff-only', gitTarget];
      if (branch !== undefined) {
        assertAllowedRef(currentPolicy, branch);
        command.push(branch);
      }
      const refs = branch === undefined ? [] : [branch];
      const output = await runGit(command, credentialUse);
      return summarizeOperation(
        currentPolicy,
        'pull',
        refs,
        output,
        credentialUse,
      );
    },

    async push(options = {}) {
      const { policy: currentPolicy, revoked } = await effectivePolicy();
      assertAllowed(currentPolicy, revoked, 'push');
      const { target: gitTarget, url } = await remoteTarget(currentPolicy);
      const credentialUse = await credentialUseFor(currentPolicy, url);
      const {
        source = 'HEAD',
        target: pushTarget = undefined,
        forceWithLease = false,
      } = options;
      if (forceWithLease && !currentPolicy.allowForcePush) {
        throw new Error('Git remote does not allow force push');
      }
      if (!currentPolicy.allowDelete && source === '') {
        throw new Error('Git remote does not allow deleting refs');
      }
      const sourceRef = pushRefFrom(currentPolicy, source, 'source');
      const targetRef =
        pushTarget === undefined
          ? undefined
          : pushRefFrom(currentPolicy, pushTarget, 'target');
      const refspec =
        targetRef === undefined ? sourceRef : `${sourceRef}:${targetRef}`;
      const output = await runGit(
        [
          'push',
          ...(forceWithLease ? ['--force-with-lease'] : []),
          gitTarget,
          refspec,
        ],
        credentialUse,
      );
      return summarizeOperation(
        currentPolicy,
        'push',
        [refspec],
        output,
        credentialUse,
      );
    },
  });
};
harden(makeGitRemote);

/**
 * @param {object} args
 * @param {GitCredentialMetadata} args.metadata
 * @param {() => Promise<{ revoked: boolean }>} args.readState
 */
export const makeGitCredential = ({ metadata, readState }) => {
  const help =
    'Non-extractable Git credential capability. It exposes only metadata; ' +
    'trusted daemon code can use the sealed credential for approved remotes.';
  return makeExo('EndoGitCredential', GitCredentialInterface, {
    help: () => help,
    audience: () => metadata.audience,
    async inspect() {
      const { revoked } = await readState();
      return harden({ ...metadata, revoked });
    },
  });
};
harden(makeGitCredential);

/**
 * @param {object} args
 * @param {GitRemotePolicy} args.basePolicy
 * @param {GitRemoteState} args.state
 */
export const makeGitRemoteController = ({ basePolicy, state }) => {
  const help =
    'Host-held controller for one GitRemote. It can update policy and revoke ' +
    'the remote without exposing credential material.';
  const inspect = async () => {
    const remoteState = await state.read();
    return harden({
      ...mergeRemotePolicy(basePolicy, remoteState.policy),
      revoked: remoteState.revoked,
    });
  };
  return makeExo(
    'EndoGitRemoteController',
    GitRemoteControllerInterface,
    {
      help: () => help,
      inspect,
      async setAllowedDirections(directions) {
        await state.updatePolicy({
          directions: remoteDirectionsFrom(directions, 'directions'),
        });
      },
      async setAllowedRefs(refs) {
        await state.updatePolicy({
          allowedRefs: remoteRefsFrom(refs, 'allowedRefs'),
        });
      },
      async setAllowForcePush(flag) {
        await state.updatePolicy({ allowForcePush: flag === true });
      },
      async setAllowTags(flag) {
        await state.updatePolicy({ allowTags: flag === true });
      },
      async setAllowDelete(flag) {
        await state.updatePolicy({ allowDelete: flag === true });
      },
      async revoke() {
        await state.revoke();
      },
      async audit() {
        const remoteState = await state.read();
        return harden([...remoteState.audit]);
      },
    },
  );
};
harden(makeGitRemoteController);

/**
 * @param {object} args
 * @param {GitCredentialMetadata} args.metadata
 * @param {() => Promise<{ revoked: boolean }>} args.readState
 * @param {(secret: unknown) => Promise<void>} args.rotate
 * @param {() => Promise<void>} args.revoke
 */
export const makeGitCredentialController = ({
  metadata,
  readState,
  rotate,
  revoke,
}) => {
  const help =
    'Host-held controller for one non-extractable Git credential. It can ' +
    'rotate or revoke the sealed secret.';
  return makeExo(
    'EndoGitCredentialController',
    GitCredentialControllerInterface,
    {
      help: () => help,
      async inspect() {
        const { revoked } = await readState();
        return harden({ ...metadata, revoked });
      },
      rotate,
      revoke,
    },
  );
};
harden(makeGitCredentialController);
