// @ts-check
/// <reference types="ses"/>

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { E, Far } from '@endo/far';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import {
  makeMount,
  getMountBacking,
  getEntryPhysicalPath,
  lineageOf,
} from '../src/mount.js';

/**
 * Returns a mount built directly (no daemon, no CapTP) over a fresh
 * filesystem tmp directory.  Snapshot is not wired — Phase 4 tests
 * exercise the host-private backing surface, not snapshot.
 *
 * @param {import('ava').ExecutionContext} t
 */
const provisionMount = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'mount-test-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  return { root, filePowers };
};

test('getMountBacking returns the lineage root for a daemon-minted mount', async t => {
  const { root, filePowers } = await provisionMount(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  const backing = getMountBacking(mount);
  t.truthy(backing, 'every daemon-minted mount has a registered backing');
  if (!backing) return; // type-narrow for TS

  t.is(backing.kind, 'physical');
  t.is(backing.physicalRoot, root);
  t.is(backing.currentDir, root);
});

test('getMountBacking returns undefined for fake mount caps', async t => {
  // A spoof that quacks like a Mount (advertises all the right methods)
  // must still be unrecoverable through the backing accessor.  Identity
  // is enforced by the WeakMap, not by the public method surface.
  const spoof = Far('FakeMount', {
    has: () => Promise.resolve(true),
    list: () => Promise.resolve([]),
    lookup: () => Promise.reject(new Error('spoof')),
    readText: () => Promise.reject(new Error('spoof')),
    writeText: () => Promise.reject(new Error('spoof')),
    snapshot: () => Promise.reject(new Error('spoof')),
    help: () => 'spoof',
  });

  t.is(getMountBacking(spoof), undefined);
  t.is(getMountBacking({}), undefined);
  t.is(getMountBacking(null), undefined);
});

test('sub-mounts derived via lookup share lineage and have their own backing', async t => {
  const { root, filePowers } = await provisionMount(t);
  await fs.promises.mkdir(path.join(root, 'sub'));
  await fs.promises.writeFile(path.join(root, 'sub', 'leaf.txt'), 'leaf');

  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const sub = await E(mount).lookup(['sub']);

  // Both expose backings; the lineage's confinement root is unchanged.
  const rootBacking = getMountBacking(mount);
  const subBacking = getMountBacking(sub);
  t.truthy(rootBacking);
  t.truthy(subBacking);
  if (!rootBacking || !subBacking) return;

  t.is(subBacking.physicalRoot, rootBacking.physicalRoot);
  // The sub-mount's currentDir reflects the descent; the lineage's root
  // stays anchored on the original mount root.
  t.is(subBacking.currentDir, path.join(root, 'sub'));

  // Lineage sentinel is shared between mount and sub-mount, and between
  // a mount and an entry minted from it — both are queryable through
  // the public `lineageOf` accessor.
  t.is(lineageOf(mount), lineageOf(sub));
});

test('getEntryPhysicalPath resolves a daemon-minted entry to its host path', async t => {
  const { root, filePowers } = await provisionMount(t);
  await fs.promises.mkdir(path.join(root, 'a', 'b'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'a', 'b', 'c.txt'), 'leaf');

  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const present = await E(mount).entry(['a', 'b', 'c.txt']);
  const ghost = await E(mount).entry(['nowhere', 'phantom.txt']);

  // Trusted code can resolve both present and absent entries: descriptors
  // are logical references and the backing exposes their path regardless
  // of whether the node currently exists.
  t.is(getEntryPhysicalPath(present), path.join(root, 'a', 'b', 'c.txt'));
  t.is(
    getEntryPhysicalPath(ghost),
    path.join(root, 'nowhere', 'phantom.txt'),
  );

  // Cross-mount: an entry from a different lineage has no resolved path
  // in this lineage's view.  (Even though `getEntryPhysicalPath` returns
  // a path for any daemon-minted entry, the lineage check protects
  // *consumption* in path-bearing mount methods — see endo.test.js.)
  const otherRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'mount-other-'),
  );
  t.teardown(() => fs.promises.rm(otherRoot, { recursive: true, force: true }));
  const otherMount = makeMount({
    rootPath: otherRoot,
    readOnly: false,
    filePowers,
  });
  const otherEntry = await E(otherMount).entry(['x.txt']);
  // Each entry has *some* path in its own lineage, but the lineage IDs
  // differ — that mismatch is what the path-bearing mount methods key on.
  t.not(lineageOf(otherEntry), lineageOf(present));
});

test('getEntryPhysicalPath returns undefined for fabricated entry exos', async t => {
  const fake = Far('FakeMountEntry', {
    segments: () => Promise.resolve(['a']),
    displayPath: () => 'a',
    exists: () => Promise.resolve(false),
    stat: () => Promise.resolve(undefined),
    lookup: () => Promise.reject(new Error('spoof')),
    openFile: () => Promise.reject(new Error('spoof')),
    openDirectory: () => Promise.reject(new Error('spoof')),
    child: () => fake,
  });
  t.is(getEntryPhysicalPath(fake), undefined);
  t.is(getEntryPhysicalPath({}), undefined);
});

test('read-only attenuations preserve backing kind and lineage', async t => {
  const { root, filePowers } = await provisionMount(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });
  const roMount = await E(mount).readOnly();

  const rwBacking = getMountBacking(mount);
  const roBacking = getMountBacking(roMount);
  t.truthy(rwBacking);
  t.truthy(roBacking);
  if (!rwBacking || !roBacking) return;

  // Read-only is a public attenuation, not a different kind of mount —
  // the physical backing is unchanged so a trusted git provider can still
  // recognise the read-only view's underlying worktree.
  t.is(roBacking.kind, 'physical');
  t.is(roBacking.physicalRoot, rwBacking.physicalRoot);
  t.is(lineageOf(roMount), lineageOf(mount));
});

test('public mount surface does not expose the physical root', async t => {
  const { root, filePowers } = await provisionMount(t);
  const mount = makeMount({ rootPath: root, readOnly: false, filePowers });

  // None of the public methods that touch a backing should leak the host
  // path back to a guest.  Only the host-private accessor above does.
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(mount).__getMethodNames__();
  for (const forbidden of ['physicalRoot', 'rootPath', 'getPath', 'getBacking']) {
    t.false(
      methods.includes(forbidden),
      `EndoMount must not expose ${forbidden}() to guests`,
    );
  }
});
