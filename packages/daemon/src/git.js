// @ts-check
/// <reference types="ses"/>

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { GitInterface } from './interfaces.js';

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
  return makeExo('Git', GitInterface, {
    worktree() {
      return mount;
    },

    async status() {
      return backend.status();
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
      // Phase 1: the backend wiring is in place but the entry-to-path
      // resolver lives in Phase 2 (it consults the host-private mount
      // backing to translate `EndoMountEntry` values into the absolute
      // paths the native backend ultimately receives).  Until then,
      // surface a clear "not implemented" rather than passing entries
      // straight through.
      throw new Error(
        `Git.add is not yet implemented (received ${q(entries.length)} entries)`,
      );
    },

    async restore(entries, options = {}) {
      throw new Error(
        `Git.restore is not yet implemented (received ${q(entries.length)} entries, options=${q(options)})`,
      );
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
