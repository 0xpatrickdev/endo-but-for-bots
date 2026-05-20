# Declarative Agents

| | |
|---|---|
| **Created** | 2026-05-18 |
| **Status** | Draft |

## Problem

Endo now has several LLM-agent implementations with overlapping concerns but
different architectures:

| Package | Primary role | Runtime shape |
|---|---|---|
| `@endo/lal` | General mail agent | Single ReAct loop over daemon inbox mail |
| `@endo/fae` | Dynamic-tool mail agent factory | Single ReAct loop plus runtime tool adoption |
| `@endo/jaine` | Channel-native conversational agent | Router -> composer -> executor pipeline |
| `@endo/genie` | Workspace-oriented agent framework | Pi-agent core, tool registry, memory, heartbeat, sub-agents |

The implementations are not accidental clones, but they are dispersed enough
that a contributor must read several packages before they can answer basic
questions:

- Which tools are available?
- Which powers are initially granted?
- Can this agent adopt values or tools from mail?
- Which model handles routing versus execution?
- Is the agent inbox-only, channel-aware, or heartbeat-driven?
- Where is transcript or memory state kept?
- What authority is exposed inside `exec`?

The goal is not to collapse every implementation into one runtime. The goal is
to make an agent's *policy surface* explicit and inspectable, so contributors
can understand or assemble an agent without first reverse-engineering four
packages.

## Inventory

### `@endo/lal`

Lal is the oldest daemon-native mail agent. It has:

- static tool schemas in `agent.js`
- a single inbox-driven agent loop
- direct daemon guest operations
- a static transcript model
- no dynamic tool discovery

Its current tools are expressed as a module-level array plus a switch-based
dispatcher.

### `@endo/fae`

Fae is also a daemon-native mail agent, but treats tools as first-class
capabilities:

- local built-ins are `FaeTool` objects
- adopted tools live in `tools/`
- tools are re-discovered each turn
- a factory + driver split provisions restartable named agents

Fae is the clearest example of policy that should be declarative:
tool adoption, built-in tools, driver pinning, and system prompt are all
configuration choices rather than inherent requirements of "an agent."

### `@endo/jaine`

Jaine is a channel-native agent, not just a mail agent with a different prompt:

- router decides whether to engage
- composer writes the conversational response
- executor performs capability operations
- inbox and channel messages follow different paths
- channel execution is scoped to a member handle rather than raw guest powers

Jaine already reuses Fae tool machinery in its executor. The large remaining
difference is topology and ingress policy, not the existence of tools.

### `@endo/genie`

Genie is closer to a framework than a daemon-agent variant:

- tool groups are selected from a registry
- the agent pack may include main, heartbeat, observer, and reflector agents
- workspace, memory, and heartbeat are first-class concepts
- the daemon adapter is one deployment of a more general loop/runtime

Genie is also the package that already looks most declarative today:
`buildGenieTools({ include })`, `makeGenieAgents({ config })`, and the system
prompt builder are all partial declarations.

### Adjacent but not the same class

- `packages/sandbox/src/agent.js` is infrastructure, not an LLM product agent.
- `packages/cli/test/demo/doubler-agent.js` and
  `packages/daemon/test/counter-agent.js` are examples/tests.
- Nanobot currently appears only in comparison/design material in this repo.

## Common Axes

The current agents differ along a small number of recurring axes:

| Axis | Examples |
|---|---|
| **Ingress** | inbox mail, channel messages, heartbeat ticks, specials |
| **Role composition** | one main agent, router/composer/executor, main + observer + reflector + heartbeat |
| **Models** | one model, fast router + strong executor, per-role models |
| **Tool source** | static list, adopted capabilities, grouped registry |
| **Authority scope** | raw guest powers, member-scoped channel handle, workspace root |
| **Adoption** | no adoption, adopt values, adopt tools, request permission |
| **State** | stateless, conversation tree, transcript chain, workspace memory |
| **Lifecycle** | direct caplet, factory + driver, pinned restart, form-provisioned children |
| **Response policy** | prose allowed, tool-calls only, auto-reply fallback, channel edit-in-place |

Those are the things a contributor wants to see declared.

## Proposed Shape

Introduce a shared agent-definition layer whose job is to describe an agent,
not to force every agent through one executor.

This should be an Endo-style assembly of hardened objects and capabilities,
not a stringly-typed config format. A declaration should point at objects that
implement small interfaces:

```js
const AgentLifecycleInterface = M.interface('AgentLifecycle', {
  provision: M.call(M.record()).returns(M.promise()),
  restart: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

const AdoptionPolicyInterface = M.interface('AdoptionPolicy', {
  inspect: M.call(M.record()).returns(M.promise()),
  adoptValue: M.call(M.record()).returns(M.promise()),
  adoptTool: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

const AuthorityProviderInterface = M.interface('AuthorityProvider', {
  makeAuthority: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

const AgentOrchestratorInterface = M.interface('AgentOrchestrator', {
  start: M.call(M.record()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
```

The exact method names are provisional. The important point is that lifecycle,
adoption, ingress, authority, transcript, and orchestration are strategy
objects or capabilities. The declaration wires them together; it does not
encode policy as strings.

If `pi-agent-core` becomes the standard inner harness, the declaration should
not model a generic "ReAct topology" of its own. Pi already supplies the
single-agent loop. The Endo layer should declare:

- the Pi-backed roles to construct
- the ingress that feeds those roles
- the authority and policy objects exposed to each role
- the orchestrator, if several roles cooperate

```js
const mainModel = providerByPetname('default');
const builtins = makeToolSet([
  makeDirectoryTools({ list: true, lookup: true, store: true, remove: true }),
  makeMailTools({ adopt: true, send: true, reply: true, listMessages: true, dismiss: true }),
  makeExecTool({ authority: guestPowersAuthority() }),
  makeReadChannelTool(),
]);
const mainRole = makePiRole({
  model: mainModel,
  tools: builtins,
  prompt: faePrompt,
  transcript: makeConversationTreeStore(),
});

export const fae = defineAgent({
  name: 'fae',

  lifecycle: makeFactoryDriverLifecycle({ restartPolicy: pinDriver() }),

  ingress: [
    makeInboxIngress({
      follow: true,
      skipOwnMessages: true,
      dismissAfterHandling: true,
    }),
  ],

  roles: {
    main: mainRole,
  },

  orchestrator: makeSingleRoleOrchestrator({
    role: mainRole,
  }),

  tools: {
    builtins,
    adopted: makeAdoptedToolRegistry({
      directory: ['tools'],
      interfaceGuard: FaeToolInterface,
      discovery: discoverEachTurn(),
    }),
  },

  adoption: makeMailAdoptionPolicy({
    values: allowValues(),
    tools: allowTools({ installInto: ['tools'] }),
  }),
});
```

The same vocabulary should be able to describe Jaine without pretending it is a
single-loop mail bot:

```js
const fastModel = providerByPetname('fast');
const defaultModel = providerByPetname('default');
const executorTools = makeToolSet([
  makeDirectoryTools({ list: true, lookup: true }),
  makeMailTools({ adopt: true, send: true, reply: true, dismiss: true }),
  makeExecTool({ authority: channelMemberAuthority() }),
  makeReadChannelTool(),
  makeFilesystemTools({ read: true, list: true }),
  makeTimerTools(),
]);
const routerRole = makePiRole({
  model: fastModel,
  tools: makeToolSet([makeDecideTool()]),
});
const composerRole = makePiRole({
  model: defaultModel,
  tools: makeToolSet([makeDelegateTool()]),
});
const executorRole = makePiRole({
  model: defaultModel,
  tools: executorTools,
});

export const jaine = defineAgent({
  name: 'jaine',

  lifecycle: makeFactoryDriverLifecycle({ restartPolicy: pinDriver() }),

  ingress: [
    makeInboxIngress({ follow: true }),
    makeChannelIngress({ watch: true, dedupeMentions: true }),
  ],

  roles: {
    router: routerRole,
    composer: composerRole,
    executor: executorRole,
  },

  orchestrator: makeChannelConversationOrchestrator({
    router: routerRole,
    composer: composerRole,
    executor: executorRole,
    participation: makeParticipationPolicy(),
  }),

  tools: {
    executor: executorTools,
  },

  adoption: makeMailAdoptionPolicy({
    values: allowValues(),
    tools: denyTools(),
  }),
});
```

## First spike

The first implementation spike should describe **current Fae faithfully** before
it tries to replace Fae's inner loop with Pi. That gives us a direct comparison
between:

- the existing Fae runtime pieces we already have today
- the declaration layer we want contributors to read first
- the narrower swap point where a future Pi-backed role could replace Fae's
  current single-agent loop

Concretely, the first pass should keep:

- Fae's factory + pinned driver lifecycle
- inbox-following ingress
- the current single Fae role
- mail value/tool adoption
- guest-powers authority for `exec`
- dynamic tool discovery from `tools/`

If that declaration reads clearly without duplicating the runtime, the next
step is to substitute a Pi-backed role implementation behind the same declared
shape.

## Pi boundary

If Pi becomes the inner loop, Fae should still own the Endo-specific behavior
that Pi does not know about:

- tool inventory and dynamic discovery
- steering and system-prompt policy
- CapTP/package-mail ingestion
- Endo passable encoding for tool arguments and results

The last two are protocol adapters, not agent policy. They should stay explicit
instead of disappearing into ad hoc strings or being mistaken for topology.

Pi already distinguishes transcript conversion from tool policy:

- `transformContext()` and `convertToLlm()` are the message boundary before an
  LLM call.
- `beforeToolCall()` and `afterToolCall()` run around an already parsed tool
  execution.

That suggests three distinct Endo-side adapter seams:

1. ingress codec: CapTP/package mail -> Pi-facing agent message
2. tool codec: Pi tool-call input/result <-> Endo passables
3. hooks/policies: allow, block, audit, terminate, or steer

The current Fae smallcaps/Justin conversions belong primarily in the codec
layer. A Pi hook may still use the decoded values for policy, but the hook should
not be where deterministic wire translation lives.

And it should leave room for Genie to stay a distinct runtime while still being
describable:

```js
const mainModel = modelRef('ollama/llama3.2');
const mainRole = makePiRole({ model: mainModel });
const heartbeatRole = makePiRole({ model: inheritModel(mainModel) });
const observerRole = makePiRole({ model: inheritModel(mainModel) });
const reflectorRole = makePiRole({ model: inheritModel(mainModel) });

export const genie = defineAgent({
  name: 'genie',

  runtime: makePiAgentRuntime(),

  ingress: [
    makeInboxIngress({ follow: true }),
    makeHeartbeatIngress(),
    makeSpecialsIngress({ prefix: '/' }),
  ],

  roles: {
    main: mainRole,
    heartbeat: heartbeatRole,
    observer: observerRole,
    reflector: reflectorRole,
  },

  orchestrator: makeAgentPackOrchestrator({
    main: mainRole,
    heartbeat: heartbeatRole,
    observer: whenMemoryEnabled(observerRole),
    reflector: whenMemoryEnabled(reflectorRole),
  }),

  tools: makeGenieToolRegistry({
    groups: ['bash', 'files', 'memory', 'webFetch', 'webSearch'],
  }),

  state: {
    workspace: makeWorkspaceState(),
    memory: makeMemoryState(),
    heartbeat: makeHeartbeatState(),
  },
});
```

## What Should Be Shared

### Good first extractions

1. **Catalog**
   - a single contributor-facing registry of shipping agent definitions
   - generated documentation from the definitions

2. **Tool protocol**
   - tool-call parsing
   - SmallCaps / JSON argument decoding
   - common tool-call result formatting
   - shared schema/type definitions

3. **Daemon built-in tool specs**
   - directory operations
   - mail operations
   - identity / introspection operations
   - adapters for "static Lal tool", "FaeTool", and "Jaine executor tool"

4. **Lifecycle helpers**
   - provider config references
   - factory + driver provisioning
   - pin/restart policy
   - inbox-following boilerplate

### Not worth forcing together first

- Lal's current static loop and Genie's pi-agent loop
- Jaine's channel routing and Fae's inbox-only response logic
- Genie's workspace/memory/heartbeat concerns with daemon mail bots
- Every `exec` surface, because authority scope is a policy decision

The first milestone should be "shared vocabulary and generated inventory,"
not "one runtime to replace them all."

## Suggested Package Boundaries

| Package | Responsibility |
|---|---|
| `@endo/agent-spec` | `defineAgent`, strategy interfaces, docs generation |
| `@endo/agent-tools` | shared tool specs, parser/decoder utilities, adapters |
| `@endo/agent-daemon` | inbox/channel ingress, factory/driver helpers, lifecycle glue |
| `@endo/agent-pi` | Pi-role adapter, Endo tool adapters, event/context bridge |
| existing agent packages | product-specific prompts, topologies, and any truly unique behavior |

`@endo/genie` may keep its own runtime while consuming `@endo/agent-spec` for
declarations and selected shared tools where that is natural.

## Migration Path

1. Add declarations for the four existing agent families without changing
   runtime behavior.
2. Generate a catalog page from those declarations.
3. Extract the shared tool-call parser and argument decoder.
4. Extract daemon built-in tool specs and adapt Lal/Fae/Jaine to them.
5. Extract common provisioning helpers for provider config, factories, drivers,
   and restart policy.
6. Only then decide whether Lal and Fae should converge on one runtime core.

## Open Questions

1. Should every strategy object expose a serializable `describe()` view for
   Chat/UI inspection, or is `help()` plus interface identity enough?
2. Is tool adoption an agent policy, a tool-registry policy, or both?
3. Should "powers" be declared as named authority slots that provisioning fills,
   rather than inferred from ad hoc petnames?
4. Should a role be able to receive a stricter authority view than the agent as
   a whole, as Jaine's channel executor already does?
5. Does `@endo/genie` consume the same declaration API directly, or merely
   export adapters that make its existing config visible through it?
6. If Pi is the standard inner harness, what is the smallest Endo-owned adapter
   surface around it: tools, context projection, policy hooks, lifecycle, and
   event bridge only?

## Working Principle

The valuable common abstraction is not "all agents are the same loop."
It is:

> An agent is a declared bundle of ingress, roles, orchestration, tools, authority,
> adoption policy, state, models, and lifecycle.

Each part should be an object with behavior and an interface, not a string
enum. That is enough common ground to make the system navigable without
flattening the useful differences between Lal, Fae, Jaine, and Genie.
