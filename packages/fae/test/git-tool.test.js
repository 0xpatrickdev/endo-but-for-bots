// @ts-check

import '@endo/init/debug.js';

import { execFile } from 'child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import process from 'node:process';
import { promisify } from 'util';

import test from 'ava';

import { makeDaemonGitTool, makeGitTool } from '../src/tool-makers.js';

const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = async (cwd, args) =>
  execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });

/**
 * @returns {Promise<string>}
 */
const makeRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), 'fae-git-tool-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fae Test']);
  await git(root, ['config', 'user.email', 'fae-test@example.com']);
  await writeFile(join(root, 'README.md'), '# repo\n', 'utf-8');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
};

test.afterEach.always(async t => {
  const root = /** @type {{ root?: string }} */ (t.context).root;
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

test.serial(
  'git tool supports local branch, rebase, and stash workflows',
  async t => {
    const root = await makeRepo();
    t.context = { root };
    const tool = makeGitTool(root);

    t.regex(await tool.execute({ operation: 'status' }), /^## main/u);

    await tool.execute({
      operation: 'branchCreate',
      branch: 'feature',
      switchAfterCreate: true,
    });
    await writeFile(join(root, 'feature.txt'), 'feature\n', 'utf-8');
    await tool.execute({ operation: 'add', paths: ['feature.txt'] });
    await tool.execute({ operation: 'commit', message: 'feature work' });

    await tool.execute({ operation: 'switch', target: 'main' });
    await writeFile(join(root, 'main.txt'), 'main\n', 'utf-8');
    await tool.execute({ operation: 'add', paths: ['main.txt'] });
    await tool.execute({ operation: 'commit', message: 'main work' });

    await tool.execute({ operation: 'switch', target: 'feature' });
    await tool.execute({
      operation: 'rebase',
      mode: 'start',
      upstream: 'main',
    });

    const log = await tool.execute({ operation: 'log', maxCount: 3 });
    t.regex(log, /feature work/u);
    t.regex(log, /main work/u);

    await writeFile(join(root, 'README.md'), '# repo\nscratch\n', 'utf-8');
    await tool.execute({
      operation: 'stashPush',
      message: 'scratch',
    });
    t.regex(await tool.execute({ operation: 'stashList' }), /scratch/u);
    await tool.execute({ operation: 'stashPop' });
    t.regex(await tool.execute({ operation: 'status' }), /M README\.md/u);
  },
);

test.serial(
  'git tool rejects scope expansion and unsupported operations',
  async t => {
    const root = await makeRepo();
    t.context = { root };
    const tool = makeGitTool(root);

    await t.throwsAsync(
      () => tool.execute({ operation: 'add', paths: ['../outside.txt'] }),
      { message: /Path traversal not allowed/u },
    );
    await t.throwsAsync(() => tool.execute({ operation: 'push' }), {
      message: /Unsupported git operation/u,
    });
  },
);

test.serial(
  'git tool refuses roots broader or narrower than the repository',
  async t => {
    const root = await makeRepo();
    t.context = { root };
    const subdir = join(root, 'src');
    await mkdir(subdir);
    const tool = makeGitTool(subdir);

    await t.throwsAsync(() => tool.execute({ operation: 'status' }), {
      message: /Git root must be the configured root/u,
    });
  },
);

test.serial('git tool refuses executable repo-local filters', async t => {
  const root = await makeRepo();
  t.context = { root };
  await git(root, ['config', 'filter.demo.process', 'cat']);
  const tool = makeGitTool(root);

  await t.throwsAsync(
    () => tool.execute({ operation: 'add', paths: ['README.md'] }),
    { message: /repository config can execute commands/u },
  );
});

test('daemon git tool converts path strings to mount entries', async t => {
  /** @type {Array<{ method: string, paths?: string[][] }>} */
  const calls = [];
  const worktree = harden({
    entry(segments) {
      const frozenSegments = harden([...segments]);
      return harden({
        segments: async () => frozenSegments,
      });
    },
  });
  const gitCap = harden({
    worktree: async () => worktree,
    statusText: async () => '## main\n',
    add: async entries => {
      calls.push({
        method: 'add',
        paths: await Promise.all(entries.map(entry => entry.segments())),
      });
      return '(no output)';
    },
  });
  const tool = makeDaemonGitTool(gitCap);

  t.is(await tool.execute({ operation: 'status' }), '## main\n');
  t.is(
    await tool.execute({ operation: 'add', paths: ['src/main.js'] }),
    '(no output)',
  );
  t.deepEqual(calls, [{ method: 'add', paths: [['src', 'main.js']] }]);
  await t.throwsAsync(
    () => tool.execute({ operation: 'add', paths: ['../escape.js'] }),
    { message: /Invalid repository path/u },
  );
});
