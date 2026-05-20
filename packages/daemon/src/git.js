// @ts-check
/* global globalThis */

import { bytesToText } from '@endo/bytes/to-string.js';
import { q } from '@endo/errors';
import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { encodeHex } from '@endo/hex';

import {
  BlobInterface,
  GitInterface,
  GitRemoteInterface,
  GitTreeInterface,
} from './interfaces.js';
import { makeReaderRef } from './reader-ref.js';

/** @import { EndoMount, EndoMountEntry, GitPowers, GitRemotePolicy } from './types.js' */

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
 * @param {Error & {
 *   stdout?: string | Uint8Array,
 *   stderr?: string | Uint8Array,
 *   code?: number,
 * }} err
 * @returns {string}
 */
const gitErrorDetail = err => {
  const detail = err.stderr || err.stdout || err.message || 'unknown error';
  return typeof detail === 'string' ? detail : bytesToText(detail);
};
harden(gitErrorDetail);

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
      const detail = truncateOutput(gitErrorDetail(err).trim());
      throw new Error(
        `git ${args[0]} failed (exit ${err.code ?? 'unknown'}):\n${detail}`,
      );
    }
  };

  /**
   * @param {string[]} args
   * @returns {Promise<{ stdout: Uint8Array, stderr: string }>}
   */
  const runGitBytesRaw = async args => {
    const root = await getRepoRoot();
    try {
      return await gitPowers.runGitBytes(root, args);
    } catch (error) {
      const err =
        /** @type {Error & { stdout?: Uint8Array, stderr?: string, code?: number }} */ (
          error
        );
      const detail = truncateOutput(gitErrorDetail(err).trim());
      throw new Error(
        `git ${args[0]} failed (exit ${err.code ?? 'unknown'}):\n${detail}`,
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
    return makeExo('EndoGitTree', GitTreeInterface, {
      help,
      sha256: () => sha256,
      async archiveTar() {
        const { stdout: tarBytes } = await runGitBytesRaw([
          'archive',
          '--format=tar',
          treeOid,
        ]);
        return makeReaderRef([tarBytes]);
      },

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
      const treeRef = requireRevision(ref, 'ref');
      const { stdout } = await runGitRaw([
        'rev-parse',
        '--verify',
        `${treeRef}^{tree}`,
      ]);
      return makeGitTree(stdout.trim(), []);
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
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {GitPowers} args.gitPowers
 * @param {GitRemotePolicy} args.policy
 * @returns {object}
 */
export const makeGitRemote = ({ repoRoot, gitPowers, policy }) => {
  /** @type {Promise<string> | undefined} */
  let verifiedRepoRoot;
  const remoteName = requireRemoteToken(policy.remote, 'remote');
  const directions = new Set(policy.directions);
  const allowedRefs = policy.allowedRefs || undefined;
  const allowForcePush = policy.allowForcePush === true;
  const allowedProtocols = remoteProtocolsFromPolicy(policy.allowedProtocols);
  const credential = validateCredentialPolicy(policy.credential);
  const revoked = false;

  const getRepoRoot = () => {
    if (verifiedRepoRoot === undefined) {
      verifiedRepoRoot = gitPowers.getRepositoryRoot(repoRoot);
    }
    return verifiedRepoRoot;
  };

  /**
   * @param {string[]} args
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
   */
  const runGit = async args => {
    const { stdout, stderr } = await runGitRaw(args);
    const output = `${stdout}${stderr ? `\n[stderr]:\n${stderr}` : ''}`;
    return truncateOutput(output.trim() || '(no output)');
  };

  /**
   * @param {'fetch' | 'pull' | 'push'} direction
   */
  const assertAllowed = direction => {
    if (revoked) {
      throw new Error('Git remote has been revoked');
    }
    if (!directions.has(direction)) {
      throw new Error(`Git remote does not allow ${direction}`);
    }
  };

  /**
   * @param {string} ref
   */
  const assertAllowedRef = ref => {
    requireRevision(ref, 'ref');
    if (
      allowedRefs !== undefined &&
      !allowedRefs.some(allowed => refMatchesPolicy(ref, allowed))
    ) {
      throw new Error(`Git remote policy does not allow ref ${q(ref)}`);
    }
  };

  const ensureConfiguredEndpoint = async () => {
    const expectedUrl =
      policy.url === undefined ? undefined : requireRemoteToken(policy.url, 'url');
    if (expectedUrl !== undefined) {
      assertAllowedRemoteUrl(expectedUrl, allowedProtocols);
    }
    try {
      const { stdout } = await runGitRaw(['remote', 'get-url', remoteName]);
      const configured = stdout.trim();
      assertAllowedRemoteUrl(configured, allowedProtocols);
      if (expectedUrl !== undefined && configured !== expectedUrl) {
        throw new Error(
          `Git remote ${q(remoteName)} is configured for ${q(configured)}, not ${q(expectedUrl)}`,
        );
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!message.includes('No such remote') || expectedUrl === undefined) {
        throw error;
      }
      await runGit(['remote', 'add', remoteName, expectedUrl]);
    }
  };

  const help =
    'Bounded Git remote capability for one local Git worktree. ' +
    'Operations are limited by direction policy and optional ref policy. ' +
    'Credentials are not exposed through this interface.';

  return makeExo('EndoGitRemote', GitRemoteInterface, {
    help: () => help,

    async inspect() {
      await null;
      return harden({
        ...policy,
        directions: harden([...directions]),
        allowedProtocols,
        ...(credential !== undefined && { credential }),
        revoked,
      });
    },

    async fetch(options = {}) {
      assertAllowed('fetch');
      await ensureConfiguredEndpoint();
      const { refspecs = [], prune = false } = options;
      for (const refspec of refspecs) {
        assertAllowedRef(refspec);
      }
      return harden({
        output: await runGit([
          'fetch',
          ...(prune ? ['--prune'] : []),
          remoteName,
          ...refspecs,
        ]),
      });
    },

    async pull(options = {}) {
      assertAllowed('pull');
      await ensureConfiguredEndpoint();
      const { branch } = options;
      const command = ['pull', '--ff-only', remoteName];
      if (branch !== undefined) {
        assertAllowedRef(branch);
        command.push(branch);
      }
      return harden({ output: await runGit(command) });
    },

    async push(options = {}) {
      assertAllowed('push');
      await ensureConfiguredEndpoint();
      const {
        source = 'HEAD',
        target = undefined,
        forceWithLease = false,
      } = options;
      if (forceWithLease && !allowForcePush) {
        throw new Error('Git remote does not allow force push');
      }
      assertAllowedRef(source);
      if (target !== undefined) {
        assertAllowedRef(target);
      }
      const refspec = target === undefined ? source : `${source}:${target}`;
      return harden({
        output: await runGit([
          'push',
          ...(forceWithLease ? ['--force-with-lease'] : []),
          remoteName,
          refspec,
        ]),
      });
    },
  });
};
harden(makeGitRemote);
