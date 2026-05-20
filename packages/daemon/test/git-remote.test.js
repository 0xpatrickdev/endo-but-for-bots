// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify as nodePromisify } from 'node:util';

import { E, Far } from '@endo/far';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeMount } from '../src/mount.js';
import { makeGit } from '../src/git.js';
import { makeNativeGitBackend } from '../src/native-git-backend.js';
import { makeGitRemote, getGitRemoteController } from '../src/git-remote.js';

const execFileAsync = nodePromisify(execFile);

/**
 * @param {import('ava').ExecutionContext} t
 */
const provisionGitContext = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'git-remote-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
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
  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot: root });
  await backend.assertRepositoryRoot();
  const git = makeGit({ mount, backend });
  return { git };
};

test('makeGitRemote produces a paired (remote, controller) facet', async t => {
  const { git } = await provisionGitContext(t);
  const { remote, controller } = makeGitRemote({
    git,
    name: 'origin',
    policy: {
      url: 'https://github.com/example/repo.git',
      allowedDirections: ['fetch'],
      fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
      pushRefspecs: [],
    },
  });
  t.truthy(remote);
  t.truthy(controller);
  t.is(getGitRemoteController(remote), controller);
  t.is(getGitRemoteController({}), undefined);
});

test('GitRemote.inspect returns the current policy snapshot', async t => {
  const { git } = await provisionGitContext(t);
  const { remote } = makeGitRemote({
    git,
    name: 'origin',
    policy: {
      url: 'https://github.com/example/repo.git',
      allowedDirections: ['fetch', 'push'],
      fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
      pushRefspecs: ['refs/heads/agent/*:refs/heads/agent/*'],
      allowedBranches: ['agent/x'],
      allowForcePush: false,
      allowTags: false,
      allowDelete: false,
    },
  });
  const snapshot = await E(remote).inspect();
  t.is(snapshot.name, 'origin');
  t.is(snapshot.url, 'https://github.com/example/repo.git');
  t.deepEqual([...snapshot.allowedDirections].sort(), ['fetch', 'push']);
  t.deepEqual([...snapshot.pushRefspecs], [
    'refs/heads/agent/*:refs/heads/agent/*',
  ]);
  t.false(snapshot.allowForcePush);
});

test('GitRemote.fetch / pull / push surface NYI in Phase 1', async t => {
  const { git } = await provisionGitContext(t);
  const { remote } = makeGitRemote({
    git,
    name: 'origin',
    policy: {
      url: 'https://github.com/example/repo.git',
      allowedDirections: ['fetch', 'push'],
      fetchRefspecs: [],
      pushRefspecs: [],
    },
  });
  await t.throwsAsync(E(remote).fetch({}), { message: /not yet implemented/ });
  await t.throwsAsync(E(remote).pull({}), { message: /not yet implemented/ });
  await t.throwsAsync(E(remote).push({}), { message: /not yet implemented/ });
});

test('GitRemote enforces allowedDirections at the call boundary', async t => {
  const { git } = await provisionGitContext(t);
  // Fetch-only policy: push must be refused before the NYI surface
  // is even reached.
  const { remote } = makeGitRemote({
    git,
    name: 'origin',
    policy: {
      url: 'https://github.com/example/repo.git',
      allowedDirections: ['fetch'],
      fetchRefspecs: [],
      pushRefspecs: [],
    },
  });
  await t.throwsAsync(E(remote).push({}), {
    message: /does not permit "push"/,
  });
});

test('GitRemoteController mutates policy, snapshot reflects the change', async t => {
  const { git } = await provisionGitContext(t);
  const { remote, controller } = makeGitRemote({
    git,
    name: 'origin',
    policy: {
      url: 'https://github.com/example/repo.git',
      allowedDirections: ['fetch'],
      fetchRefspecs: [],
      pushRefspecs: [],
    },
  });
  // Widen to allow push, then narrow back.
  await E(controller).setAllowedDirections(['fetch', 'push']);
  let snapshot = await E(remote).inspect();
  t.deepEqual([...snapshot.allowedDirections].sort(), ['fetch', 'push']);

  await E(controller).setAllowedDirections(['fetch']);
  snapshot = await E(remote).inspect();
  t.deepEqual([...snapshot.allowedDirections], ['fetch']);

  // The controller's inspect also reports the revoked flag.
  const controllerView = await E(controller).inspect();
  t.false(controllerView.revoked);
});

test('GitRemoteController.revoke makes all remote ops refuse', async t => {
  const { git } = await provisionGitContext(t);
  const { remote, controller } = makeGitRemote({
    git,
    name: 'origin',
    policy: {
      url: 'https://github.com/example/repo.git',
      allowedDirections: ['fetch'],
      fetchRefspecs: [],
      pushRefspecs: [],
    },
  });
  await E(controller).revoke();

  // Every guest-visible operation now refuses.  The controller still
  // works so the host can inspect after revocation.
  await t.throwsAsync(E(remote).inspect(), { message: /has been revoked/ });
  await t.throwsAsync(E(remote).fetch({}), { message: /has been revoked/ });
  const view = await E(controller).inspect();
  t.true(view.revoked);
});

test('makeGitRemote rejects an empty url or empty name', async t => {
  const { git } = await provisionGitContext(t);
  t.throws(
    () =>
      makeGitRemote({
        git,
        name: '',
        policy: {
          url: 'https://x',
          allowedDirections: ['fetch'],
          fetchRefspecs: [],
          pushRefspecs: [],
        },
      }),
    { message: /non-empty string/ },
  );
  t.throws(
    () =>
      makeGitRemote({
        git,
        name: 'origin',
        policy: {
          url: '',
          allowedDirections: ['fetch'],
          fetchRefspecs: [],
          pushRefspecs: [],
        },
      }),
    { message: /non-empty url/ },
  );
});

test('getGitRemoteController rejects fabricated remote exos', async t => {
  // A spoof exo cannot recover the controller — the WeakMap is the
  // only entry point, and spoofs never landed in it.
  const fake = Far('FakeGitRemote', {
    inspect: () => Promise.resolve({}),
    fetch: () => Promise.reject(new Error('spoof')),
    pull: () => Promise.reject(new Error('spoof')),
    push: () => Promise.reject(new Error('spoof')),
  });
  t.is(getGitRemoteController(fake), undefined);
});
