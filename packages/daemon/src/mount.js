// @ts-check
/// <reference types="ses"/>

/** @import { FilePowers } from './types.js' */

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { mountHelp, mountFileHelp, makeHelp } from './help-text.js';
import {
  MountInterface,
  MountFileInterface,
  MountEntryInterface,
} from './interfaces.js';
import { makeReaderRef } from './reader-ref.js';

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
 * @typedef {(remoteTree: unknown) => Promise<unknown>} CheckinTreeFn
 *   Walks a `ReadableTree`-shaped remote object, persists it via the daemon's
 *   content store, and returns a `SnapshotTree` exo (a `ReadableTree` with
 *   a content-addressed identity).  Threaded in by the formula instantiator
 *   so a mount can mint snapshots without taking a direct dependency on the
 *   daemon core.
 */

/**
 * Provenance maps for mount-scoped entry descriptors.  An entry minted by
 * one mount lineage carries a private sentinel that consumers can probe to
 * verify it was minted by an authorized mount.  Phase 2 records the keys;
 * Phase 3 adds the consumers that check them.
 *
 * @type {WeakMap<object, object>}
 */
const entryLineageKey = new WeakMap();
/** @type {WeakMap<object, object>} */
const mountLineageKey = new WeakMap();

/**
 * Test helper exposed for downstream consumers (Phase 3 mount nav, the
 * future git capability) — returns the lineage sentinel for a mount or
 * entry exo, or undefined if the value is not one we minted.
 *
 * @param {object} value
 * @returns {object | undefined}
 */
export const lineageOf = value => {
  return entryLineageKey.get(value) || mountLineageKey.get(value);
};
harden(lineageOf);

/**
 * Validate a segment for descriptor minting.  Stricter than
 * `assertValidSegment`: also rejects `.` and `..` so the descriptor's
 * normalized segments are exactly what the caller named.
 *
 * @param {string} segment
 */
const assertDescriptorSegment = segment => {
  assertValidSegment(segment);
  if (segment === '.' || segment === '..') {
    throw new Error(
      `Mount entry segment must not be ${q(segment)}; entry paths reject traversal rather than clamping`,
    );
  }
};
harden(assertDescriptorSegment);

/**
 * @typedef {object} EndoMountStat
 * @property {'file' | 'directory' | 'symlink'} kind
 * @property {number} [sizeBytes]
 * @property {number} [modifiedMs]
 */

/**
 * @typedef {object} MountContext
 * @property {string} currentDir
 * @property {string} confinementRoot
 * @property {boolean} readOnly
 * @property {FilePowers} filePowers
 * @property {string} description
 * @property {CheckinTreeFn} [checkin]
 * @property {object} [lineage]  Sentinel shared across a mount lineage
 *   (root mount + its lookup-derived sub-mounts + its readOnly attenuations).
 */

/**
 * Create a mount exo for a filesystem directory.
 *
 * @param {MountContext} ctx
 * @returns {object}
 */
const makeMountExo = ctx => {
  const { currentDir, confinementRoot, readOnly, filePowers, description } =
    ctx;
  // Every makeMountExo call shares its lineage sentinel with the caller
  // (lookup-derived sub-mounts and readOnly attenuations inherit) or, if
  // no lineage was passed in, mints a fresh one for this lineage's root.
  const lineage = ctx.lineage || harden({});

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

  const help = makeHelp(mountHelp);

  // Forward reference: snapshot() needs to pass the mount exo to the
  // checkin walker.  Assign `selfExo` immediately after `makeExo` returns;
  // the method closures resolve the binding lazily at call time.
  /** @type {object} */
  let selfExo;

  const exo = makeExo('EndoMount', MountInterface, {
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
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);

      const isDir = await filePowers.isDirectory(target);
      if (isDir) {
        return makeMountExo({
          ...ctx,
          currentDir: target,
          description: `Subdirectory of ${description}`,
          lineage,
        });
      }

      return makeMountFileExo(target, readOnly, filePowers, confinementRoot);
    },

    async readText(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      return filePowers.readFileText(target);
    },

    async maybeReadText(pathArg) {
      await null;
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
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
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      const parent = filePowers.joinPath(target, '..');
      await filePowers.makePath(parent);
      await filePowers.writeFileText(target, content);
    },

    async remove(pathArg) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfined(target, confinementRoot, filePowers);
      await filePowers.removePath(target);
    },

    async move(fromArg, toArg) {
      await null;
      assertWritable();
      const from = resolve(typeof fromArg === 'string' ? [fromArg] : fromArg);
      const to = resolve(typeof toArg === 'string' ? [toArg] : toArg);
      await assertConfined(from, confinementRoot, filePowers);
      await assertConfinedOrAncestor(to, confinementRoot, filePowers);
      await filePowers.renamePath(from, to);
    },

    async makeDirectory(pathArg) {
      await null;
      assertWritable();
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const target = resolve(segments);
      await assertConfinedOrAncestor(target, confinementRoot, filePowers);
      await filePowers.makePath(target);
    },

    entry(pathArg) {
      const rawSegments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      // Normalize segments once at minting time; reject traversal rather
      // than silently clamping.  Missing paths are fine — descriptors are
      // logical references, not handles.
      const normalized = harden([...rawSegments]);
      for (const segment of normalized) {
        assertDescriptorSegment(segment);
      }
      return makeMountEntryExo({
        segments: normalized,
        readOnly,
        confinementRoot,
        currentDir,
        filePowers,
        checkin: ctx.checkin,
        lineage,
      });
    },

    readOnly() {
      if (readOnly) {
        return this; // eslint-disable-line no-invalid-this
      }
      return makeMountExo({
        ...ctx,
        readOnly: true,
        description: `Read-only view of ${description}`,
        lineage,
      });
    },

    async snapshot() {
      if (!ctx.checkin) {
        throw new Error(
          'snapshot() requires a checkin function bound by the mount formula instantiator',
        );
      }
      // Capture is best-effort point-in-time: concurrent writers during the
      // traversal produce a valid snapshot, but not necessarily one taken from
      // a single filesystem instant.  The mount exo and its file exos already
      // satisfy ReadableTree/ReadableBlob, so the platform checkin walker can
      // ingest them directly.
      return ctx.checkin(selfExo);
    },
  });

  selfExo = exo;
  mountLineageKey.set(exo, lineage);
  return exo;
};
harden(makeMountExo);

/**
 * Create a mount-scoped entry descriptor.  Entries are logical references:
 * they may name a present, absent, or pending path inside the mount.  They
 * carry mount-lineage provenance so future consumers can verify the entry
 * was minted by an authorized mount.
 *
 * @param {object} args
 * @param {readonly string[]} args.segments  Normalized relative segments.
 * @param {boolean} args.readOnly  True if the minting mount was read-only.
 * @param {string} args.confinementRoot
 * @param {string} args.currentDir  The minting mount's effective root.
 * @param {FilePowers} args.filePowers
 * @param {CheckinTreeFn} [args.checkin]
 * @param {object} args.lineage
 * @returns {object}
 */
const makeMountEntryExo = ({
  segments,
  readOnly,
  confinementRoot,
  currentDir,
  filePowers,
  checkin,
  lineage,
}) => {
  // Resolve the entry's physical path once; subsequent operations confine
  // again at use time to defend against TOCTOU symlink shuffling.
  const resolved = resolveSegments(
    currentDir,
    confinementRoot,
    [...segments],
    filePowers,
  );

  const displayPath = segments.length === 0 ? '.' : segments.join('/');

  const entryExo = makeExo('EndoMountEntry', MountEntryInterface, {
    segments() {
      return harden([...segments]);
    },

    displayPath() {
      return displayPath;
    },

    async exists() {
      await null;
      return filePowers.exists(resolved);
    },

    async stat() {
      await null;
      const present = await filePowers.exists(resolved);
      if (!present) {
        return undefined;
      }
      // filePowers exposes isDirectory but not a richer stat surface yet;
      // size and modified-time fields are intentionally omitted in this
      // phase per the EndoMountStat shape (both are optional).
      const isDir = await filePowers.isDirectory(resolved);
      return harden({ kind: isDir ? 'directory' : 'file' });
    },

    async lookup() {
      await null;
      await assertConfined(resolved, confinementRoot, filePowers);
      const isDir = await filePowers.isDirectory(resolved);
      if (isDir) {
        return makeMountExo({
          currentDir: resolved,
          confinementRoot,
          readOnly,
          filePowers,
          description: `Mount at ${displayPath}`,
          checkin,
          lineage,
        });
      }
      return makeMountFileExo(resolved, readOnly, filePowers, confinementRoot);
    },

    async openFile() {
      await null;
      await assertConfined(resolved, confinementRoot, filePowers);
      const isDir = await filePowers.isDirectory(resolved);
      if (isDir) {
        throw new Error(
          `Entry ${q(displayPath)} is a directory; use openDirectory()`,
        );
      }
      // The entry's read-only bit propagates to the minted file handle so
      // an entry from a readOnly() mount cannot be used to write.
      return makeMountFileExo(resolved, readOnly, filePowers, confinementRoot);
    },

    async openDirectory() {
      await null;
      await assertConfined(resolved, confinementRoot, filePowers);
      const isDir = await filePowers.isDirectory(resolved);
      if (!isDir) {
        throw new Error(
          `Entry ${q(displayPath)} is not a directory; use openFile() or lookup()`,
        );
      }
      return makeMountExo({
        currentDir: resolved,
        confinementRoot,
        readOnly,
        filePowers,
        description: `Mount at ${displayPath}`,
        checkin,
        lineage,
      });
    },

    child(name) {
      assertDescriptorSegment(name);
      return makeMountEntryExo({
        segments: harden([...segments, name]),
        readOnly,
        confinementRoot,
        currentDir,
        filePowers,
        checkin,
        lineage,
      });
    },
  });

  entryLineageKey.set(entryExo, lineage);
  return entryExo;
};
harden(makeMountEntryExo);

/**
 * Create a transient file exo for a file within a mount.
 *
 * @param {string} filePath
 * @param {boolean} readOnly
 * @param {FilePowers} filePowers
 * @param {string} confinementRoot
 * @returns {object}
 */
const makeMountFileExo = (filePath, readOnly, filePowers, confinementRoot) => {
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
      // ReadableBlob.streamBase64 yields base64-encoded chunks; the platform
      // checkin walker decodes them back into bytes.  makeReaderRef adapts
      // a raw byte reader into a base64 string iterator.
      const reader = filePowers.makeFileReader(filePath);
      return makeReaderRef(reader);
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

    readOnly() {
      return makeMountFileExo(filePath, true, filePowers, confinementRoot);
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
 * @param {CheckinTreeFn} [opts.checkin]
 * @returns {object}
 */
export const makeMount = ({ rootPath, readOnly, filePowers, checkin }) => {
  const prefix = readOnly ? 'Read-only mount' : 'Mount';
  /** @type {MountContext} */
  const ctx = {
    currentDir: rootPath,
    confinementRoot: rootPath,
    readOnly,
    filePowers,
    description: `${prefix} at ${rootPath}`,
    checkin,
  };

  return makeMountExo(ctx);
};
harden(makeMount);
