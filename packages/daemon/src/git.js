// @ts-check
/// <reference types="ses"/>

import { q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';

import { GitInterface } from './interfaces.js';
import { lineageOf } from './mount.js';

/**
 * @typedef {object} GitRef
 * @property {string} name
 * @property {'branch' | 'tag' | 'commit' | 'detached'} kind
 * @property {string} [oid]
 */

/**
 * @typedef {object} GitCommit
 * @property {string} oid
 * @property {string} summary
 * @property {string} [author]
 * @property {number} [committedAt]
 */

/**
 * @typedef {(
 *   | 'clean'
 *   | 'added'
 *   | 'modified'
 *   | 'deleted'
 *   | 'renamed'
 *   | 'copied'
 *   | 'conflicted'
 * )} GitIndexStatus
 */

/**
 * @typedef {(
 *   | 'clean'
 *   | 'modified'
 *   | 'deleted'
 *   | 'untracked'
 *   | 'ignored'
 *   | 'conflicted'
 * )} GitWorktreeStatus
 */

/**
 * @typedef {object} GitStatusEntry
 * @property {object} entry  An `EndoMountEntry` for the path.  The entry is
 *   the authority-bearing reference; `path` is presentation data only.
 * @property {string} path
 * @property {GitIndexStatus} index
 * @property {GitWorktreeStatus} worktree
 * @property {object} [node]  Present when a live worktree object currently
 *   exists for the path (an `EndoMountFile` or `EndoMount` sub-mount).
 */

/**
 * @typedef {object} GitDiffOptions
 * @property {boolean} [cached]
 * @property {GitRef | string} [base]
 * @property {GitRef | string} [head]
 * @property {object[]} [entries]
 */

/**
 * @typedef {object} GitLogOptions
 * @property {number} [maxCount]
 * @property {GitRef | string} [ref]
 */

/**
 * Backend-facing contract.  Concrete backends (native git, future JS git
 * libraries, daemon-native commit storage) translate the structured
 * operations into their implementation-specific calls.  All path-bearing
 * inputs are pre-resolved to host-absolute strings by the public Git exo
 * before reaching the backend, so a backend never sees an unauthenticated
 * relative path or an unresolved `EndoMountEntry`.
 *
 * Phase 1 declares the contract; later phases implement the methods.
 *
 * @typedef {object} GitBackend
 * @property {() => Promise<void>} assertRepositoryRoot  Verifies the mount
 *   root is exactly a git worktree root (e.g. `git rev-parse --show-toplevel`
 *   equals the root).  Called by `provideGit` at formula instantiation.
 * @property {() => Promise<unknown[]>} status
 * @property {(opts: object) => Promise<string>} diff
 * @property {(opts: object) => Promise<GitCommit[]>} log
 * @property {(ref: string) => Promise<string>} show
 * @property {(ref: string) => Promise<GitRef>} revParse
 * @property {(paths: string[]) => Promise<void>} add
 * @property {(paths: string[], opts: { staged?: boolean }) => Promise<void>} restore
 * @property {(message: string) => Promise<GitCommit>} commit
 * @property {() => Promise<GitRef | undefined>} currentBranch
 * @property {() => Promise<GitRef[]>} branches
 * @property {(name: string, opts: object) => Promise<GitRef>} createBranch
 * @property {(name: string, opts: { force?: boolean }) => Promise<void>} deleteBranch
 * @property {(from: string, to: string) => Promise<void>} renameBranch
 * @property {(ref: string) => Promise<void>} switch
 * @property {(ref: string, opts: object) => Promise<string>} merge
 * @property {(input: object) => Promise<string>} rebase
 * @property {(opts: object) => Promise<string>} stashPush
 * @property {() => Promise<string[]>} stashList
 * @property {(index: number | undefined) => Promise<string>} stashShow
 * @property {(index: number | undefined) => Promise<void>} stashApply
 * @property {(index: number | undefined) => Promise<void>} stashPop
 * @property {(index: number | undefined) => Promise<void>} stashDrop
 * @property {(ref: string) => Promise<unknown>} tree  Returns a
 *   `ReadableTree` exo for the given tree-ish; blobs implement
 *   `ReadableBlob`.
 */

/**
 * Construct the public Git capability exo.  Phase 1: methods are wired
 * to a backend but every backend method throws "not yet implemented"
 * until Phases 2-5 land them.  This commit establishes only the shape
 * and the authority boundary (the mount cap carries the public worktree
 * authority; the host-private backing grant the formula instantiator
 * used to derive this capability is not part of the public surface).
 *
 * @param {object} args
 * @param {object} args.mount  The `EndoMount` that carries the public
 *   worktree authority.  Returned by `worktree()`.
 * @param {GitBackend} args.backend
 * @returns {object}
 */
export const makeGit = ({ mount, backend }) => {
  // The mount's lineage sentinel — used to verify that every entry
  // passed to a path-bearing Git method was minted by this Git's bound
  // mount, not by some other mount this guest may also hold.
  const mountLineage = lineageOf(mount);

  /**
   * Translate an array of EndoMountEntry caps into the repo-relative
   * path strings that the backend (and the underlying git binary)
   * accept.  Entries from a different mount lineage are rejected
   * before any path is exposed to git.
   *
   * @param {readonly object[]} entries
   * @returns {Promise<string[]>}
   */
  const entriesToRepoPaths = async entries => {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(
        'entries must be a non-empty array of EndoMountEntry values',
      );
    }
    const paths = [];
    for (const entry of entries) {
      const otherLineage = lineageOf(/** @type {object} */ (entry));
      if (otherLineage === undefined) {
        throw new Error(
          'entry is not an EndoMountEntry minted by this daemon',
        );
      }
      if (otherLineage !== mountLineage) {
        throw new Error(
          'entry was minted by a different mount lineage and cannot be used here',
        );
      }
      // eslint-disable-next-line no-await-in-loop
      const segments = await E(entry).segments();
      paths.push(segments.join('/'));
    }
    return paths;
  };

  return makeExo('Git', GitInterface, {
    worktree() {
      return mount;
    },

    async status() {
      const raw = await backend.status();
      // Wrap each raw record into a GitStatusEntry.  The backend
      // produced repo-relative path strings; here we mint the
      // authority-bearing EndoMountEntry through the bound mount so
      // a caller can hold a path-bearing reference that's confined
      // to this worktree.
      const wrapped = await Promise.all(
        raw.map(async r => {
          const segments = r.path === '' ? [] : r.path.split('/');
          const entry = await E(mount).entry(segments);
          return harden({
            entry,
            path: r.path,
            index: r.index,
            worktree: r.worktree,
            ...(r.renamedFrom !== undefined
              ? { renamedFrom: r.renamedFrom }
              : {}),
          });
        }),
      );
      return harden(wrapped);
    },

    async diff(options = {}) {
      return backend.diff(options);
    },

    async log(options = {}) {
      return backend.log(options);
    },

    async show(ref) {
      return backend.show(typeof ref === 'string' ? ref : ref.name);
    },

    async revParse(ref) {
      return backend.revParse(typeof ref === 'string' ? ref : ref.name);
    },

    async add(entries) {
      const paths = await entriesToRepoPaths(entries);
      return backend.add(paths);
    },

    async restore(entries, options = {}) {
      const paths = await entriesToRepoPaths(entries);
      return backend.restore(paths, options);
    },

    async commit(message) {
      return backend.commit(message);
    },

    async currentBranch() {
      return backend.currentBranch();
    },

    async branches() {
      return backend.branches();
    },

    async createBranch(name, options = {}) {
      return backend.createBranch(name, options);
    },

    async deleteBranch(name, options = {}) {
      return backend.deleteBranch(name, options);
    },

    async renameBranch(from, to) {
      return backend.renameBranch(from, to);
    },

    async switch(ref) {
      return backend.switch(typeof ref === 'string' ? ref : ref.name);
    },

    async merge(ref, options = {}) {
      return backend.merge(typeof ref === 'string' ? ref : ref.name, options);
    },

    async rebase(input) {
      return backend.rebase(input);
    },

    async stashPush(options = {}) {
      return backend.stashPush(options);
    },

    async stashList() {
      return backend.stashList();
    },

    async stashShow(index) {
      return backend.stashShow(index);
    },

    async stashApply(index) {
      return backend.stashApply(index);
    },

    async stashPop(index) {
      return backend.stashPop(index);
    },

    async stashDrop(index) {
      return backend.stashDrop(index);
    },

    async tree(ref) {
      return backend.tree(typeof ref === 'string' ? ref : ref.name);
    },
  });
};
harden(makeGit);

/**
 * Phase 1 stub backend.  Every method throws "not yet implemented".
 * Phase 2 replaces this with `makeNativeGitBackend` which runs the
 * sanitized git binary in a confined environment derived from the
 * fae-git-tool-reference work.
 *
 * @returns {GitBackend}
 */
export const makeNotYetImplementedBackend = () => {
  const fail = name => {
    throw new Error(`Git backend method ${q(name)} is not yet implemented`);
  };
  return harden({
    assertRepositoryRoot: async () => undefined,
    status: async () => fail('status'),
    diff: async () => fail('diff'),
    log: async () => fail('log'),
    show: async () => fail('show'),
    revParse: async () => fail('revParse'),
    add: async () => fail('add'),
    restore: async () => fail('restore'),
    commit: async () => fail('commit'),
    currentBranch: async () => fail('currentBranch'),
    branches: async () => fail('branches'),
    createBranch: async () => fail('createBranch'),
    deleteBranch: async () => fail('deleteBranch'),
    renameBranch: async () => fail('renameBranch'),
    switch: async () => fail('switch'),
    merge: async () => fail('merge'),
    rebase: async () => fail('rebase'),
    stashPush: async () => fail('stashPush'),
    stashList: async () => fail('stashList'),
    stashShow: async () => fail('stashShow'),
    stashApply: async () => fail('stashApply'),
    stashPop: async () => fail('stashPop'),
    stashDrop: async () => fail('stashDrop'),
    tree: async () => fail('tree'),
  });
};
harden(makeNotYetImplementedBackend);
