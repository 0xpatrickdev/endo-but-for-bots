// @ts-check
/// <reference types="ses"/>

import { q } from '@endo/errors';
import { makeExo } from '@endo/exo';

import {
  GitRemoteInterface,
  GitRemoteControllerInterface,
} from './interfaces.js';

/**
 * @typedef {'fetch' | 'push'} GitDirection
 */

/**
 * @typedef {object} GitRemotePolicy
 * @property {string} url
 *   Host-controlled remote endpoint URL.  Guests cannot mutate this
 *   field at call time; only `GitRemoteController.revoke()` or future
 *   controller methods adjust the binding.
 * @property {GitDirection[]} allowedDirections
 * @property {string[]} fetchRefspecs
 * @property {string[]} pushRefspecs
 * @property {string[]} [allowedBranches]
 * @property {boolean} [allowForcePush]
 * @property {boolean} [allowTags]
 * @property {boolean} [allowDelete]
 */

const DEFAULT_POLICY = harden(
  /** @type {Required<Omit<GitRemotePolicy, 'allowedBranches' | 'url'>>} */ ({
    allowedDirections: harden(['fetch']),
    fetchRefspecs: harden([]),
    pushRefspecs: harden([]),
    allowForcePush: false,
    allowTags: false,
    allowDelete: false,
  }),
);

/**
 * Host-private map from a remote exo to its controller exo.  Phase 1
 * keeps the controller as a companion accessed through a daemon-side
 * host method (`getGitRemoteController`) rather than a separate
 * top-level formula.  Phase 2+ may promote the controller to its own
 * formula so it can be persisted with its own pet name.
 *
 * @type {WeakMap<object, object>}
 */
const remoteControllers = new WeakMap();

/**
 * Host-private accessor: returns the controller exo paired with a
 * daemon-minted remote exo, or undefined for spoofs / fakes.
 *
 * @param {unknown} remote
 * @returns {object | undefined}
 */
export const getGitRemoteController = remote =>
  remoteControllers.get(/** @type {object} */ (remote));
harden(getGitRemoteController);

/**
 * Mint a paired (guest-held, host-held) facet for one remote endpoint.
 *
 * Phase 1: every operation that would talk to the network surfaces
 * "not yet implemented".  The structural shape — bounded
 * remote-use authority, controller-held policy mutation, revocation
 * — is fully in place so subsequent commits land transport without
 * changing the public boundaries.
 *
 * @param {object} args
 * @param {object} args.git  The local `Git` capability this remote is
 *   bound to.  Guest operations on the remote always compose with this
 *   Git; revoking the local Git collects the remote too.
 * @param {string} args.name  Remote name (typically 'origin').
 * @param {GitRemotePolicy} args.policy
 * @returns {{ remote: object, controller: object }}
 */
export const makeGitRemote = ({ git, name, policy }) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('GitRemote name must be a non-empty string');
  }
  if (
    !policy ||
    typeof policy !== 'object' ||
    typeof policy.url !== 'string' ||
    policy.url.length === 0
  ) {
    throw new Error('GitRemote policy must include a non-empty url');
  }

  // The policy record is mutable through the controller; we keep a
  // mutable struct here and freeze each read view we hand out.
  /** @type {GitRemotePolicy} */
  let currentPolicy = {
    allowedDirections: [...(policy.allowedDirections || DEFAULT_POLICY.allowedDirections)],
    fetchRefspecs: [...(policy.fetchRefspecs || [])],
    pushRefspecs: [...(policy.pushRefspecs || [])],
    allowedBranches:
      policy.allowedBranches !== undefined
        ? [...policy.allowedBranches]
        : undefined,
    allowForcePush: policy.allowForcePush ?? DEFAULT_POLICY.allowForcePush,
    allowTags: policy.allowTags ?? DEFAULT_POLICY.allowTags,
    allowDelete: policy.allowDelete ?? DEFAULT_POLICY.allowDelete,
    url: policy.url,
  };

  let revoked = false;

  const ensureLive = () => {
    if (revoked) {
      throw new Error(`GitRemote ${q(name)} has been revoked`);
    }
  };

  const ensureDirection = direction => {
    ensureLive();
    if (!currentPolicy.allowedDirections.includes(direction)) {
      throw new Error(
        `GitRemote ${q(name)} does not permit ${q(direction)} (allowed: ${currentPolicy.allowedDirections.join(', ')})`,
      );
    }
  };

  const snapshotPolicy = () =>
    harden({
      name,
      url: currentPolicy.url,
      allowedDirections: harden([...currentPolicy.allowedDirections]),
      fetchRefspecs: harden([...currentPolicy.fetchRefspecs]),
      pushRefspecs: harden([...currentPolicy.pushRefspecs]),
      allowForcePush: currentPolicy.allowForcePush,
      allowTags: currentPolicy.allowTags,
      allowDelete: currentPolicy.allowDelete,
      ...(currentPolicy.allowedBranches !== undefined
        ? { allowedBranches: harden([...currentPolicy.allowedBranches]) }
        : {}),
    });

  const remote = makeExo('GitRemote', GitRemoteInterface, {
    async inspect() {
      ensureLive();
      return snapshotPolicy();
    },

    async fetch(_options = {}) {
      ensureDirection('fetch');
      // Phase 2 lands the HTTPS-credentialed transport.  Until then,
      // remote operations refuse rather than secretly do something.
      throw new Error(
        `GitRemote ${q(name)}.fetch is not yet implemented (transport phase pending)`,
      );
    },

    async pull(_options = {}) {
      ensureDirection('fetch');
      throw new Error(
        `GitRemote ${q(name)}.pull is not yet implemented (transport phase pending)`,
      );
    },

    async push(_options = {}) {
      ensureDirection('push');
      throw new Error(
        `GitRemote ${q(name)}.push is not yet implemented (transport phase pending)`,
      );
    },
  });

  const controller = makeExo(
    'GitRemoteController',
    GitRemoteControllerInterface,
    {
      async inspect() {
        return harden({ ...snapshotPolicy(), revoked });
      },

      async setAllowedDirections(directions) {
        if (!Array.isArray(directions) || directions.length === 0) {
          throw new Error('setAllowedDirections requires a non-empty array');
        }
        currentPolicy = {
          ...currentPolicy,
          allowedDirections: [...directions],
        };
      },

      async setFetchRefspecs(refspecs) {
        currentPolicy = { ...currentPolicy, fetchRefspecs: [...refspecs] };
      },

      async setPushRefspecs(refspecs) {
        currentPolicy = { ...currentPolicy, pushRefspecs: [...refspecs] };
      },

      async setAllowedBranches(branches) {
        currentPolicy = { ...currentPolicy, allowedBranches: [...branches] };
      },

      async setAllowForcePush(flag) {
        currentPolicy = { ...currentPolicy, allowForcePush: !!flag };
      },

      async setAllowTags(flag) {
        currentPolicy = { ...currentPolicy, allowTags: !!flag };
      },

      async setAllowDelete(flag) {
        currentPolicy = { ...currentPolicy, allowDelete: !!flag };
      },

      async revoke() {
        revoked = true;
      },
    },
  );

  // `git` is captured for the Phase 2 transport which composes the
  // remote's fetch with the local Git's integration ops.  Phase 1
  // does not call into it directly; the reference here pins the
  // local cap into the closure so Phase 2 doesn't need to refactor.
  void git;

  // Register the controller in the host-private companion map.
  remoteControllers.set(remote, controller);

  return harden({ remote, controller });
};
harden(makeGitRemote);
