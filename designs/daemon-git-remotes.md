# Daemon Git Remotes for Agent MVP

| | |
|---|---|
| **Created** | 2026-05-18 |
| **Updated** | 2026-05-20 |
| **Author** | 0xPatrick (prompted) |
| **Status** | Proposed |

> **Read in order.** This is doc 3 of 3.  It requires
> [daemon-mount-capabilities](daemon-mount-capabilities.md) (doc 1) and
> [daemon-git-capability](daemon-git-capability.md) (doc 2) as
> prerequisites.

## Summary

Add the remote half of the git story as an explicit composition: local
`Git` plus separately authorized HTTPS transport plus non-extractable
bearer or basic credentials, bundled into a `GitRemote` capability that
agents call directly.  Credential injection runs through a daemon-shipped
`GIT_ASKPASS` helper fed by an anonymous pipe (fd-only, never argv or
env).  CapTP carries control-plane authority (which repo, which endpoint,
which credential, which directions and refs) while git packfile bytes
travel on the bounded HTTPS data plane outside CapTP messages.  Endpoint
policy is controller-owned; the guest receives `GitRemote` only.
Controllers (`GitRemoteController`, `GitCredentialController`) and
collection capabilities (`GitRemoteSet`) land in a later phase so the
first phase stays minimum.

## What is the Problem Being Solved?

The local-worktree design in
[daemon-git-capability](daemon-git-capability.md) deliberately keeps
network and credential authority out of the base `Git` capability.  That is
the right authority boundary, but it is not enough for an agent MVP.

A useful coding agent must often:

- inspect remote branches;
- fetch review updates;
- pull or integrate upstream changes;
- push a branch for review;
- do so without receiving raw credentials or unconstrained network access.

Today, agentic coding tools usually get all of that by inheriting the host
user's ambient git configuration, SSH agent, credential helpers, and network
stack.  That posture is incompatible with Endo's capability model.  We need
remote git for the MVP, but we need it as an explicit composition of:

1. local repository authority;
2. remote endpoint authority;
3. transport / network authority;
4. non-extractable credential authority.

This document defines that companion capability.

## Goals

1. Make `fetch`, `pull`, and `push` available for the agent MVP.
2. Preserve the local `Git` capability's least-authority boundary.
3. Represent remotes as explicit capabilities or controller-managed bindings,
   not as mutable strings hidden in repository config.
4. Let an agent use credentials without ever reading or exporting them.
5. Allow hosts to grant fetch-only, push-limited, or branch-limited remotes.
6. Keep endpoint policy, credential policy, and local repository authority
   independently revocable.
7. Make the composition visible: local `Git`, outbound transport, and
   credentials are separate authority inputs.
8. Clarify how remote operations relate to repository bootstrap / clone.
9. Keep remote git object transfer out of CapTP's data plane: CapTP should
   carry authority, invocation, policy, and summaries, while packfile bytes
   move over a bounded git transport such as HTTPS.

## Non-Goals

- Giving the agent raw network sockets, ambient DNS, or arbitrary `ssh`
  process execution.
- Exposing plaintext tokens, SSH private keys, or credential-helper output.
- Supporting every git transport in the first increment.
- Replacing local branch / commit / worktree operations in the base `Git`
  capability.
- Using mutable `.git/config` as the authority source of record.
- Tunneling git packfiles through CapTP as the default remote data path.

## Why This Is Separate from Local `Git`

Remote operations add at least two authorities that local git does not need:

| Authority | Why it is distinct |
|---|---|
| network transport | `fetch` and `push` communicate outside the daemon boundary |
| credentials | authenticated remotes must use secrets the agent should not inspect |

Keeping them separate means:

- a guest with `Git` can work locally but cannot exfiltrate by pushing;
- a guest with network access cannot silently use repo credentials;
- a guest with one remote credential cannot retarget it to another host;
- hosts can revoke remote authority while leaving local repo work intact.

The local and remote designs should ship close together for product reasons,
but they should remain separate capabilities for security reasons.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-git-capability](daemon-git-capability.md) | Required local repository capability. |
| [daemon-mount-capabilities](daemon-mount-capabilities.md) | Required indirectly through local `Git`. |
| [cli-http-client](cli-http-client.md) | Controller / client split for policy-bearing network capabilities. |
| [trust-on-first-bind](trust-on-first-bind.md) | Reusable policy-binding pattern for first-seen remote endpoints. |
| [endoclaw-network-fetch](endoclaw-network-fetch.md) | Earlier HTTP capability note; superseded in part by `cli-http-client`. |
| [endoclaw-oauth](endoclaw-oauth.md) | Existing non-extractable credential pattern, useful by analogy. |
| [daemon-capability-bank](daemon-capability-bank.md) | Broader resource-category framing for network, git, and credentials. |

## Capability Model

### Guest-Visible Facets

| Capability | Role |
|---|---|
| `Git` | Local repository and worktree authority |
| `GitRemote` | Authority to use one configured remote endpoint with bounded operations |
| `GitRemoteSet` | Optional collection capability for named remotes associated with one local `Git` |

### Construction Inputs

| Capability | Role |
|---|---|
| HTTPS transport cap | Outbound network authority, initially modeled by `HttpClient`-like origin policy |
| `BearerCredential` / `BasicCredential` | Non-extractable authentication-use authority |

### Host-Private / Controller Facets

| Capability | Role |
|---|---|
| `GitRemoteController` | Host-held policy facet for endpoint, allowed refs, direction, revocation, and inspection |
| `GitCredentialController` | Host-held facet that installs, rotates, or revokes credential material |
| transport-specific backing | Trusted implementation detail used by native git or another backend |

The agent-facing remote capability should be able to *use* a remote, not
retarget it, widen its branch policy, or read the secret backing it.

`GitRemote` is the guest-visible bounded remote-use authority for one git
endpoint.  It is constructed from separate local-repository, transport, and
credential capabilities.  The guest may receive only `remote`, or both
`git` and `remote`, but cannot recover or retarget the transport or
credential authority that was used to construct it.

```mermaid
flowchart LR
  mount[EndoMount] --> git[Git]
  transport[HTTPS transport cap] --> remote[GitRemote]
  cred[credential cap] --> remote
  git --> remote
```

## MVP Transport Scope

The first implementation should support **HTTPS remotes with bearer or basic
credentials**.

Reasons:

- it follows the same controller/client and non-extractable-credential
  patterns as the existing HTTP-client and OAuth-like designs;
- URL origins are inspectable and allowlistable;
- credentials can be injected without exposing them to the guest;
- it avoids granting ambient `ssh` process authority for the first cut.

For the HTTPS MVP, an `HttpClient`-like capability is the right visible
authority input even if the first native-git backend cannot literally call
through that object.  The important design point is that remote git is not
minted from `Git` plus a URL string alone; it also requires separately
granted outbound-network authority.

SSH remotes are important, but they need an explicit follow-up design for
host-key policy, agent forwarding, command restriction, and whether Endo
should expose an `SshSession` / `GitSshTransport` capability instead of
shelling through ambient `ssh`.

## Proposed Vocabulary

### `GitRemotePolicy`

```ts
type GitRemotePolicy = {
  url: string;
  allowedDirections: Array<'fetch' | 'push'>;
  fetchRefspecs: string[];
  pushRefspecs: string[];
  allowedBranches?: string[];
  allowForcePush?: boolean;
  allowTags?: boolean;
  allowDelete?: boolean;
};
```

The URL is controller-owned policy, not something the guest can mutate.
`allowedBranches` is the user-facing shortcut; implementations may compile
it into refspec policy.

### `GitRemote`

```ts
interface GitRemote {
  inspect(): Promise<{
    name: string;
    url: string;
    allowedDirections: Array<'fetch' | 'push'>;
    fetchRefspecs: string[];
    pushRefspecs: string[];
    allowForcePush: boolean;
    allowTags: boolean;
    allowDelete: boolean;
  }>;

  fetch(options?: {
    prune?: boolean;
    tags?: boolean;
  }): Promise<GitFetchResult>;

  // strategy uses an enum string rather than a tagged union because pull is
  // a one-shot operation with mutually-exclusive integration choices, not a
  // state machine.  rebase() uses a tagged union because its phases
  // (start/continue/abort/skip) take genuinely different inputs.
  pull(options?: {
    branch?: GitRef | string;
    strategy?: 'merge' | 'rebase' | 'ff-only';
  }): Promise<GitPullResult>;

  push(options?: {
    source?: GitRef | string;
    destination?: string;
    force?: boolean;
    setUpstream?: boolean;
  }): Promise<GitPushResult>;
}
```

### Result Types

```ts
type GitRefUpdate = {
  local?: GitRef; // present on push and on fetches that update tracking refs
  remote: GitRef | string; // GitRef when known structurally, string otherwise
  result: 'created' | 'updated' | 'up-to-date' | 'fast-forward'
    | 'forced' | 'pruned' | 'rejected';
};

type GitFetchResult = {
  updatedRefs: GitRefUpdate[]; // includes pruned entries with result='pruned'
};

type GitPullResult = {
  fetch: GitFetchResult;
  integration: 'up-to-date' | 'fast-forward' | 'merge' | 'rebase';
  head: GitRef;
};

type GitPushResult = {
  updatedRefs: GitRefUpdate[];
};
```

`updatedRefs` is shape-aligned across fetch and push so consumers that
present a unified "what changed on the remote" view do not branch on the
operation.  Pruned refs are folded into the same array with
`result: 'pruned'` instead of a separate `prunedRefs` field; that keeps
the typed shape singular and lets a caller filter rather than join.

### Sample Use

```js
// fetch updates from origin
const fetched = await E(remote).fetch({ prune: true });
console.error(`updated ${fetched.updatedRefs.length} refs`);

// publish a local branch as agent/topic
const pushed = await E(remote).push({
  source: 'agent/topic',
  destination: 'refs/heads/agent/topic',
  setUpstream: true,
});
for (const update of pushed.updatedRefs) {
  console.error(update.remote, update.result);
}

// fast-forward pull
await E(remote).pull({ strategy: 'ff-only' });
```

The first implementation may return backend text alongside these summaries
if native git output is still operationally useful.  The structured result
is the stable public shape.

### `GitRemoteController`

```ts
interface GitRemoteController {
  inspect(): Promise<GitRemotePolicy & { revoked: boolean }>;
  setAllowedDirections(directions: Array<'fetch' | 'push'>): Promise<void>;
  setFetchRefspecs(refspecs: string[]): Promise<void>;
  setPushRefspecs(refspecs: string[]): Promise<void>;
  setAllowedBranches(branches: string[]): Promise<void>;
  setAllowForcePush(flag: boolean): Promise<void>;
  setAllowTags(flag: boolean): Promise<void>;
  setAllowDelete(flag: boolean): Promise<void>;
  revoke(): Promise<void>;
}
```

The controller can narrow or widen policy after creation.  The guest-held
`GitRemote` cannot.

## Capability Construction

The preferred host flow is composition.  These calls are **one-time host
setup**, run once when the operator provisions a remote for an agent; the
resulting `GitRemote` (and credential cap) survive across daemon restart
via formula reconstitution and do not need to be re-issued per agent
session.

```js
const worktree = await E(host).provideMount('/repo', 'repo-worktree');
const git = await E(host).provideGit(worktree, 'repo-git');

const http = await E(host).provideHttpClient('github-http', {
  allowedOrigins: ['https://github.com'],
});

const credential = await E(host).provideBearerCredential('github-token', {
  audience: 'https://github.com',
});

const remote = await E(host).provideGitRemote({
  git,
  name: 'origin',
  url: 'https://github.com/endojs/endo.git',
  transport: http,
  credential,
  policy: {
    allowedDirections: ['fetch', 'push'],
    fetchRefspecs: ['+refs/heads/*:refs/remotes/origin/*'],
    pushRefspecs: ['refs/heads/agent/*:refs/heads/agent/*'],
    allowForcePush: false,
    allowTags: false,
    allowDelete: false,
  },
});
```

The exact maker names are placeholders.  Phase 5 (see *Implementation
Plan*) adds a sibling `provideGitRemoteController()` that returns the
host-held controller for revocation / policy updates; until then, the
operator's only post-setup lever is `revoke()` on the credential cap.

The required properties are:

- the remote is bound to one local `Git`;
- the endpoint is host-specified and inspectable;
- the transport is separately authorized and bounded before the remote is
  constructed;
- the credential is separately authorized and non-extractable;
- the agent receives only `remote`, not the credential or transport caps.

### Why bundle local + transport + credential into one `GitRemote`?

The deliberate ergonomic choice is to compose the three authority inputs
into one guest-facing capability rather than expose them separately and
ask the agent to compose them on every call.  Reasons:

- the agent's mental model is "fetch from origin / push to origin", not
  "compose local repo + HTTPS transport + bearer credential for one
  HTTPS GET";
- the composition is fixed at construction time; an agent that holds
  three loose caps could try to recombine them in ways the operator did
  not authorize;
- the construction-time bundling is where the host enforces "this
  credential is only useful with this transport against this endpoint
  for this repo";
- revocation is per-bundle: revoking the credential invalidates exactly
  the bundles that used it, no more.

The host-side **decomposition** surface is the Phase 5 controllers
(`GitRemoteController`, `GitCredentialController`).  Splitting policy
edits and credential rotation off the guest-facing cap is what lets
operators change those without re-issuing the bundle to the agent.

## Credentials

### Required Properties

The credential capability must:

- let the backend authenticate requests;
- refuse export of the underlying token / password / key;
- be scoped to an audience or remote binding;
- be revocable independently of the remote;
- support rotation without replacing the guest-held `GitRemote`.

### MVP Credential Shapes

For HTTPS remotes, the first useful shapes are:

```ts
interface BearerCredential {
  audience(): string;
}

interface BasicCredential {
  audience(): string;
}
```

These public facets may expose almost nothing beyond inspection of their
scope.  Trusted backend code obtains the sealed secret through a host-private
unsealer when constructing transport requests.

### Relation to OAuth

This is the same pattern already described by
[endoclaw-oauth](endoclaw-oauth.md): authority to use a service without
authority to read the credential.  Remote git needs the same property even
when the token was minted manually rather than by an OAuth flow.

## Endpoint Policy

### Strict Mode

The default should be strict:

- remote URL fixed at construction;
- origin must already be allowed by the supplied transport authority;
- fetch / push direction fixed by policy;
- refspecs fixed by policy;
- unknown endpoint requests fail.

### Trust-On-First-Bind

For interactive agent setup, remote creation can optionally use the
[trust-on-first-bind](trust-on-first-bind.md) pattern:

- first attempted binding to `https://github.com` prompts the holder;
- approval pins the endpoint in controller policy;
- denial remains inspectable and revocable;
- strict remains the default for unattended agents.

This belongs in the controller layer, not in the guest-held remote cap.

## Operation Semantics

### `fetch`

`fetch()`:

- requires fetch direction;
- uses only controller-approved fetch refspecs;
- may update local remote-tracking refs;
- does not mutate the worktree.

### `pull`

`pull()`:

- requires fetch direction;
- composes `fetch()` with a local integration operation on the paired
  `Git` capability;
- requires the relevant local mutation authority;
- should default to a host-selected mode such as `ff-only` or `rebase`,
  not silently choose broad merge behavior.

### `push`

`push()`:

- requires push direction;
- validates source and destination against push policy;
- refuses force, tag creation, and deletes unless explicitly authorized;
- uses only the bound credential and endpoint;
- is the most security-sensitive remote operation because it is an
  exfiltration path and an external side effect.

## Remote Data Plane

`GitRemote` should be a CapTP control-plane capability, not a CapTP
packfile tunnel.

The guest-visible operation is a capability invocation:

```js
await E(remote).fetch();
await E(remote).push({
  source: 'HEAD',
  destination: 'refs/heads/agent/topic',
});
```

That invocation carries authority and policy through CapTP:

- which local repository is paired with the remote;
- which endpoint the host has approved;
- which credential may be used without being exposed;
- which directions and refs are allowed;
- what summary, audit record, or error is returned to the guest.

The bulk git object exchange should then happen outside CapTP through the
approved git transport.  For the HTTPS MVP, trusted backend code should run
the git smart HTTP protocol, either through native git or a future HTTP git
client, using the controller-owned URL and sealed credential material.  The
packfiles, deltas, and large object payloads should not be serialized as
CapTP messages merely because the initiating authority was a CapTP object.

This distinction keeps several boundaries clear:

- CapTP remains the object-capability layer for authorization and durable
  references.
- HTTPS remains the first remote data plane because it is already the normal
  git transport, has inspectable origins, and composes with bearer/basic
  credential patterns.
- The daemon can enforce endpoint and ref policy before starting the data
  transfer, then summarize the result after it completes.
- Large fetches and pushes avoid per-object CapTP round trips and avoid
  making the remote protocol depend on CapTP framing.

The backend must still be careful not to smuggle in ambient authority.  A
native-git HTTPS implementation should provide the endpoint and credential
through trusted code, suppress ambient credential helpers, and reject any
call-time URL supplied by the guest.  Moving packfile bytes outside CapTP
does not mean bypassing policy; it means applying policy before handing the
bulk transfer to the transport best suited for that data.

### Future Encrypted Transports

HTTPS is the right first target.  It is available today, has clear origin
policy, and matches the credential patterns already in this design.  SSH
requires separate design work for host keys, agent forwarding, command
restriction, and key-use authority.

A future Noise-based transport could be useful if Endo later wants a
capability-native encrypted channel for peer-to-peer git object exchange or
for remotes that are not ordinary Git hosting services.  That should remain
future work until the HTTPS data-plane shape is proven.  The durable design
requirement is not "always HTTPS"; it is "remote git bulk bytes travel on a
bounded transport capability, while CapTP remains the control and authority
plane."

## Repository Bootstrap and `clone`

`GitRemote` is intentionally bound to an existing local `Git`, so `clone()`
does not belong on that facet.  Cloning creates both repository metadata and
a worktree; it crosses the boundary between remote transport and mount
provisioning.

For the MVP there are two legitimate product flows:

1. The host provides an already-existing physical worktree mount, then
   derives `Git` and `GitRemote`.
2. The host performs a separate trusted bootstrap operation that creates a
   new physical worktree from a bounded remote source and then returns the
   resulting `EndoMount` plus `Git`.

The second flow is product-relevant when an agent starts from only a remote
repository, but it should remain host-mediated.  It should not become guest
authority to clone arbitrary remotes into arbitrary host paths.  The exact
bootstrap API is a follow-up design point because it must combine mount
creation, endpoint policy, and sealed credential authority before a local
`Git` exists.

## Security Model

### Authority Separation

| Capability | Grants |
|---|---|
| `Git` | local repository operations |
| transport cap | outbound network access bounded by origin / transport policy |
| `GitRemote` | bounded use of one remote |
| `GitRemote` endpoint policy | bounded access to one remote endpoint |
| credential cap | non-extractable authentication use |

The guest-held `GitRemote` intentionally composes bounded local-repository
use, outbound transport, endpoint use, and credential use for one remote.
The host-held controllers remain separate so endpoint policy and credential
state can be revoked or changed independently.

### Required Restrictions

- no raw remote URLs supplied by the guest at call time;
- no arbitrary remote add / rename / set-url on the guest facet;
- no public access to credential material;
- no credential helper execution;
- no ambient SSH agent or shell fallback in the HTTPS MVP;
- no unrestricted refspecs;
- no force-push, tag-push, or deletion unless separately enabled;
- no push on a fetch-only remote;
- no use of a remote after either the remote controller or credential has
  been revoked.

### Audit Surface

Controllers should retain an audit log of:

- endpoint creation and policy changes;
- credential attachment / rotation / revocation;
- fetch / pull / push invocations;
- refs updated by push;
- rejected attempts.

The guest may get summaries of its own operations; the host retains the
full audit surface.

## Agent MVP Profile

For a practical first release, a useful default profile is:

```text
origin:
  transport: HTTPS only
  credential: scoped bearer token
  fetch: allowed
  pull: allowed, default ff-only or rebase
  push: allowed only for refs/heads/agent/*
  force push: denied
  tag push: denied
  delete: denied
```

That lets an agent:

- advance work already present in the mounted worktree from upstream;
- publish its own review branches;
- avoid writing over protected human branches;
- remain unable to retarget the token or push arbitrary refs.

Fetch-only remotes are a natural stricter profile for review or analysis
agents.

## Transport and Backend Boundary

The public `GitRemote` API should not commit the design to one internal
transport implementation, but its construction should still make transport
authority explicit.

```ts
interface GitRemoteBackend {
  fetch(...): Promise<GitFetchResult>;
  push(...): Promise<GitPushResult>;
}
```

### Initial Backend

The first backend may still use native git internally.  A native `git`
process cannot literally consume an Endo `HttpClient` object, so the MVP
should not pretend that generic HTTP-client composition is already the
runtime call path.  The transport capability is still a real required input:
trusted daemon code must verify the controller-owned URL against the granted
transport authority, then invoke native git only with the approved URL,
approved refspecs, and sealed credential material.

That means:

- a daemon-shipped `GIT_ASKPASS` helper binary, exec'd by `git` and fed the
  credential through an anonymous pipe whose read-end fd is inherited by
  the helper (the secret is passed via fd-pointer, never via argv or
  process env);
- `GIT_TERMINAL_PROMPT=0` so a missed askpass does not hang waiting for a
  TTY;
- sanitized git environment that drops `GIT_*_HELPER`, `GIT_PROXY_COMMAND`,
  and other credential / process-shell vectors;
- repo config and credential-helper suppression
  (`-c credential.helper=` empties the helper list for the invocation);
- explicit remote URL supplied from controller state, written into the
  invocation as a positional argument never derived from a guest input;
- no shell interpolation; argv-array spawn only.

For bearer-token HTTPS remotes, native git also supports `http.extraHeader`.
Passing the header through `-c "http.extraHeader=Authorization: Bearer ..."`
leaks the token to `/proc/*/cmdline` (and is the standard reason public
guides warn against the flag).  The trusted-code form writes the header
into a per-invocation `GIT_CONFIG_GLOBAL` file (or, more conservatively, a
per-invocation `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_N`/`GIT_CONFIG_VALUE_N`
env tuple read from an anonymous pipe), so the secret stays in
backend-controlled storage and is not visible to other processes on the
host.

This preserves the same authority shape as `HttpClient` even when the first
implementation adapts that authority into a native-git invocation rather
than issuing requests through the object directly.

### Spike: confirm credential-injection portability

Before Phase 2 ships the first credential-bearing remote, run a spike
across the target host matrix (Linux, macOS, Windows where applicable) to
measure:

1. Whether the anonymous-pipe-fed `GIT_ASKPASS` helper works on every
   target host's stock `git` (≥ 2.30; see
   [daemon-git-capability](daemon-git-capability.md) for the version pin),
   including under `git`'s recent `setup_credential_helpers` defaults.
2. Whether the `GIT_CONFIG_COUNT` env-tuple injection path keeps the bearer
   token out of `/proc/*/environ` and out of any temp-file artifact a
   panicked git invocation might leave behind.
3. Whether the daemon-shipped helper binary can be located on macOS in a
   way that survives `git`'s notarization / quarantine attributes for
   packaged installers.
4. Whether `pipe2(O_CLOEXEC)` (Linux) and equivalent (macOS `pipe` +
   `fcntl(FD_CLOEXEC)`) prevent the credential fd from leaking into
   sibling subprocesses git may spawn (`git config --show-origin`, smart
   HTTP helpers, etc.).

The spike's deliverable is a one-page note in `designs/` recording which
mechanism works on which host and any fallback ladder.  The capability
contract does not change with the spike's outcome; the implementation
detail does.

The native invocation should also be treated as a bulk data-plane adapter.
CapTP starts the operation and receives completion metadata; native git and
HTTPS carry the packfile exchange.  Tests should assert policy behavior and
observable results, not require packfile bytes to pass through CapTP.

### Future Backends

Future implementations may use:

- a JS git backend over an Endo transport adapter;
- a dedicated HTTP git smart-protocol client;
- an SSH transport capability once separately designed.
- a future Noise-based transport capability for git object exchange, if
  Endo grows a peer-to-peer git use case that justifies it.

The public `GitRemote` contract should survive those swaps.

## Implementation Plan

### Phase 1: Remote Model (MVA)

- Add `GitRemote` and credential-capability types (`BearerCredential`,
  `BasicCredential`).
- Add `git-remote` formula type bound to a local `Git`.
- Add a host method to mint a `GitRemote` with policy baked in at
  construction (`provideGitRemote({...})`), including fetch-only,
  push-limited, and branch-limited validation.
- The minimum viable agent flow (fetch + ff-only-pull + branch-limited
  push) is exercised end-to-end on this surface, with no controller in
  sight.  Controllers come in Phase 5.

### Phase 2: HTTPS Credentialed Fetch

- Support HTTPS bearer/basic credential injection through trusted backend
  code.
- Implement `fetch()` with fixed endpoint and approved refspecs.
- Keep packfile transfer on the HTTPS/native-git data plane rather than
  relaying git object bytes through CapTP.
- Add revocation tests for remote and credential caps.

### Phase 3: Pull and Local Integration

- Implement `pull()` as `fetch + local Git integration`.
- Make the default integration mode explicit.
- Add divergence / conflict tests.

### Phase 4: Push for MVP

- Implement branch-limited `push()`.
- Deny force, tags, and deletes by default.
- Keep push packfile transfer on the bounded HTTPS/native-git data plane.
- Add audit entries for outbound ref updates.
- Add end-to-end tests for publishing `agent/*` branches.

### Phase 5: Controllers and Revocation

- Add `GitRemoteController` and `GitCredentialController` for
  post-construction policy updates and revocation.
- Add `GitRemoteSet` if a collection capability is useful (host can also
  defer this).
- Wire `revoke()` against in-flight operations (see *daemon-restart
  mid-operation* in the testing plan).
- The agent-facing surface from Phase 1 does not change; controllers add a
  parallel host-held authority for ops-team work.

### Phase 6: Interactive Provisioning

- Add form / CLI flows for creating common remote profiles.
- Optionally integrate trust-on-first-bind for interactive endpoint approval.
- Add clear inspection surfaces so users can see which remotes and push
  targets are granted.

### Phase 7: Extended Transports

- Design SSH-specific transport and credential capability.
- Decide whether SSH belongs under a general network/process capability or
  a git-specialized transport cap.
- Revisit Noise only after HTTPS semantics, policy, and audit are stable.
- Add mirror / tag / delete profiles only after explicit policy designs.

## Testing Plan

### Capability Tests

- remote cannot be created without local `Git`;
- remote cannot be created without transport authority;
- remote cannot be created without compatible credential authority;
- credential cannot be read by the guest;
- revoked credential blocks remote operations;
- remote URL cannot be changed by the guest.

### Policy Tests

- fetch-only remote rejects push;
- push-limited remote rejects branches outside policy;
- force push, tags, and deletion are denied by default;
- audience mismatch rejects credential use;
- strict endpoint policy rejects unknown remotes.

### Workflow Tests

- fetch updates remote-tracking refs;
- pull fast-forwards;
- pull rebase path;
- push creates an allowed review branch;
- large fetch / push fixtures complete without exposing packfile bytes or
  remote credentials through the guest-visible CapTP result;
- restart persistence preserves remote policy without exposing secrets;
- **revoke()** in-flight: call `GitRemoteController.revoke()` while a
  `push()` is mid-packfile; the in-flight transfer aborts cleanly and the
  remote-tracking ref is not advanced past the last-acknowledged commit;
- **credential rotation mid-operation**: call
  `GitCredentialController.rotate()` between a `fetch()` and a `push()`
  on the same `GitRemote`; the `push()` either uses the new credential or
  fails with a credential-revoked error, never both;
- **daemon restart mid-fetch**: kill the daemon while `fetch()` is
  streaming a large packfile, restart, and confirm the partial
  remote-tracking state is either consistent with the last completed
  ref-update batch or fully rolled back, not an intermediate per-pack
  state.

### Hardening Tests

- global/system git config ignored;
- credential helpers disabled;
- guest-provided refspecs cannot widen policy;
- guest-provided URLs are never accepted by call-time methods;
- backend never falls back to ambient SSH or shell.
- remote packfile transport is only started after endpoint, direction, ref,
  and credential policy checks pass.

## Relationship to Existing Git Designs

- [daemon-git-capability](daemon-git-capability.md) defines local worktree
  git and remains the prerequisite.
- This document is the remote companion required for a practical agent MVP.
- [daemon-agent-tools](daemon-agent-tools.md) should eventually describe two
  tool groups:
  - local git tools from `Git`;
  - remote git tools from granted `GitRemote` values.

## Open Questions

1. **Concrete peer-to-peer use case for a Noise-based git transport.**
   Explicitly deferred until HTTPS data-plane shape is proven (§ Future
   Encrypted Transports).  A real use case (Endo agents exchanging git
   objects directly, sneakernet repo sync, etc.) is what justifies
   designing the transport and its endpoint-identity policy.

### Resolved (recorded as Design Decisions)

- `pull()` location — decision 7.
- `GitRemote.inspect()` URL reveal scope — decision 8.
- Credential capability generality (generic vs `GitCredential`) —
  decision 9.
- Provider-specific branch protection — decision 10.
- `HttpClient` vs `GitHttpsTransport` narrowing — decision 11.

### Spike Tasks

These are open questions that need measurement or a concrete use case
before the answer is design-stable.  Each gets a one-line follow-up
deliverable.

- **MVP transport scope: HTTPS-only sufficient?**  Before Phase 1 ships,
  survey the target endo-MVP users (likely the Fae / Lal / Genie agents'
  current operators) and confirm that HTTPS bearer/basic credentials
  cover their first-release flows.  If a non-trivial fraction needs SSH,
  the SSH design in Phase 7 moves earlier.  Deliverable: a one-page
  note in `designs/` confirming or revising the HTTPS-only Phase 1.
- **Bootstrap / clone API.**  A `provideGitClone({...})` host flow that
  composes mount creation + endpoint policy + sealed credential authority
  before a local `Git` exists is a real follow-up requirement (early-draft
  Open Question #6).  Design lives in its own `designs/daemon-git-clone.md`
  follow-up; the spike's deliverable is the design doc, scheduled for
  Phase 6 after HTTPS fetch/push are exercised in real workflows.
- **Telemetry to distinguish CapTP control-plane time from remote
  transport data-plane time.**  During Phase 2, add structured timing
  fields to `GitFetchResult` and `GitPushResult` (initial shape:
  `{ captpMs: number; transportMs: number }` augmenting the existing
  result types) and iterate based on what debug sessions actually need.
  The shape may change after the spike; the principle (timing is
  observable) is decision 12.

## Design Decisions

1. **Remote git is MVP scope.**  Agents need fetch / pull / push to be useful
   in real coding workflows.
2. **Remote git is still a separate capability.**  MVP relevance does not
   justify folding network and credentials into base local `Git`.
3. **HTTPS first.**  It gives the shortest path to a secure useful release and
   composes with existing HTTP / OAuth patterns.
4. **Endpoints are controller-owned.**  Guests use remotes; hosts decide what
   they point at.
5. **Push is bounded by default.**  A practical default permits review-branch
   publication without granting arbitrary external write authority.
6. **CapTP is the remote control plane.**  Remote git packfiles should move
   over bounded HTTPS or another explicit git transport, not through CapTP
   object messages by default.
7. **`pull()` lives on `GitRemote`.**  The composition is `fetch + local
   integration` per § Operation Semantics; the `strategy` enum keeps the
   policy explicit on every call.  An agent that wants finer-grained
   composition can still call `E(remote).fetch()` and then `E(git).merge()`
   or `E(git).rebase()` separately, but the bundled `pull()` is the
   ergonomic path for the common case.
8. **`GitRemote.inspect()` reveals the full remote URL.**  The URL is
   controller-owned policy that the host already chose to share; hiding
   it behind a host-assigned label adds an indirection without obviously
   protecting anything (the guest can correlate operations to the URL
   anyway).  Construction-time rejection of URLs with embedded
   `user:password@host` userinfo prevents the only case where the URL
   itself would carry a secret.
9. **Credentials are generic across services.**  `BearerCredential` and
   `BasicCredential` are not git-specific; the same caps work for any
   HTTPS service that accepts the same authentication shape.
   Specializing to `GitCredential` after the fact is cheap; generalizing
   a specialized one later is expensive.
10. **Provider-specific branch protection is server-side, not daemon-side.**
    The daemon does not introspect GitHub / GitLab / Forgejo / Gitea
    branch-protection APIs; relying on server-side rejection keeps the
    daemon free of provider-specific knowledge.  Local policy
    (`pushRefspecs`, `allowForcePush`, `allowDelete`) covers the
    operator-known constraints; server-side rejection covers the
    provider-specific ones.
11. **HTTPS transport input remains a general `HttpClient` in v1.**  A
    dedicated `GitHttpsTransport` capability may emerge later if
    spike-measured git-specific needs (smart-protocol pipelining,
    sideband channel handling) make it worth specializing.  Until then,
    the general transport cap composes cleanly with other Endo HTTP
    consumers.
12. **Timing is observable on every remote operation.**  Phase 2 adds
    timing fields to `GitFetchResult` / `GitPushResult` so a debugging
    consumer can distinguish CapTP control-plane time from remote
    transport data-plane time without needing daemon-side
    instrumentation.
