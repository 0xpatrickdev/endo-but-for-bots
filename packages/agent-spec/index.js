// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';

/**
 * Components are intentionally small strategy capabilities. The exact method
 * names may evolve, but the declaration shape should keep carrying object
 * references instead of collapsing policies into strings.
 */
export const AgentLifecycleInterface = M.interface('AgentLifecycle', {
  provision: M.call(M.record()).returns(M.promise()),
  restart: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
harden(AgentLifecycleInterface);

export const AgentIngressInterface = M.interface('AgentIngress', {
  start: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
harden(AgentIngressInterface);

export const AgentRoleInterface = M.interface('AgentRole', {
  makeAgent: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
harden(AgentRoleInterface);

export const AgentOrchestratorInterface = M.interface('AgentOrchestrator', {
  start: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
harden(AgentOrchestratorInterface);

export const AdoptionPolicyInterface = M.interface('AdoptionPolicy', {
  inspect: M.call(M.record()).returns(M.promise()),
  adoptValue: M.call(M.record()).returns(M.promise()),
  adoptTool: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
harden(AdoptionPolicyInterface);

export const AuthorityProviderInterface = M.interface('AuthorityProvider', {
  makeAuthority: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
harden(AuthorityProviderInterface);

/**
 * @typedef {object} AgentDefinitionInput
 * @property {string} name
 * @property {object} lifecycle
 * @property {object[]} [ingress]
 * @property {Record<string, object>} [roles]
 * @property {object} [orchestrator]
 * @property {object} [adoption]
 * @property {object} [authority]
 * @property {Record<string, unknown>} [tools]
 * @property {Record<string, unknown>} [state]
 */

/**
 * @typedef {object} AgentDefinition
 * @property {string} name
 * @property {object} lifecycle
 * @property {readonly object[]} ingress
 * @property {Readonly<Record<string, object>>} roles
 * @property {object | undefined} orchestrator
 * @property {object | undefined} adoption
 * @property {object | undefined} authority
 * @property {Readonly<Record<string, unknown>>} tools
 * @property {Readonly<Record<string, unknown>>} state
 */

/**
 * Harden an Endo-style agent assembly while preserving the identity of every
 * strategy object supplied by the caller.
 *
 * This is deliberately not a config normalizer. `lifecycle`, `ingress`,
 * `roles`, `orchestrator`, `adoption`, and `authority` stay as object
 * references so callers can pass local strategy objects or remote capabilities.
 *
 * @param {AgentDefinitionInput} input
 * @returns {AgentDefinition}
 */
export const defineAgent = ({
  name,
  lifecycle,
  ingress = [],
  roles = {},
  orchestrator,
  adoption,
  authority,
  tools = {},
  state = {},
}) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('name is required');
  }
  if (!lifecycle || typeof lifecycle !== 'object') {
    throw new Error('lifecycle is required');
  }
  if (!Array.isArray(ingress)) {
    throw new Error('ingress must be an array');
  }

  return harden({
    name,
    lifecycle,
    ingress: [...ingress],
    roles: { ...roles },
    orchestrator,
    adoption,
    authority,
    tools: { ...tools },
    state: { ...state },
  });
};
harden(defineAgent);

/**
 * @typedef {object} AgentDescription
 * @property {string} name
 * @property {string} lifecycle
 * @property {string[]} ingress
 * @property {Record<string, string>} roles
 * @property {string | undefined} orchestrator
 * @property {string | undefined} adoption
 * @property {string | undefined} authority
 */

/**
 * Resolve the user-facing summary of a strategy object through its `help()`
 * method. Using `E()` keeps this path uniform for local and remote objects.
 *
 * @param {object | undefined} component
 * @returns {Promise<string | undefined>}
 */
const describeComponent = async component => {
  if (component === undefined) {
    return undefined;
  }
  return E(component).help();
};

/**
 * Produce a contributor-facing summary without discarding the underlying
 * strategy objects from the definition itself.
 *
 * @param {AgentDefinition} definition
 * @returns {Promise<AgentDescription>}
 */
export const describeAgent = async definition => {
  const lifecycle = /** @type {string} */ (
    await describeComponent(definition.lifecycle)
  );
  const roleEntries = await Promise.all(
    Object.entries(definition.roles).map(async ([name, role]) => {
      const description = await describeComponent(role);
      return [name, description];
    }),
  );
  const ingress = await Promise.all(
    definition.ingress.map(async entry => {
      const description = await describeComponent(entry);
      return /** @type {string} */ (description);
    }),
  );

  return harden({
    name: definition.name,
    lifecycle,
    ingress,
    roles: Object.fromEntries(
      /** @type {Array<[string, string]>} */ (roleEntries),
    ),
    orchestrator: await describeComponent(definition.orchestrator),
    adoption: await describeComponent(definition.adoption),
    authority: await describeComponent(definition.authority),
  });
};
harden(describeAgent);
