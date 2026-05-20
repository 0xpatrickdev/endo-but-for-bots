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
import { makeGit, makeNotYetImplementedBackend } from '../src/git.js';
import { makeNativeGitBackend } from '../src/native-git-backend.js';

const execFileAsync = nodePromisify(execFile);

/**
 * Initialize a real git repository at a tmp path with an initial
 * commit on `main`.  Returns the host path; the caller is responsible
 * for adding the AVA teardown.
 *
 * @param {import('ava').ExecutionContext} t
 */
const provisionGitWorktree = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-'),
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
      'init commit',
    ],
    { cwd: root },
  );
  return root;
};

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

test('NativeGitBackend.assertRepositoryRoot accepts an exact worktree root', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const backend = makeNativeGitBackend({ repoRoot });
  await t.notThrowsAsync(backend.assertRepositoryRoot());
});

test('NativeGitBackend.assertRepositoryRoot rejects a non-worktree directory', async t => {
  const bare = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'native-git-bare-'),
  );
  t.teardown(() => fs.promises.rm(bare, { recursive: true, force: true }));
  const backend = makeNativeGitBackend({ repoRoot: bare });
  // No `.git` here, so `git rev-parse --show-toplevel` errors out and
  // the backend surfaces a structured failure rather than silently
  // operating against the user's surrounding repository.
  await t.throwsAsync(backend.assertRepositoryRoot(), {
    message: /not a git repository|repository root|rev-parse failed/i,
  });
});

test('NativeGitBackend.currentBranch returns the symbolic ref name', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const backend = makeNativeGitBackend({ repoRoot });
  const head = await backend.currentBranch();
  t.deepEqual(head, { name: 'main', kind: 'branch' });
});

test('NativeGitBackend.branches lists the local branches', async t => {
  const repoRoot = await provisionGitWorktree(t);
  // Add a second branch so `branches()` returns more than one row.
  await execFileAsync('git', ['branch', 'feature/x'], { cwd: repoRoot });

  const backend = makeNativeGitBackend({ repoRoot });
  const refs = await backend.branches();
  const names = refs.map(r => r.name).sort();
  t.deepEqual(names, ['feature/x', 'main']);
  // All entries report kind 'branch'.
  for (const ref of refs) {
    t.is(ref.kind, 'branch');
  }
});

test('NativeGitBackend.revParse returns the resolved commit id', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const backend = makeNativeGitBackend({ repoRoot });

  const head = await backend.revParse('HEAD');
  t.is(head.kind, 'commit');
  // 40-char SHA-1; future SHA-256 repos extend to 64.
  t.regex(head.oid || '', /^[0-9a-f]{40,64}$/);
  // The `name` echoes the input so callers can correlate.
  t.is(head.name, 'HEAD');
});

test('NativeGitBackend.log returns structured commit records', async t => {
  const repoRoot = await provisionGitWorktree(t);
  // Add a second commit so log has something to enumerate.
  await fs.promises.writeFile(path.join(repoRoot, 'a.txt'), 'a');
  await execFileAsync('git', ['add', 'a.txt'], { cwd: repoRoot });
  await execFileAsync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'add a.txt'],
    { cwd: repoRoot },
  );

  const backend = makeNativeGitBackend({ repoRoot });
  const commits = await backend.log({ maxCount: 5 });
  t.is(commits.length, 2);
  // Most-recent-first ordering matches `git log`'s default.
  t.is(commits[0].summary, 'add a.txt');
  t.is(commits[1].summary, 'init commit');
  for (const commit of commits) {
    t.regex(commit.oid, /^[0-9a-f]{40,64}$/);
    t.is(commit.author, 'T');
    t.is(typeof commit.committedAt, 'number');
  }
});

test('NativeGitBackend.show returns the commit text', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const backend = makeNativeGitBackend({ repoRoot });
  const text = await backend.show('HEAD');
  t.regex(text, /init commit/);
});

test('NativeGitBackend.revParse rejects revisions starting with "-"', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const backend = makeNativeGitBackend({ repoRoot });
  // Defends against argument-injection via a revision that looks like
  // a flag.  The public exo's interface guard rejects non-strings, but
  // a string starting with `-` could otherwise become `git rev-parse
  // --verify -delete-foo`.
  await t.throwsAsync(backend.revParse('-delete'), {
    message: /must not start with "-"/,
  });
});

test('NativeGitBackend mutation ops still throw "not yet implemented"', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const backend = makeNativeGitBackend({ repoRoot });
  // Phase 2 will fill these in.  This pins the Phase 1 contract so a
  // future commit that lands them updates the test alongside the impl.
  await t.throwsAsync(backend.add([]), { message: /not yet implemented/ });
  await t.throwsAsync(backend.commit('msg'), {
    message: /not yet implemented/,
  });
  await t.throwsAsync(backend.diff({}), { message: /not yet implemented/ });
});

test('NativeGitBackend.status: clean worktree returns empty list', async t => {
  const repoRoot = await provisionGitWorktree(t);
  const backend = makeNativeGitBackend({ repoRoot });
  const entries = await backend.status();
  t.deepEqual([...entries], []);
});

test('NativeGitBackend.status: classifies untracked, modified, added, deleted', async t => {
  const repoRoot = await provisionGitWorktree(t);
  // Step 1: create + commit two tracked files that will become
  // modified-only and deleted-only respectively.
  await fs.promises.writeFile(path.join(repoRoot, 'modified.txt'), 'v1');
  await fs.promises.writeFile(path.join(repoRoot, 'doomed.txt'), 'gone');
  await execFileAsync('git', ['add', 'modified.txt', 'doomed.txt'], {
    cwd: repoRoot,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=T',
      'commit',
      '-m',
      'baseline',
    ],
    { cwd: repoRoot },
  );

  // Step 2: produce four distinct status shapes WITHOUT committing.
  await fs.promises.writeFile(path.join(repoRoot, 'untracked.txt'), 'u');
  await fs.promises.writeFile(path.join(repoRoot, 'modified.txt'), 'v2');
  await fs.promises.writeFile(path.join(repoRoot, 'added.txt'), 'new');
  await execFileAsync('git', ['add', 'added.txt'], { cwd: repoRoot });
  await fs.promises.rm(path.join(repoRoot, 'doomed.txt'));

  const backend = makeNativeGitBackend({ repoRoot });
  const entries = await backend.status();
  const byPath = Object.fromEntries(entries.map(e => [e.path, e]));

  // Untracked: index 'clean' (no entry), worktree 'untracked'.
  t.is(byPath['untracked.txt'].index, 'clean');
  t.is(byPath['untracked.txt'].worktree, 'untracked');

  // Modified-on-disk-only: index 'clean', worktree 'modified'.
  t.is(byPath['modified.txt'].index, 'clean');
  t.is(byPath['modified.txt'].worktree, 'modified');

  // Added-but-not-committed: index 'added', worktree 'clean'.
  t.is(byPath['added.txt'].index, 'added');
  t.is(byPath['added.txt'].worktree, 'clean');

  // Deleted from worktree: index 'clean', worktree 'deleted'.
  t.is(byPath['doomed.txt'].index, 'clean');
  t.is(byPath['doomed.txt'].worktree, 'deleted');
});

test('Git.status wraps backend rows into GitStatusEntry with mount entries', async t => {
  const repoRoot = await provisionGitWorktree(t);
  await fs.promises.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fs.promises.writeFile(
    path.join(repoRoot, 'src', 'new.js'),
    'export default 1',
  );

  // Construct the public Git exo over a real mount so status() can mint
  // EndoMountEntry values.  This is the only test in this file that
  // exercises the exo + backend wired together.
  const filePowers = makeFilePowers({ fs, path });
  const mount = makeMount({ rootPath: repoRoot, readOnly: false, filePowers });
  const backend = makeNativeGitBackend({ repoRoot });
  const git = makeGit({ mount, backend });

  const entries = await E(git).status();
  t.is(entries.length, 1);
  const [row] = entries;
  t.is(row.path, 'src/new.js');
  t.is(row.index, 'clean');
  t.is(row.worktree, 'untracked');
  // The entry is an EndoMountEntry minted on the bound mount.  Its
  // segments reflect the repo-relative path split by `/`.
  t.deepEqual(await E(row.entry).segments(), ['src', 'new.js']);
  t.true(await E(row.entry).exists());
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
