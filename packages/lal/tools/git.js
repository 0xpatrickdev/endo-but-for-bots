// @ts-check
/// <reference types="ses"/>

import { E } from '@endo/eventual-send';

/**
 * @typedef {object} GitToolAdapter
 * @property {readonly object[]} tools
 * @property {(toolCall: { function: { name: string, arguments?: string | object } }) => Promise<unknown>} execute
 */

const gitToolSchemas = harden([
  {
    type: 'function',
    function: {
      name: 'gitStatus',
      description: 'Return simplified git status entries for the worktree.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitDiff',
      description: 'Return a text git diff for the whole worktree or paths.',
      parameters: {
        type: 'object',
        properties: {
          cached: { type: 'boolean' },
          base: { type: 'string' },
          head: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitAdd',
      description: 'Stage mount-relative paths.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitRestore',
      description: 'Restore mount-relative paths in the worktree or index.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          staged: { type: 'boolean' },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitCommit',
      description: 'Commit staged changes with a message.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitLog',
      description: 'Return recent commits.',
      parameters: {
        type: 'object',
        properties: {
          maxCount: { type: 'number' },
          ref: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitReadTreeFile',
      description:
        'Read a text file from an immutable git tree-ish without touching the worktree.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['ref', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitCurrentBranch',
      description: 'Return the current branch or detached HEAD ref.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitBranches',
      description: 'List local branches.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitSwitchBranch',
      description: 'Switch to an existing local branch by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitDetach',
      description: 'Switch to detached HEAD at the given ref.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
        },
        required: ['ref'],
      },
    },
  },
]);
harden(gitToolSchemas);

const gitRemoteToolSchemas = harden([
  {
    type: 'function',
    function: {
      name: 'gitRemoteInspect',
      description: 'Return the granted GitRemote policy summary.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitRemoteFetch',
      description: 'Fetch approved refs through the granted GitRemote.',
      parameters: {
        type: 'object',
        properties: {
          prune: { type: 'boolean' },
          tags: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitRemotePull',
      description:
        'Fetch approved refs and integrate one branch through the granted GitRemote.',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          strategy: { type: 'string' },
          prune: { type: 'boolean' },
          tags: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitRemotePush',
      description: 'Push an approved source ref to an approved destination ref.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          destination: { type: 'string' },
          force: { type: 'boolean' },
          setUpstream: { type: 'boolean' },
        },
        required: ['source'],
      },
    },
  },
]);
harden(gitRemoteToolSchemas);

/**
 * Split an LLM-supplied mount-relative path into descriptor segments.
 * The mount validates each segment again, but doing the UI-boundary
 * check here keeps error messages attached to the tool call.
 *
 * @param {string} relativePath
 * @returns {string[]}
 */
const pathSegments = relativePath => {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new Error('git path must be a non-empty string');
  }
  if (relativePath.startsWith('/')) {
    throw new Error(`git path must be mount-relative: ${relativePath}`);
  }
  if (relativePath.includes('\\') || relativePath.includes('\0')) {
    throw new Error(`git path contains an invalid character: ${relativePath}`);
  }
  const segments = relativePath.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`git path must not contain traversal: ${relativePath}`);
    }
  }
  if (segments.length === 0) {
    throw new Error('git path must name a mount-relative entry');
  }
  return segments;
};
harden(pathSegments);

/** @param {unknown} value */
const assertStringArray = value => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('paths must be a non-empty string array');
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('paths must be a non-empty string array');
    }
  }
  return /** @type {string[]} */ (value);
};
harden(assertStringArray);

/** @param {unknown} value */
const displayCommit = value => {
  const commit = /** @type {{ oid: string, summary: string, author?: string, committedAt?: number }} */ (
    value
  );
  return harden({
    oid: commit.oid,
    summary: commit.summary,
    ...(commit.author !== undefined ? { author: commit.author } : {}),
    ...(commit.committedAt !== undefined
      ? { committedAt: commit.committedAt }
      : {}),
  });
};
harden(displayCommit);

/** @param {unknown} value */
const isDisplayableCommit = value => {
  const commit = /** @type {{ oid?: unknown, summary?: unknown }} */ (value);
  return typeof commit.oid === 'string' && typeof commit.summary === 'string';
};
harden(isDisplayableCommit);

/** @param {unknown} value */
const displayRef = value => {
  const ref = /** @type {{ name?: unknown, kind?: unknown, oid?: unknown }} */ (
    value || {}
  );
  return harden({
    ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
    ...(typeof ref.kind === 'string' ? { kind: ref.kind } : {}),
    ...(typeof ref.oid === 'string' ? { oid: ref.oid } : {}),
  });
};
harden(displayRef);

/** @param {unknown} value */
const displayRefUpdate = value => {
  const update =
    /** @type {{ local?: unknown, remote?: unknown, result?: unknown }} */ (
      value || {}
    );
  return harden({
    ...(update.local === undefined ? {} : { local: displayRef(update.local) }),
    remote:
      typeof update.remote === 'string'
        ? update.remote
        : displayRef(update.remote),
    result: update.result,
  });
};
harden(displayRefUpdate);

/** @param {unknown} value */
const displayRemoteResult = value => {
  const result =
    /** @type {{ updatedRefs?: unknown, text?: unknown, fetch?: unknown, integration?: unknown, head?: unknown }} */ (
      value || {}
    );
  return harden({
    ...(Array.isArray(result.updatedRefs)
      ? { updatedRefs: harden(result.updatedRefs.map(displayRefUpdate)) }
      : {}),
    ...(typeof result.text === 'string' ? { text: result.text } : {}),
    ...(result.fetch === undefined
      ? {}
      : { fetch: displayRemoteResult(result.fetch) }),
    ...(typeof result.integration === 'string'
      ? { integration: result.integration }
      : {}),
    ...(result.head === undefined ? {} : { head: displayRef(result.head) }),
  });
};
harden(displayRemoteResult);

/**
 * @param {unknown} rawArguments
 */
const parseToolArguments = rawArguments =>
  typeof rawArguments === 'string'
    ? JSON.parse(rawArguments || '{}')
    : rawArguments || {};
harden(parseToolArguments);

/**
 * Create OpenAI-compatible tool schemas plus an executor over a granted Git
 * capability and its worktree mount.  User-facing path strings are converted
 * immediately into `EndoMountEntry` values; results returned to the LLM are
 * copied display data, not authority-bearing entries or live file caps.
 *
 * @param {object} args
 * @param {object} args.git
 * @param {object} args.mount
 * @returns {GitToolAdapter}
 */
export const makeGitToolAdapter = ({ git, mount }) => {
  /**
   * @param {readonly string[]} paths
   */
  const entriesForPaths = async paths =>
    Promise.all(paths.map(pathName => E(mount).entry(pathSegments(pathName))));

  return harden({
    tools: gitToolSchemas,

    async execute(toolCall) {
      const { name, arguments: rawArguments = '{}' } = toolCall.function;
      const args = parseToolArguments(rawArguments);
      await null;

      if (name === 'gitStatus') {
        const entries = await E(git).status();
        return harden(
          entries.map(
            (
              /** @type {{ path: string, index: string, worktree: string }} */ entry,
            ) =>
              harden({
                path: entry.path,
                index: entry.index,
                worktree: entry.worktree,
              }),
          ),
        );
      }

      if (name === 'gitDiff') {
        const opts =
          /** @type {{ cached?: boolean, base?: string, head?: string, paths?: unknown }} */ (
            args
          );
        const diffOptions =
          /** @type {{ cached?: boolean, base?: string, head?: string, entries?: object[] }} */ ({});
        if (opts.cached !== undefined) diffOptions.cached = opts.cached;
        if (opts.base !== undefined) diffOptions.base = opts.base;
        if (opts.head !== undefined) diffOptions.head = opts.head;
        if (opts.paths !== undefined) {
          diffOptions.entries = await entriesForPaths(
            assertStringArray(opts.paths),
          );
        }
        return E(git).diff(diffOptions);
      }

      if (name === 'gitAdd') {
        const paths = assertStringArray(args.paths);
        const entries = await entriesForPaths(paths);
        await E(git).add(entries);
        return harden({ ok: true, staged: harden([...paths]) });
      }

      if (name === 'gitRestore') {
        const paths = assertStringArray(args.paths);
        const entries = await entriesForPaths(paths);
        await E(git).restore(entries, { staged: args.staged });
        return harden({ ok: true, restored: harden([...paths]) });
      }

      if (name === 'gitCommit') {
        if (typeof args.message !== 'string' || args.message === '') {
          throw new Error('message must be a non-empty string');
        }
        return displayCommit(await E(git).commit(args.message));
      }

      if (name === 'gitLog') {
        const commits = await E(git).log({
          maxCount: args.maxCount,
          ref: args.ref,
        });
        return harden(commits.filter(isDisplayableCommit).map(displayCommit));
      }

      if (name === 'gitReadTreeFile') {
        if (typeof args.ref !== 'string' || args.ref === '') {
          throw new Error('ref must be a non-empty string');
        }
        if (typeof args.path !== 'string' || args.path === '') {
          throw new Error('path must be a non-empty string');
        }
        const tree = await E(git).tree(args.ref);
        const blob = await E(tree).lookup(pathSegments(args.path));
        return harden({
          ref: args.ref,
          path: args.path,
          text: await E(blob).text(),
        });
      }

      if (name === 'gitCurrentBranch') {
        return E(git).currentBranch();
      }

      if (name === 'gitBranches') {
        return E(git).branches();
      }

      if (name === 'gitSwitchBranch') {
        if (typeof args.name !== 'string' || args.name === '') {
          throw new Error('name must be a non-empty string');
        }
        await E(git).switchBranch(args.name);
        return harden({ ok: true, branch: args.name });
      }

      if (name === 'gitDetach') {
        if (typeof args.ref !== 'string' || args.ref === '') {
          throw new Error('ref must be a non-empty string');
        }
        await E(git).detach(args.ref);
        return harden({ ok: true, ref: args.ref });
      }

      throw new Error(`Unknown git tool ${name}`);
    },
  });
};
harden(makeGitToolAdapter);

/**
 * Create OpenAI-compatible tools over a granted GitRemote capability. Results
 * are copied into display records before returning to the provider.
 *
 * @param {object} args
 * @param {object} args.remote
 * @returns {GitToolAdapter}
 */
export const makeGitRemoteToolAdapter = ({ remote }) =>
  harden({
    tools: gitRemoteToolSchemas,

    async execute(toolCall) {
      const { name, arguments: rawArguments = '{}' } = toolCall.function;
      const args = parseToolArguments(rawArguments);
      await null;

      if (name === 'gitRemoteInspect') {
        return E(remote).inspect();
      }

      if (name === 'gitRemoteFetch') {
        return displayRemoteResult(
          await E(remote).fetch({ prune: !!args.prune, tags: !!args.tags }),
        );
      }

      if (name === 'gitRemotePull') {
        const opts =
          /** @type {{ branch?: unknown, strategy?: unknown, prune?: unknown, tags?: unknown }} */ (
            args
          );
        return displayRemoteResult(
          await E(remote).pull({
            ...(typeof opts.branch === 'string' ? { branch: opts.branch } : {}),
            ...(typeof opts.strategy === 'string'
              ? { strategy: opts.strategy }
              : {}),
            prune: !!opts.prune,
            tags: !!opts.tags,
          }),
        );
      }

      if (name === 'gitRemotePush') {
        if (typeof args.source !== 'string' || args.source === '') {
          throw new Error('source must be a non-empty string');
        }
        return displayRemoteResult(
          await E(remote).push({
            source: args.source,
            ...(typeof args.destination === 'string'
              ? { destination: args.destination }
              : {}),
            force: !!args.force,
            setUpstream: !!args.setUpstream,
          }),
        );
      }

      throw new Error(`Unknown git remote tool ${name}`);
    },
  });
harden(makeGitRemoteToolAdapter);

export { gitRemoteToolSchemas, gitToolSchemas };
