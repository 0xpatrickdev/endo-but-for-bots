// @ts-check
/// <reference types="ses"/>

/** @import { FilePowers } from './types.js' */

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { mountHelp, mountFileHelp, makeHelp } from './help-text.js';
import {
  MountEntryInterface,
  MountFileInterface,
  MountInterface,
} from './interfaces.js';
import { makeIteratorRef } from './reader-ref.js';

const mountEntryRecords = new WeakMap();

/**
 * Validate a single path segment.
 * Rejects '/', '\', '\0', and empty strings.
 *
 * @param {string} segment
 */
const assertValidSegment = segment => {
  if (typeof segment !== 'string') {
    throw new Error(`Path segment must be a string, got ${q(typeof segment)}`);
  }
  if (segment === '') {
    throw new Error('Path segment must not be empty');
  }
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(
      `Path segment must not contain '/', '\\', or '\\0': ${q(segment)}`,
    );
  }
};
harden(assertValidSegment);

/**
 * Resolve path segments relative to a current directory, clamped to a
 * confinement root.  '.' skips, '..' pops (clamped at root).
 *
 * @param {string} currentDir
 * @param {string} confinementRoot
 * @param {string[]} segments
 * @param {FilePowers} filePowers
 * @returns {string}
 */
const resolveSegments = (currentDir, confinementRoot, segments, filePowers) => {
  let resolved = currentDir;
  for (const segment of segments) {
    if (segment === '.') {
      // skip
    } else if (segment === '..') {
      const parent = filePowers.joinPath(resolved, '..');
      if (parent.length >= confinementRoot.length) {
        resolved = parent;
      } else {
        resolved = confinementRoot;
      }
    } else {
      assertValidSegment(segment);
      resolved = filePowers.joinPath(resolved, segment);
    }
  }
  return resolved;
};
harden(resolveSegments);

/**
 * Normalize path segments against a mount-relative base, clamping '..' at root.
 *
 * @param {string[]} baseSegments
 * @param {string[]} segments
 * @returns {string[]}
 */
const normalizeSegments = (baseSegments, segments) => {
  const normalized = [...baseSegments];
  for (const segment of segments) {
    if (segment === '.') {
      // skip
    } else if (segment === '..') {
      normalized.pop();
    } else {
      assertValidSegment(segment);
      normalized.push(segment);
    }
  }
  return normalized;
};
harden(normalizeSegments);

/**
 * Assert that a resolved path is contained within the confinement root.
 *
 * @param {string} candidatePath
 * @param {string} confinementRoot
 * @param {FilePowers} filePowers
 */
const assertConfined = async (candidatePath, confinementRoot, filePowers) => {
  let resolved;
  try {
    resolved = await filePowers.realPath(candidatePath);
  } catch {
    throw new Error(
      `Path does not exist and cannot be verified: ${q(candidatePath)}`,
    );
  }
  const rootResolved = await filePowers.realPath(confinementRoot);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}/`)) {
    throw new Error(`Path escapes mount root: ${q(candidatePath)}`);
  }
};
harden(assertConfined);

/**
 * Check confinement of a path that may not exist yet.
 * Walks up to find the deepest existing ancestor.
 *
 * @param {string} candidatePath
 * @param {string} confinementRoot
 * @param {FilePowers} filePowers
 */
const assertConfinedOrAncestor = async (
  candidatePath,
  confinementRoot,
  filePowers,
) => {
  const rootResolved = await filePowers.realPath(confinementRoot);
  let check = candidatePath;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resolved = await filePowers.realPath(check);
      if (
        resolved !== rootResolved &&
        !resolved.startsWith(`${rootResolved}/`)
      ) {
        throw new Error(`Path escapes mount root: ${q(candidatePath)}`);
      }
      return;
    } catch (/** @type {any} */ e) {
      if (e.message && e.message.startsWith('Path escapes')) {
        throw e;
      }
      const parent = filePowers.joinPath(check, '..');
      if (parent === check) {
        throw new Error(`Path escapes mount root: ${q(candidatePath)}`);
      }
      check = parent;
    }
  }
};
harden(assertConfinedOrAncestor);

/**
 * Check if a path is confined (returns boolean, does not throw).
 *
 * @param {string} candidatePath
 * @param {string} confinementRoot
 * @param {FilePowers} filePowers
 * @returns {Promise<boolean>}
 */
const isConfinedPath = async (candidatePath, confinementRoot, filePowers) => {
  try {
    const resolved = await filePowers.realPath(candidatePath);
    const rootResolved = await filePowers.realPath(confinementRoot);
    return resolved === rootResolved || resolved.startsWith(`${rootResolved}/`);
  } catch {
    return false;
  }
};
harden(isConfinedPath);

/**
 * @typedef {object} MountContext
 * @property {string} currentDir
 * @property {string[]} currentSegments
 * @property {string} confinementRoot
 * @property {object} rootId
 * @property {boolean} readOnly
 * @property {FilePowers} filePowers
 * @property {string} description
 * @property {(tree: object) => Promise<object>} [snapshotTree]
 * @property {(path: string) => Promise<object>} [snapshotFile]
 */

/**
 * Create a mount exo for a filesystem directory.
 *
 * @param {MountContext} ctx
 * @returns {object}
 */
const makeMountExo = ctx => {
  const {
    currentDir,
    currentSegments,
    confinementRoot,
    rootId,
    readOnly,
    filePowers,
    description,
    snapshotTree,
    snapshotFile,
  } = ctx;

  const assertWritable = () => {
    if (readOnly) {
      throw new Error('Mount is read-only');
    }
  };

  /**
   * @param {string[]} segments
   * @returns {string}
   */
  const resolve = segments =>
    resolveSegments(currentDir, confinementRoot, segments, filePowers);

  /**
   * Resolve mount-root-relative segments.
   *
   * @param {string[]} segments
   */
  const resolveFromRoot = segments =>
    resolveSegments(confinementRoot, confinementRoot, segments, filePowers);

  /**
   * @param {string | string[] | object} pathArg
   * @returns {string[]}
   */
  const segmentsFromPathArg = pathArg => {
    if (Array.isArray(pathArg)) {
      return normalizeSegments(currentSegments, pathArg);
    }
    if (typeof pathArg === 'object' && pathArg !== null) {
      const record = mountEntryRecords.get(pathArg);
      if (record === undefined) {
        throw new Error('Path argument is not a daemon-minted mount entry');
      }
      if (record.rootId !== rootId) {
        throw new Error('Mount entry belongs to a different mount root');
      }
      return record.segments;
    }
    if (typeof pathArg !== 'string') {
      throw new Error(`Path must be a string, array, or mount entry`);
    }
    return normalizeSegments(currentSegments, [pathArg]);
  };

  /**
   * @param {string | string[] | object} pathArg
   */
  const resolvePathArg = pathArg =>
    resolveFromRoot(segmentsFromPathArg(pathArg));

  /**
   * @param {string} target
   * @param {string[]} targetSegments
   */
  const openExisting = async (target, targetSegments) => {
    await assertConfined(target, confinementRoot, filePowers);
    const isDir = await filePowers.isDirectory(target);
    if (isDir) {
      return makeMountExo({
        ...ctx,
        currentDir: target,
        currentSegments: targetSegments,
        description: `Subdirectory of ${description}`,
      });
    }
    return makeMountFileExo(
      target,
      readOnly,
      filePowers,
      confinementRoot,
      snapshotFile,
    );
  };

  /**
   * @param {string[]} segments
   */
  const makeEntry = segments => {
    const entry = makeMountEntryExo({
      ...ctx,
      entrySegments: segments,
    });
    mountEntryRecords.set(entry, harden({ rootId, segments }));
    return entry;
  };

  const help = makeHelp(mountHelp);

  return makeExo('EndoMount', MountInterface, {
    help,

    async has(...pathSegments) {
      await null;
      if (pathSegments.length === 0) {
        return true;
      }
      const target = resolve(pathSegments);
      const pathExists = await filePowers.exists(target);
      if (!pathExists) {
        return false;
      }
      return isConfinedPath(target, confinementRoot, filePowers);
    },

    async list(...pathSegments) {
      await null;
      const target = resolve(pathSegments);
      await assertConfined(target, confinementRoot, filePowers);
      const entries = await filePowers.readDirectory(target);
      const confined = [];
      for (const entry of entries.sort()) {
        const entryPath = filePowers.joinPath(target, entry);
        // eslint-disable-next-line no-await-in-loop
        if (await isConfinedPath(entryPath, confinementRoot, filePowers)) {
          confined.push(entry);
        }
      }
      return harden(confined);
    },

    async lookup(pathArg) {
      await null;
      const segments = segmentsFromPathArg(pathArg);
      return openExisting(resolveFromRoot(segments), segments);
    },

    entry(pathArg) {
      const pathSegments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      return makeEntry(normalizeSegments(currentSegments, pathSegments));
    },

    async openDirectory(pathArg) {
      await null;
      const segments = segmentsFromPathArg(pathArg);
      const target = resolveFromRoot(segments);
      await assertConfined(target, confinementRoot, filePowers);
      const isDir = await filePowers.isDirectory(target);
      if (!isDir) {
        throw new Error(`Path is not a directory: ${q(segments.join('/'))}`);
      }
      return makeMountExo({
        ...ctx,
        currentDir: target,
        currentSegments: segments,
        description: `Subdirectory of ${description}`,
      });
    },

    async openFile(pathArg) {
      await null;
      const target = resolvePathArg(pathArg);
      await assertConfined(target, confinementRoot, filePowers);
      const isDir = await filePowers.isDirectory(target);
      if (isDir) {
        throw new Error('Path is a directory');
      }
      return makeMountFileExo(
        target,
        readOnly,
        filePowers,
        confinementRoot,
        snapshotFile,
      );
    },

    async createDirectory(pathArg) {
      await null;
      assertWritable();
      const segments = segmentsFromPathArg(pathArg);
      const target = resolveFromRoot(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      await filePowers.makePath(target);
      return makeMountExo({
        ...ctx,
        currentDir: target,
        currentSegments: segments,
        description: `Subdirectory of ${description}`,
      });
    },

    async createFile(pathArg) {
      await null;
      assertWritable();
      const target = resolvePathArg(pathArg);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      const parent = filePowers.joinPath(target, '..');
      await filePowers.makePath(parent);
      if (await filePowers.isDirectory(target)) {
        throw new Error('Path is a directory');
      }
      if (!(await filePowers.exists(target))) {
        await filePowers.writeFileText(target, '');
      }
      return makeMountFileExo(
        target,
        readOnly,
        filePowers,
        confinementRoot,
        snapshotFile,
      );
    },

    async stat(pathArg) {
      await null;
      const target = resolvePathArg(pathArg);
      try {
        await assertConfined(target, confinementRoot, filePowers);
        return filePowers.statPath(target);
      } catch {
        return undefined;
      }
    },

    async readText(pathArg) {
      await null;
      const target = resolvePathArg(pathArg);
      await assertConfined(target, confinementRoot, filePowers);
      return filePowers.readFileText(target);
    },

    async maybeReadText(pathArg) {
      await null;
      const target = resolvePathArg(pathArg);
      try {
        await assertConfined(target, confinementRoot, filePowers);
        return await filePowers.readFileText(target);
      } catch {
        return undefined;
      }
    },

    async writeText(pathArg, content) {
      await null;
      assertWritable();
      const target = resolvePathArg(pathArg);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      const parent = filePowers.joinPath(target, '..');
      await filePowers.makePath(parent);
      await filePowers.writeFileText(target, content);
    },

    async remove(pathArg) {
      await null;
      assertWritable();
      const target = resolvePathArg(pathArg);
      await assertConfined(target, confinementRoot, filePowers);
      await filePowers.removePath(target);
    },

    async move(fromArg, toArg) {
      await null;
      assertWritable();
      const from = resolvePathArg(fromArg);
      const to = resolvePathArg(toArg);
      await assertConfined(from, confinementRoot, filePowers);
      await assertConfinedOrAncestor(to, confinementRoot, filePowers);
      await filePowers.renamePath(from, to);
    },

    async makeDirectory(pathArg) {
      await null;
      assertWritable();
      await this.self.createDirectory(pathArg); // eslint-disable-line no-invalid-this
    },

    readOnly() {
      if (readOnly) {
        return this.self; // eslint-disable-line no-invalid-this
      }
      return makeMountExo({
        ...ctx,
        readOnly: true,
        description: `Read-only view of ${description}`,
      });
    },

    async snapshot() {
      if (snapshotTree === undefined) {
        throw new Error('snapshot() is not available for this mount');
      }
      return snapshotTree(this.self); // eslint-disable-line no-invalid-this
    },
  });
};
harden(makeMountExo);

/**
 * Create a mount-scoped logical entry descriptor.
 *
 * @param {MountContext & { entrySegments: string[] }} ctx
 * @returns {object}
 */
const makeMountEntryExo = ctx => {
  const {
    entrySegments,
    confinementRoot,
    rootId,
    filePowers,
    snapshotFile,
  } = ctx;

  const resolveEntry = () =>
    resolveSegments(confinementRoot, confinementRoot, entrySegments, filePowers);

  const help = makeHelp({});

  return makeExo('EndoMountEntry', MountEntryInterface, {
    help,
    path() {
      return harden([...entrySegments]);
    },
    displayPath() {
      return entrySegments.length === 0 ? '.' : entrySegments.join('/');
    },
    async stat() {
      await null;
      const target = resolveEntry();
      try {
        await assertConfined(target, confinementRoot, filePowers);
        return filePowers.statPath(target);
      } catch {
        return undefined;
      }
    },
    async lookup() {
      await null;
      const target = resolveEntry();
      await assertConfined(target, confinementRoot, filePowers);
      if (await filePowers.isDirectory(target)) {
        return makeMountExo({
          ...ctx,
          currentDir: target,
          currentSegments: entrySegments,
          description: `Subdirectory ${entrySegments.join('/')}`,
        });
      }
      return makeMountFileExo(
        target,
        ctx.readOnly,
        filePowers,
        confinementRoot,
        snapshotFile,
      );
    },
    async openDirectory() {
      const value = await this.self.lookup(); // eslint-disable-line no-invalid-this
      const methods =
        // eslint-disable-next-line no-underscore-dangle
        await value.__getMethodNames__();
      if (!methods.includes('list')) {
        throw new Error(`Path is not a directory: ${q(entrySegments.join('/'))}`);
      }
      return value;
    },
    async openFile() {
      const value = await this.self.lookup(); // eslint-disable-line no-invalid-this
      const methods =
        // eslint-disable-next-line no-underscore-dangle
        await value.__getMethodNames__();
      if (!methods.includes('text')) {
        throw new Error('Path is a directory');
      }
      return value;
    },
    child(name) {
      assertValidSegment(name);
      const child = makeMountEntryExo({
        ...ctx,
        entrySegments: [...entrySegments, name],
      });
      mountEntryRecords.set(
        child,
        harden({ rootId, segments: [...entrySegments, name] }),
      );
      return child;
    },
  });
};
harden(makeMountEntryExo);

/**
 * Create a transient file exo for a file within a mount.
 *
 * @param {string} filePath
 * @param {boolean} readOnly
 * @param {FilePowers} filePowers
 * @param {string} confinementRoot
 * @param {(path: string) => Promise<object>} [snapshotFile]
 * @returns {object}
 */
const makeMountFileExo = (
  filePath,
  readOnly,
  filePowers,
  confinementRoot,
  snapshotFile = undefined,
) => {
  const assertWritable = () => {
    if (readOnly) {
      throw new Error('Mount is read-only');
    }
  };

  const help = makeHelp(mountFileHelp);

  return makeExo('EndoMountFile', MountFileInterface, {
    help,

    async text() {
      await null;
      await assertConfined(filePath, confinementRoot, filePowers);
      return filePowers.readFileText(filePath);
    },

    streamBase64() {
      const reader = filePowers.makeFileReader(filePath);
      return makeIteratorRef(reader);
    },

    async json() {
      await null;
      const text = await filePowers.readFileText(filePath);
      return JSON.parse(text);
    },

    async writeText(content) {
      await null;
      assertWritable();
      await assertConfined(filePath, confinementRoot, filePowers);
      await filePowers.writeFileText(filePath, content);
    },

    async appendText(content) {
      await null;
      assertWritable();
      await assertConfined(filePath, confinementRoot, filePowers);
      await filePowers.appendFileText(filePath, content);
    },

    async writeBytes(readableRef) {
      await null;
      assertWritable();
      await assertConfined(filePath, confinementRoot, filePowers);
      const writer = filePowers.makeFileWriter(filePath);
      const iterator = /** @type {AsyncIterator<Uint8Array>} */ (readableRef);
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await iterator.next();
        if (done) break;
        // eslint-disable-next-line no-await-in-loop
        await writer.next(value);
      }
      await writer.return(undefined);
    },

    async stat() {
      await null;
      await assertConfined(filePath, confinementRoot, filePowers);
      return filePowers.statPath(filePath);
    },

    async snapshot() {
      if (snapshotFile === undefined) {
        throw new Error('snapshot() is not available for this mount file');
      }
      await assertConfined(filePath, confinementRoot, filePowers);
      return snapshotFile(filePath);
    },

    readOnly() {
      return makeMountFileExo(
        filePath,
        true,
        filePowers,
        confinementRoot,
        snapshotFile,
      );
    },
  });
};
harden(makeMountFileExo);

/**
 * Create a mount exo backed by a filesystem directory.
 *
 * @param {object} opts
 * @param {string} opts.rootPath
 * @param {boolean} opts.readOnly
 * @param {FilePowers} opts.filePowers
 * @param {(tree: object) => Promise<object>} [opts.snapshotTree]
 * @param {(path: string) => Promise<object>} [opts.snapshotFile]
 * @returns {object}
 */
export const makeMount = ({
  rootPath,
  readOnly,
  filePowers,
  snapshotTree = undefined,
  snapshotFile = undefined,
}) => {
  const prefix = readOnly ? 'Read-only mount' : 'Mount';
  /** @type {MountContext} */
  const ctx = {
    currentDir: rootPath,
    currentSegments: harden([]),
    confinementRoot: rootPath,
    rootId: harden({}),
    readOnly,
    filePowers,
    description: `${prefix} at ${rootPath}`,
    snapshotTree,
    snapshotFile,
  };

  return makeMountExo(ctx);
};
harden(makeMount);
