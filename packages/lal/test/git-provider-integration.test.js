// @ts-check
/// <reference types="ses"/>
/* eslint-disable import/no-relative-packages */

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify as nodePromisify } from 'node:util';

import { E } from '@endo/eventual-send';

import { makeConfiguredToolAdapters, spawnWorkerLoop } from '../agent.js';
import { makeMockProvider } from '../providers/index.js';
import {
  gitToolSchemas,
  makeGitRemoteToolAdapter,
  makeGitToolAdapter,
} from '../tools/git.js';
import { makeMockPowers } from '../tools/mock-powers.js';
import { makeFilePowers } from '../../daemon/src/daemon-node-powers.js';
import { makeGit } from '../../daemon/src/git.js';
import { makeGitRemote } from '../../daemon/src/git-remote.js';
import { makeMount } from '../../daemon/src/mount.js';
import { makeNativeGitBackend } from '../../daemon/src/native-git-backend.js';

const execFileAsync = nodePromisify(execFile);

/**
 * @param {string} root
 */
const initRepository = async root => {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=T',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: root },
  );
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {string} sourceRepo
 */
const provisionBareRemote = async (t, sourceRepo) => {
  const remoteParent = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lal-git-remote-bare-'),
  );
  t.teardown(() =>
    fs.promises.rm(remoteParent, { recursive: true, force: true }),
  );
  const remoteRoot = path.join(remoteParent, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', sourceRepo, remoteRoot]);
  return remoteRoot;
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {string} remoteRoot
 */
const advanceRemoteMain = async (t, remoteRoot) => {
  const cloneRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lal-git-remote-upstream-'),
  );
  t.teardown(() => fs.promises.rm(cloneRoot, { recursive: true, force: true }));
  await execFileAsync('git', ['clone', remoteRoot, cloneRoot]);
  await fs.promises.writeFile(path.join(cloneRoot, 'upstream.txt'), 'upstream\n');
  await execFileAsync('git', ['add', 'upstream.txt'], { cwd: cloneRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'upstream'],
    { cwd: cloneRoot },
  );
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: cloneRoot });
};

test('mock LLM provider drives a basic Git status/add/commit workflow', async t => {
  const repoRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lal-git-provider-'),
  );
  t.teardown(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
  await initRepository(repoRoot);
  await fs.promises.writeFile(path.join(repoRoot, 'notes.txt'), 'ship it\n');

  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend });
  const adapter = makeGitToolAdapter({ git, mount });

  const provider = makeMockProvider({
    trace: harden({
      id: 'git.basic-status-add-commit',
      rounds: [
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'status-1',
                  function: { name: 'gitStatus', arguments: '{}' },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'add-1',
                  function: {
                    name: 'gitAdd',
                    arguments: '{"paths":["notes.txt"]}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'diff-1',
                  function: {
                    name: 'gitDiff',
                    arguments: '{"cached":true,"paths":["notes.txt"]}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'commit-1',
                  function: {
                    name: 'gitCommit',
                    arguments: '{"message":"test: add notes"}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'tree-read-1',
                  function: {
                    name: 'gitReadTreeFile',
                    arguments: '{"ref":"HEAD","path":"notes.txt"}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'log-1',
                  function: {
                    name: 'gitLog',
                    arguments: '{"maxCount":1}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'status-2',
                  function: { name: 'gitStatus', arguments: '{}' },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: 'done',
            },
          },
        },
      ],
    }),
  });

  const messages = [
    {
      role: 'system',
      content: 'Use the provided git tools to inspect and commit changes.',
    },
    {
      role: 'user',
      content: 'Commit notes.txt if it is untracked.',
    },
  ];

  /** @type {Array<{ name: string, result: unknown }>} */
  const observed = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const response = await provider.chat(messages, [...adapter.tools]);
    const { message } = response;
    messages.push(message);
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    if (toolCalls.length === 0) {
      break;
    }
    for (const toolCall of toolCalls) {
      // eslint-disable-next-line no-await-in-loop
      const result = await adapter.execute(toolCall);
      observed.push({
        name: toolCall.function.name,
        result,
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  t.deepEqual(
    observed.map(call => call.name),
    [
      'gitStatus',
      'gitAdd',
      'gitDiff',
      'gitCommit',
      'gitReadTreeFile',
      'gitLog',
      'gitStatus',
    ],
  );
  t.deepEqual(observed[0].result, [
    { path: 'notes.txt', index: 'clean', worktree: 'untracked' },
  ]);
  t.true(
    String(observed[2].result).includes('+ship it'),
    'cached diff should include the staged file content',
  );
  const recent = await E(git).log({ maxCount: 1 });
  const logResult =
    /** @type {Array<{ oid: string, summary: string, author?: string, committedAt?: number }>} */ (
      observed[5].result
    );
  t.is(logResult[0].oid, recent[0].oid);
  t.is(logResult[0].summary, 'test: add notes');
  t.deepEqual(observed[4].result, {
    ref: 'HEAD',
    path: 'notes.txt',
    text: 'ship it\n',
  });
  t.deepEqual(observed[6].result, []);

  t.is(recent[0].summary, 'test: add notes');
  t.is(provider.calls.length, 8);
  t.deepEqual(
    provider.calls[0].tools.map(tool => tool.function.name),
    gitToolSchemas.map(tool => tool.function.name),
  );
  t.true(
    provider.calls[1].messages.some(
      message =>
        message.role === 'tool' &&
        typeof message.content === 'string' &&
        message.content.includes('"notes.txt"'),
    ),
    'the second provider turn should see the first gitStatus tool result',
  );
});

test('mock LLM provider drives GitRemote fetch / pull / push workflow', async t => {
  const repoRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lal-git-remote-provider-'),
  );
  t.teardown(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
  await initRepository(repoRoot);
  const remoteRoot = await provisionBareRemote(t, repoRoot);
  const remoteUrl = pathToFileURL(remoteRoot).href;
  await advanceRemoteMain(t, remoteRoot);

  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend });
  const { remote } = makeGitRemote({
    git,
    name: 'origin',
    policy: {
      url: remoteUrl,
      allowLocalFileTransport: true,
      allowedDirections: ['fetch', 'push'],
      fetchRefspecs: ['+refs/heads/main:refs/remotes/origin/main'],
      pushRefspecs: ['refs/heads/main:refs/heads/agent/review'],
    },
  });
  const adapters = harden([
    makeGitToolAdapter({ git, mount }),
    makeGitRemoteToolAdapter({ remote }),
  ]);
  const adapterByToolName = new Map(
    adapters.flatMap(adapter =>
      adapter.tools.map(tool => [tool.function.name, adapter]),
    ),
  );

  const provider = makeMockProvider({
    trace: harden({
      id: 'git.remote-fetch-pull-push',
      rounds: [
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'remote-fetch-1',
                  function: {
                    name: 'gitRemoteFetch',
                    arguments: '{"prune":true}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'remote-pull-1',
                  function: {
                    name: 'gitRemotePull',
                    arguments:
                      '{"branch":"refs/remotes/origin/main","strategy":"ff-only"}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'remote-push-1',
                  function: {
                    name: 'gitRemotePush',
                    arguments:
                      '{"source":"refs/heads/main","destination":"refs/heads/agent/review"}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: 'done',
            },
          },
        },
      ],
    }),
  });

  const messages = [
    {
      role: 'system',
      content: 'Use the provided git remote tools to sync and publish.',
    },
    {
      role: 'user',
      content: 'Fetch, fast-forward from origin/main, then push review ref.',
    },
  ];
  /** @type {Array<{ name: string, result: unknown }>} */
  const observed = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const response = await provider.chat(
      messages,
      adapters.flatMap(adapter => [...adapter.tools]),
    );
    const { message } = response;
    messages.push(message);
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    if (toolCalls.length === 0) {
      break;
    }
    for (const toolCall of toolCalls) {
      const adapter = adapterByToolName.get(toolCall.function.name);
      if (adapter === undefined) {
        t.fail(`adapter exists for ${toolCall.function.name}`);
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await adapter.execute(toolCall);
      observed.push({ name: toolCall.function.name, result });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  t.deepEqual(
    observed.map(call => call.name),
    ['gitRemoteFetch', 'gitRemotePull', 'gitRemotePush'],
  );
  t.is(await E(mount).readText(['upstream.txt']), 'upstream\n');
  const { stdout: pushedRef } = await execFileAsync(
    'git',
    ['show-ref', '--hash', 'refs/heads/agent/review'],
    { cwd: remoteRoot },
  );
  t.regex(pushedRef.trim(), /^[0-9a-f]{40}$/u);
  t.true(
    provider.calls[0].tools.some(
      tool => tool.function.name === 'gitRemotePush',
    ),
    'remote tools should be advertised to the provider',
  );
  t.true(
    JSON.stringify(observed[2].result).includes('refs/heads/agent/review'),
    'remote push result should include the published ref',
  );
});

test('spawnWorkerLoop accepts injected Git tool adapters', async t => {
  const repoRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lal-git-loop-'),
  );
  t.teardown(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
  await initRepository(repoRoot);
  await fs.promises.writeFile(path.join(repoRoot, 'notes.txt'), 'loop\n');

  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend });
  const adapter = makeGitToolAdapter({ git, mount });
  const provider = makeMockProvider({
    trace: harden({
      id: 'git.injected-loop',
      rounds: [
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'status-1',
                  function: { name: 'gitStatus', arguments: '{}' },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'add-1',
                  function: {
                    name: 'gitAdd',
                    arguments: '{"paths":["notes.txt"]}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'commit-1',
                  function: {
                    name: 'gitCommit',
                    arguments: '{"message":"test: loop notes"}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'tree-read-1',
                  function: {
                    name: 'gitReadTreeFile',
                    arguments: '{"ref":"HEAD","path":"notes.txt"}',
                  },
                },
              ],
            },
          },
        },
        {
          response: {
            message: {
              role: 'assistant',
              content: 'done',
            },
          },
        },
      ],
    }),
  });
  const { powers } = makeMockPowers({
    initialMessage: harden({
      number: 1,
      from: '@host',
      to: 'lal-self-id',
      messageId: 'git-loop-msg-1',
      strings: ['Commit notes.txt and verify it can be read from HEAD.'],
      names: [],
      ids: [],
    }),
  });

  await spawnWorkerLoop(powers, null, {
    provider,
    toolAdapters: [adapter],
  });

  const recent = await E(git).log({ maxCount: 1 });
  t.is(recent[0].summary, 'test: loop notes');
  t.true(
    provider.calls[0].tools.some(
      tool => tool.function.name === 'gitReadTreeFile',
    ),
    'injected Git tools should be advertised to the provider',
  );
  t.true(
    provider.calls.some(call =>
      call.messages.some(
        message =>
          message.role === 'tool' &&
          typeof message.content === 'string' &&
          message.content.includes('loop\\n'),
      ),
    ),
    'later provider turns should receive the gitReadTreeFile result',
  );
});

test('configured Git and GitRemote petnames create worker tool adapters', async t => {
  const repoRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'lal-git-config-'),
  );
  t.teardown(() => fs.promises.rm(repoRoot, { recursive: true, force: true }));
  await initRepository(repoRoot);
  await fs.promises.writeFile(path.join(repoRoot, 'notes.txt'), 'configured\n');

  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend });
  const remote = harden({
    async inspect() {
      return harden({ name: 'origin', allowedDirections: harden(['fetch']) });
    },
  });
  const agent = harden({
    async lookup(name) {
      if (name === 'repo-git') {
        return git;
      }
      if (name === 'repo-remote') {
        return remote;
      }
      t.fail(`unexpected lookup ${name}`);
      return undefined;
    },
  });

  const adapters = await makeConfiguredToolAdapters(agent, {
    name: 'git-worker',
    host: 'http://localhost:11434/v1',
    model: 'qwen3',
    authToken: 'ollama',
    gitName: ' repo-git ',
    gitRemoteName: ' repo-remote ',
  });

  t.is(adapters.length, 2);
  t.true(
    adapters[0].tools.some(tool => tool.function.name === 'gitReadTreeFile'),
  );
  t.true(
    adapters[1].tools.some(tool => tool.function.name === 'gitRemoteInspect'),
  );
  t.deepEqual(
    await adapters[0].execute({
      function: { name: 'gitStatus', arguments: '{}' },
    }),
    [{ path: 'notes.txt', index: 'clean', worktree: 'untracked' }],
  );
  t.deepEqual(
    await adapters[1].execute({
      function: { name: 'gitRemoteInspect', arguments: '{}' },
    }),
    { name: 'origin', allowedDirections: ['fetch'] },
  );
});

test('spawnWorkerLoop rejects adapter tools that shadow built-ins', async t => {
  const provider = harden({
    chat: async () => ({
      message: harden({ role: 'assistant', content: 'unused' }),
    }),
  });
  /** @type {import('../agent.types.js').ToolAdapter} */
  const adapter = harden({
    tools: harden([
      {
        type: 'function',
        function: harden({
          name: 'help',
          description: 'conflicting adapter tool',
          parameters: harden({
            type: 'object',
            properties: harden({}),
            required: harden([]),
          }),
        }),
      },
    ]),
    execute: async () => undefined,
  });

  await t.throwsAsync(
    () =>
      spawnWorkerLoop({}, null, {
        provider,
        toolAdapters: [adapter],
      }),
    {
      message: /conflicts with built-in Lal tool: help/,
    },
  );
});
