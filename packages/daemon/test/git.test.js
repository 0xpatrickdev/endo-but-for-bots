// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { E, Far } from '@endo/far';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeMount } from '../src/mount.js';
import { makeGit, makeNotYetImplementedBackend } from '../src/git.js';

/**
 * @param {import('ava').ExecutionContext} t
 */
const provisionMount = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'git-test-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  return makeMount({ rootPath: root, readOnly: false, filePowers });
};

test('Git exo advertises the full GitInterface', async t => {
  const mount = await provisionMount(t);
  const git = makeGit({ mount, backend: makeNotYetImplementedBackend() });

  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(git).__getMethodNames__();

  // Inspection
  for (const name of ['status', 'diff', 'log', 'show', 'revParse']) {
    t.true(methods.includes(name), `Git should advertise ${name}`);
  }

  // Mutation
  for (const name of ['add', 'restore', 'commit']) {
    t.true(methods.includes(name), `Git should advertise ${name}`);
  }

  // Branching
  for (const name of [
    'currentBranch',
    'branches',
    'createBranch',
    'deleteBranch',
    'renameBranch',
    'switch',
  ]) {
    t.true(methods.includes(name), `Git should advertise ${name}`);
  }

  // Integration
  for (const name of ['merge', 'rebase']) {
    t.true(methods.includes(name), `Git should advertise ${name}`);
  }

  // Stash
  for (const name of [
    'stashPush',
    'stashList',
    'stashShow',
    'stashApply',
    'stashPop',
    'stashDrop',
  ]) {
    t.true(methods.includes(name), `Git should advertise ${name}`);
  }

  // Trees + worktree binding
  t.true(methods.includes('tree'));
  t.true(methods.includes('worktree'));
});

test('Git.worktree() returns the bound mount cap', async t => {
  const mount = await provisionMount(t);
  const git = makeGit({ mount, backend: makeNotYetImplementedBackend() });

  // Same identity (passes through, no wrapping).  The mount cap stays
  // the public worktree authority for any guest that holds the Git cap.
  t.is(await E(git).worktree(), mount);
});

test('Git scaffold methods all surface a clear "not yet implemented"', async t => {
  const mount = await provisionMount(t);
  const git = makeGit({ mount, backend: makeNotYetImplementedBackend() });

  // A representative sample across category boundaries; the stub backend
  // throws for every op except the formula-instantiation-time
  // assertRepositoryRoot, which is only called by `provideGit`.
  await t.throwsAsync(E(git).status(), { message: /not yet implemented/ });
  await t.throwsAsync(E(git).log({}), { message: /not yet implemented/ });
  await t.throwsAsync(E(git).commit('msg'), {
    message: /not yet implemented/,
  });
  await t.throwsAsync(E(git).branches(), { message: /not yet implemented/ });
  await t.throwsAsync(E(git).tree('HEAD'), {
    message: /not yet implemented/,
  });

  // add/restore are guarded at the public exo (they need the entry-to-path
  // resolver that Phase 2 lands) rather than going through the backend.
  const fakeEntry = Far('FakeEntry', { segments: () => ['foo.txt'] });
  await t.throwsAsync(E(git).add([fakeEntry]), {
    message: /Git.add is not yet implemented/,
  });
});

test('Git accepts both string and structured GitRef arguments', async t => {
  const mount = await provisionMount(t);
  // Override show/revParse to record the resolved name without throwing.
  /** @type {string[]} */
  const showCalls = [];
  /** @type {string[]} */
  const revParseCalls = [];
  const backend = harden({
    ...makeNotYetImplementedBackend(),
    show: async ref => {
      showCalls.push(ref);
      return '';
    },
    revParse: async ref => {
      revParseCalls.push(ref);
      return harden({ name: ref, kind: 'commit' });
    },
  });
  const git = makeGit({ mount, backend });

  await E(git).show('HEAD');
  await E(git).show({ name: 'main', kind: 'branch' });
  await E(git).revParse('v1.0');
  await E(git).revParse({ name: 'origin/main', kind: 'branch' });

  // Both string and { name } records normalize to the backend's single
  // string-named-ref input.
  t.deepEqual(showCalls, ['HEAD', 'main']);
  t.deepEqual(revParseCalls, ['v1.0', 'origin/main']);
});
