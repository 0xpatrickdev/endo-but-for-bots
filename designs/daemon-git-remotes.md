# Daemon Git Remotes for Agent MVP

| | |
|---|---|
| **Created** | 2026-05-18 |
| **Updated** | 2026-05-18 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

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

## Non-Goals

- Giving the agent raw network sockets, ambient DNS, or arbitrary `ssh`
  process execution.
- Exposing plaintext tokens, SSH private keys, or credential-helper output.
- Supporting every git transport in the first increment.
- Replacing local branch / commit / worktree operations in the base `Git`
  capability.
- Using mutable `.git/config` as the authority source of record.

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

```text
EndoMount --------------------> Git
                                   \
HTTPS transport cap ---------------> GitRemote
credential cap --------------------/
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

  pull(options?: {
    branch?: GitRef | string;
    mode?: 'merge' | 'rebase' | 'ff-only';
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
type GitFetchResult = {
  updatedRefs: GitRef[];
  prunedRefs: GitRef[];
};

type GitPullResult = {
  fetch: GitFetchResult;
  integration: 'up-to-date' | 'fast-forward' | 'merge' | 'rebase';
  head: GitRef;
};

type GitPushResult = {
  updatedRefs: Array<{
    local: GitRef;
    remote: string;
    result: 'created' | 'updated' | 'up-to-date';
  }>;
};
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

The preferred host flow is composition:

```js
const worktree = await E(host).provideMount('/repo', 'repo-worktree');
const git = await E(host).provideGit('repo-worktree', 'repo-git');

const http = await E(host).provideHttpClient('github-http', {
  allowedOrigins: ['https://github.com'],
});

const credential = await E(host).provideBearerCredential('github-token', {
  audience: 'https://github.com',
});

const { remote, controller } = await E(host).provideGitRemote({
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

The exact maker names are placeholders.  The required properties are:

- the remote is bound to one local `Git`;
- the endpoint is host-specified and inspectable;
- the transport is separately authorized and bounded before the remote is
  constructed;
- the remote controller carries bounded endpoint / remote-use authority;
- the credential is separately authorized and non-extractable;
- the agent receives only `remote`, not the controllers.

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

That likely means:

- temporary non-extractable askpass / header injection managed by trusted
  code;
- sanitized git environment;
- repo config and credential-helper suppression;
- explicit remote URL supplied from controller state;
- no shell interpolation.

This preserves the same authority shape as `HttpClient` even when the first
implementation adapts that authority into a native-git invocation rather
than issuing requests through the object directly.

### Future Backends

Future implementations may use:

- a JS git backend over an Endo transport adapter;
- a dedicated HTTP git smart-protocol client;
- an SSH transport capability once separately designed.

The public `GitRemote` contract should survive those swaps.

## Implementation Plan

### Phase 1: Remote Model and Controllers

- Add `GitRemote`, `GitRemoteController`, and credential-capability types.
- Add `git-remote` formula type bound to a local `Git`.
- Add host methods to create, inspect, and revoke remotes.
- Add fetch-only and push-limited policy validation.

### Phase 2: HTTPS Credentialed Fetch

- Support HTTPS bearer/basic credential injection through trusted backend
  code.
- Implement `fetch()` with fixed endpoint and approved refspecs.
- Add revocation tests for remote and credential caps.

### Phase 3: Pull and Local Integration

- Implement `pull()` as `fetch + local Git integration`.
- Make the default integration mode explicit.
- Add divergence / conflict tests.

### Phase 4: Push for MVP

- Implement branch-limited `push()`.
- Deny force, tags, and deletes by default.
- Add audit entries for outbound ref updates.
- Add end-to-end tests for publishing `agent/*` branches.

### Phase 5: Interactive Provisioning

- Add form / CLI flows for creating common remote profiles.
- Optionally integrate trust-on-first-bind for interactive endpoint approval.
- Add clear inspection surfaces so users can see which remotes and push
  targets are granted.

### Phase 6: Extended Transports

- Design SSH-specific transport and credential capability.
- Decide whether SSH belongs under a general network/process capability or
  a git-specialized transport cap.
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
- restart persistence preserves remote policy without exposing secrets.

### Hardening Tests

- global/system git config ignored;
- credential helpers disabled;
- guest-provided refspecs cannot widen policy;
- guest-provided URLs are never accepted by call-time methods;
- backend never falls back to ambient SSH or shell.

## Relationship to Existing Git Designs

- [daemon-git-capability](daemon-git-capability.md) defines local worktree
  git and remains the prerequisite.
- This document is the remote companion required for a practical agent MVP.
- [daemon-agent-tools](daemon-agent-tools.md) should eventually describe two
  tool groups:
  - local git tools from `Git`;
  - remote git tools from granted `GitRemote` values.

## Open Questions

1. Should `pull()` live on `GitRemote`, or should agents explicitly compose
   `remote.fetch()` with local `git.merge()` / `git.rebase()` so policy is
   more visible?
2. Should `GitRemote.inspect()` reveal the full remote URL to the guest, or
   only origin plus a host-assigned label?
3. Is a bearer/basic HTTPS MVP sufficient, or do target users require SSH in
   the first public release?
4. Should the credential capability be generic across services, or should
   git start with a narrow `GitCredential` abstraction and generalize later?
5. How should provider-specific branch protection be reflected, if at all,
   versus relying solely on local policy and server-side rejection?
6. What should the host-mediated bootstrap API be for cloning a remote into
   a new physical worktree before a local `Git` capability exists?
7. Should the HTTPS transport input remain a general `HttpClient`, or should
   git eventually narrow it into a dedicated `GitHttpsTransport` capability?

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

## Prompt

> Add the remote half of the git story as an MVP-relevant companion to local
> `Git`: agents need fetch, pull, and push, but these should compose explicit
> network, endpoint-policy, and non-extractable credential capabilities
> rather than inheriting ambient host git authority.
