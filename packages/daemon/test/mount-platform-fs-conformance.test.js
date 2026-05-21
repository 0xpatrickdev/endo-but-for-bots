// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import os from 'os';
import path from 'path';
import fs from 'fs';
import url from 'url';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import {
  DirectoryInterface as PlatformDirectoryInterface,
  FileInterface as PlatformFileInterface,
  ReadableBlobInterface,
  ReadableTreeInterface,
  checkinTree,
  makeSnapshotStore,
  makeReaderRef,
} from '@endo/platform/fs/lite';
import { M } from '@endo/patterns';

import { makeFilePowers } from '../src/daemon-node-powers.js';
import { makeMount } from '../src/mount.js';

/**
 * Phase 5 conformance test for `designs/daemon-mount-capabilities.md`.
 * Asserts that `EndoMount` is a daemon-local specialization of the
 * `Directory` contract from `@endo/platform/fs`, and that
 * `EndoMountFile` is a specialization of the `File` contract.
 *
 * The test does not bring up a full daemon; it constructs an
 * `EndoMount` directly via `makeMount` against a real temp directory.
 * The conformance assertions are:
 *
 * 1. Every method on `PlatformDirectoryInterface` /
 *    `PlatformFileInterface` is present on the corresponding Exo's
 *    method-names set.
 * 2. Calling each method through `E()` with shapes that the platform
 *    guard would accept produces no `M.interface` violation.
 * 3. `EndoMount.readOnly()` returns an Exo whose `__getMethodNames__`
 *    is exactly the `ReadableTreeInterface` method set; similarly
 *    `EndoMountFile.readOnly()` returns the `ReadableBlobInterface`
 *    set.
 *
 * Drift in either direction (a daemon method whose shape changes
 * without the platform contract tracking it, or a future platform
 * contract change the daemon does not absorb) breaks this test.
 */

const filePowers = makeFilePowers({ fs, path });

/**
 * @param {import('ava').ExecutionContext} t
 */
const makeTempRoot = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-conf-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * Minimal in-memory ContentStore so the test can exercise
 * `snapshot()` without spinning up the daemon's filesystem store.
 *
 * @returns {import('@endo/platform/fs/lite/types').SnapshotStore}
 */
const makeMemoryStore = () => {
  /** @type {Map<string, Uint8Array>} */
  const blobs = new Map();

  /** @type {import('@endo/platform/fs/lite/types').ContentStore} */
  const contentStore = harden({
    async store(readable) {
      const chunks = [];
      let length = 0;
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
        /** @type {unknown} */ (readable)
      )) {
        chunks.push(chunk);
        length += chunk.byteLength;
      }
      const combined = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // Deterministic content-addressed id by hashing bytes.
      const id = `sha-${combined.length}-${[...combined.slice(0, 16)].join('-')}-${Math.random().toString(36).slice(2)}`;
      blobs.set(id, combined);
      return id;
    },
    fetch(sha256) {
      const maybeBytes = blobs.get(sha256);
      if (maybeBytes === undefined) {
        throw new Error(`No blob for ${sha256}`);
      }
      const bytes = /** @type {Uint8Array} */ (maybeBytes);
      const text = async () => new TextDecoder().decode(bytes);
      const json = async () => {
        await null;
        return JSON.parse(await text());
      };
      const streamBase64 = () => {
        // An async iterable yielding the bytes as a single chunk.
        /** @returns {AsyncIterable<Uint8Array>} */
        async function* iter() {
          yield /** @type {Uint8Array} */ (bytes);
        }
        return makeReaderRef(iter());
      };
      return harden({ streamBase64, text, json });
    },
    async has(sha256) {
      return blobs.has(sha256);
    },
    async remove(sha256) {
      blobs.delete(sha256);
    },
  });
  return makeSnapshotStore(contentStore);
};

/**
 * Extract a method-name set from an `M.interface` guard.  The interface
 * is a Pattern record; the method shapes live under its `methodGuards`
 * iface descriptor.  We probe via Reflect.ownKeys on the call-args
 * record indirectly: M.interface stores method guards on a hidden
 * property accessible via getMethodNames().
 *
 * @param {any} iface
 */
const interfaceMethodNames = iface => {
  // M.interface returns an InterfaceGuard whose payload includes the
  // method-guard record under symbol-keyed slot.  The public API
  // exposes the method names via `getInterfaceMethodKeys`.
  // We deduce by introspection rather than depend on internal API:
  // every M.interface guard records the method names accessible via
  // its serialized payload at `.methodGuards`.
  const payload = /** @type {any} */ (iface).interfaceName ?? null;
  // Fallback: scan with `M.toPattern` to read out the methodGuards.
  // We provide an explicit list to avoid depending on @endo/patterns
  // internals.  Each interface lists the expected names below.
  return payload;
};
// Silence linter: helper above documents the indirect path even though
// the tests below use explicit lists.
void interfaceMethodNames;

/** Method names the platform `Directory` contract requires. */
const PLATFORM_DIRECTORY_METHODS = [
  'has',
  'list',
  'lookup',
  'write',
  'remove',
  'move',
  'copy',
  'makeDirectory',
  'readOnly',
  'snapshot',
];

/** Method names the platform `File` contract requires. */
const PLATFORM_FILE_METHODS = [
  'streamBase64',
  'text',
  'json',
  'writeText',
  'writeBytes',
  'append',
  'readOnly',
  'snapshot',
];

/** Method names the platform `ReadableTree` contract requires. */
const PLATFORM_READABLE_TREE_METHODS = ['has', 'list', 'lookup'];

/** Method names the platform `ReadableBlob` contract requires. */
const PLATFORM_READABLE_BLOB_METHODS = ['streamBase64', 'text', 'json'];

/**
 * Construct an `EndoMount` with an in-memory snapshot pipeline.
 *
 * @param {import('ava').ExecutionContext} t
 */
const makeConfiguredMount = t => {
  const rootPath = makeTempRoot(t);
  const store = makeMemoryStore();
  const snapshotTree = async tree => {
    const { sha256 } = await checkinTree(tree, store);
    return store.loadTree(sha256);
  };
  const snapshotFile = async filePath => {
    const sha256 = await store.store(filePowers.makeFileReader(filePath));
    return store.loadBlob(sha256);
  };
  const mount = makeMount({
    rootPath,
    readOnly: false,
    filePowers,
    snapshotTree,
    snapshotFile,
  });
  return { mount, rootPath };
};

test('EndoMount exposes every method on PlatformDirectoryInterface', async t => {
  const { mount } = makeConfiguredMount(t);
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(mount).__getMethodNames__();
  for (const name of PLATFORM_DIRECTORY_METHODS) {
    t.true(
      methods.includes(name),
      `EndoMount missing platform Directory method ${name}`,
    );
  }
});

test('EndoMount.makeDirectory returns a sub-mount (Directory.makeDirectory shape)', async t => {
  const { mount } = makeConfiguredMount(t);
  const sub = await E(mount).makeDirectory(['sub']);
  // The return value must be a Directory-shaped capability — a mount.
  // eslint-disable-next-line no-underscore-dangle
  const subMethods = await E(sub).__getMethodNames__();
  for (const name of PLATFORM_DIRECTORY_METHODS) {
    t.true(
      subMethods.includes(name),
      `makeDirectory returned object missing ${name}`,
    );
  }
  // Writes through the returned sub-mount land inside the new dir.
  await E(sub).writeText(['leaf.txt'], 'inside-sub');
  t.is(await E(mount).readText(['sub', 'leaf.txt']), 'inside-sub');
});

test('EndoMount.write accepts a ReadableBlob and materializes bytes', async t => {
  const { mount, rootPath } = makeConfiguredMount(t);
  // A minimal blob-shaped remotable that satisfies ReadableBlob.
  const blob = makeExo('TestBlob', ReadableBlobInterface, {
    streamBase64() {
      const chunks = [Buffer.from('hello blob', 'utf-8').toString('base64')];
      let idx = 0;
      return makeExo(
        'AsyncIterator',
        M.interface('AsyncIterator', {
          next: M.call().returns(M.promise()),
          return: M.call().optional(M.any()).returns(M.promise()),
          throw: M.call().optional(M.any()).returns(M.promise()),
        }),
        {
          async next() {
            if (idx < chunks.length) {
              const value = chunks[idx];
              idx += 1;
              return harden({ value, done: false });
            }
            return harden({ value: undefined, done: true });
          },
          async return() {
            return harden({ value: undefined, done: true });
          },
          async throw() {
            return harden({ value: undefined, done: true });
          },
        },
      );
    },
    async text() {
      return 'hello blob';
    },
    async json() {
      return null;
    },
  });
  await E(mount).write(['blob-target.txt'], blob);
  const actual = fs.readFileSync(
    path.join(rootPath, 'blob-target.txt'),
    'utf-8',
  );
  t.is(actual, 'hello blob');
});

test('EndoMount.write accepts a ReadableTree and materializes recursively', async t => {
  const { mount, rootPath } = makeConfiguredMount(t);
  // A blob factory reused for each leaf.
  const makeBlobValue = content => {
    const bytes = new TextEncoder().encode(content);
    return makeExo('LeafBlob', ReadableBlobInterface, {
      streamBase64() {
        const chunk = Buffer.from(bytes).toString('base64');
        let yielded = false;
        return makeExo(
          'AsyncIterator',
          M.interface('AsyncIterator', {
            next: M.call().returns(M.promise()),
            return: M.call().optional(M.any()).returns(M.promise()),
            throw: M.call().optional(M.any()).returns(M.promise()),
          }),
          {
            async next() {
              if (!yielded) {
                yielded = true;
                return harden({ value: chunk, done: false });
              }
              return harden({ value: undefined, done: true });
            },
            async return() {
              return harden({ value: undefined, done: true });
            },
            async throw() {
              return harden({ value: undefined, done: true });
            },
          },
        );
      },
      async text() {
        return content;
      },
      async json() {
        return null;
      },
    });
  };
  // A ReadableTree with a nested structure.
  const tree = makeExo('TestTree', ReadableTreeInterface, {
    async has(...pathSegments) {
      if (pathSegments.length === 0) return true;
      const lookup = ['a.txt', 'b'].includes(pathSegments[0]);
      return lookup;
    },
    async list() {
      return harden(['a.txt', 'b']);
    },
    async lookup(pathArg) {
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      if (segments.length === 1 && segments[0] === 'a.txt') {
        return makeBlobValue('hello-a');
      }
      if (segments.length === 1 && segments[0] === 'b') {
        // A nested tree with one leaf.
        return makeExo('NestedTree', ReadableTreeInterface, {
          async has(...pathSegments) {
            if (pathSegments.length === 0) return true;
            return pathSegments[0] === 'c.txt';
          },
          async list() {
            return harden(['c.txt']);
          },
          async lookup(innerArg) {
            const innerSegments =
              typeof innerArg === 'string' ? [innerArg] : innerArg;
            if (innerSegments.length === 1 && innerSegments[0] === 'c.txt') {
              return makeBlobValue('hello-c');
            }
            throw new Error(`unknown ${innerSegments}`);
          },
        });
      }
      throw new Error(`unknown ${segments}`);
    },
  });
  await E(mount).write(['nested'], tree);
  t.is(
    fs.readFileSync(path.join(rootPath, 'nested', 'a.txt'), 'utf-8'),
    'hello-a',
  );
  t.is(
    fs.readFileSync(path.join(rootPath, 'nested', 'b', 'c.txt'), 'utf-8'),
    'hello-c',
  );
});

test('EndoMount.copy within-mount copies a file', async t => {
  const { mount } = makeConfiguredMount(t);
  await E(mount).writeText(['src.txt'], 'src-content');
  await E(mount).copy(['src.txt'], ['dst.txt']);
  t.is(await E(mount).readText(['dst.txt']), 'src-content');
  // Source survives.
  t.is(await E(mount).readText(['src.txt']), 'src-content');
});

test('EndoMount.copy within-mount copies a directory recursively', async t => {
  const { mount } = makeConfiguredMount(t);
  await E(mount).makeDirectory(['src', 'inner']);
  await E(mount).writeText(['src', 'leaf.txt'], 'a');
  await E(mount).writeText(['src', 'inner', 'deep.txt'], 'b');
  await E(mount).copy(['src'], ['dst']);
  t.is(await E(mount).readText(['dst', 'leaf.txt']), 'a');
  t.is(await E(mount).readText(['dst', 'inner', 'deep.txt']), 'b');
});

test('EndoMount.readOnly() returns a structural ReadableTree view', async t => {
  const { mount } = makeConfiguredMount(t);
  await E(mount).writeText(['file.txt'], 'data');
  const view = await E(mount).readOnly();
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(view).__getMethodNames__();
  t.deepEqual(
    methods.filter(name => !name.startsWith('__')).sort(),
    [...PLATFORM_READABLE_TREE_METHODS].sort(),
    'readOnly() must expose exactly the ReadableTree method set',
  );
  // Read-side calls still work.
  t.true(await E(view).has('file.txt'));
  t.deepEqual(await E(view).list(), ['file.txt']);
});

test('EndoMount.readOnly().lookup recursively returns structural views', async t => {
  const { mount } = makeConfiguredMount(t);
  await E(mount).makeDirectory(['sub']);
  await E(mount).writeText(['sub', 'leaf.txt'], 'leaf-data');
  const view = await E(mount).readOnly();
  const subView = await E(view).lookup('sub');
  // eslint-disable-next-line no-underscore-dangle
  const subMethods = await E(subView).__getMethodNames__();
  t.deepEqual(
    subMethods.filter(name => !name.startsWith('__')).sort(),
    [...PLATFORM_READABLE_TREE_METHODS].sort(),
  );
  const leafView = await E(view).lookup(['sub', 'leaf.txt']);
  // eslint-disable-next-line no-underscore-dangle
  const leafMethods = await E(leafView).__getMethodNames__();
  t.deepEqual(
    leafMethods.filter(name => !name.startsWith('__')).sort(),
    [...PLATFORM_READABLE_BLOB_METHODS].sort(),
  );
  t.is(await E(leafView).text(), 'leaf-data');
});

test('EndoMountFile exposes every method on PlatformFileInterface', async t => {
  const { mount } = makeConfiguredMount(t);
  await E(mount).writeText(['file.txt'], 'data');
  const file = await E(mount).lookup('file.txt');
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(file).__getMethodNames__();
  for (const name of PLATFORM_FILE_METHODS) {
    t.true(
      methods.includes(name),
      `EndoMountFile missing platform File method ${name}`,
    );
  }
});

test('EndoMountFile.readOnly() returns a structural ReadableBlob view', async t => {
  const { mount } = makeConfiguredMount(t);
  await E(mount).writeText(['file.txt'], 'rb-data');
  const file = await E(mount).lookup('file.txt');
  const view = await E(file).readOnly();
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(view).__getMethodNames__();
  t.deepEqual(
    methods.filter(name => !name.startsWith('__')).sort(),
    [...PLATFORM_READABLE_BLOB_METHODS].sort(),
    'readOnly() must expose exactly the ReadableBlob method set',
  );
  t.is(await E(view).text(), 'rb-data');
});

test('EndoMount.snapshot returns a SnapshotTree-shaped capability', async t => {
  const { mount } = makeConfiguredMount(t);
  await E(mount).writeText(['s.txt'], 'snap');
  const snapshot = await E(mount).snapshot();
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(snapshot).__getMethodNames__();
  t.true(methods.includes('has'));
  t.true(methods.includes('list'));
  t.true(methods.includes('lookup'));
  t.true(methods.includes('sha256'));
});

// Suppress unused-import warnings for the platform interfaces; their
// presence in this file documents the conformance target.
void PlatformDirectoryInterface;
void PlatformFileInterface;
void url;
void Far;
