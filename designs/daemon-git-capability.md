# Daemon Git Capability over EndoMount

| | |
|---|---|
| **Created** | 2026-05-18 |
| **Updated** | 2026-05-20 |
| **Author** | 0xPatrick (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Agents need useful local git workflows without receiving ambient shell
authority, raw host paths, or network authority.  The earlier
[daemon-agent-tools](daemon-agent-tools.md) note sketches a path-scoped
`Git` wrapper, and `packages/fae` now has a practical reference
implementation of that idea.  That implementation is useful as a native-git
adapter prototype, but its public authority boundary is still a configured
repository-root string.

The newer filesystem work changes the right abstraction boundary:

- live worktree authority should come from `EndoMount`;
- existing live files should be represented by `EndoMountFile`;
- paths that do not currently have live handles should be represented by
  mount-scoped descriptors, not ambient strings;
- immutable commit trees should surface as `ReadableTree` providers inside
  the broader filesystem model.

This document revises the git design around those facts.

## Goals

1. Define a git capability whose authority is derived from an existing
   physical worktree mount rather than from an arbitrary path string.
2. Preserve useful local git workflows without exposing raw git command
   execution, network operations, or repository configuration mutation.
3. Make the public API handle-first by using `EndoMount`,
   `EndoMountFile`, and `EndoMountEntry`.
4. Distinguish mutable physical-worktree operations from immutable git-tree
   reads.
5. Keep the implementation backend swappable so native git, a JS git
   library, or a future daemon-native backend can share one public
   capability contract.
6. Preserve room for bulk native-git data paths, such as `git archive`, so
   large immutable tree reads do not degenerate into one subprocess or one
   remote object turn per file.

## Non-Goals

- Defining remote transport, fetch, pull, push, or credential management in
  this local-worktree document.  Those are MVP-relevant, but they require
  separate network and credential authority and are specified in
  [daemon-git-remotes](daemon-git-remotes.md).
- Arbitrary shell access.
- Raw `git` passthrough.
- Exposing repository config, hooks, aliases, or arbitrary filters to
  guests.
- Making a CAS tree or arbitrary virtual tree behave as a writable git
  worktree.
- Replacing the multi-provider filesystem design with git-specific special
  cases.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-mount-capabilities](daemon-mount-capabilities.md) | Required prerequisite: snapshot bridge, mount-scoped descriptors, handle-oriented navigation, and trusted backing provenance. |
| [daemon-mount](daemon-mount.md) | Current physical mount formula implementation. |
| [platform-fs](platform-fs.md) | Shared `ReadableTree` / `SnapshotTree` vocabulary for git tree exposure. |
| [daemon-capability-filesystem](daemon-capability-filesystem.md) | Broader multi-provider VFS model including physical and git-tree backends. |
| [daemon-agent-tools](daemon-agent-tools.md) | Earlier agent-facing sketch to be revised by this design. |
| [daemon-git-remotes](daemon-git-remotes.md) | Companion MVP design for fetch, pull, push, and credentialed remote use. |

## Current State

### Useful Reference Implementation

The current Fae git tool demonstrates several implementation details worth
preserving:

- local-only workflow coverage;
- explicit operation allowlisting;
- sanitized git environment;
- disabled hooks, fsmonitor, external diff, signing, and prompt-based auth;
- repository-root verification;
- rejection of repo-local executable filters and merge drivers.

That work should remain useful as a reference for a `NativeGitBackend`.

### What Changes in This Design

| Earlier shape | Revised shape |
|---|---|
| Repository root string configures authority | `EndoMount` carries public worktree authority |
| Path strings are passed into git calls | `EndoMountEntry` values are passed after mount-local resolution |
| Git only means commands against a worktree | Git has a mutable worktree facet plus immutable tree providers |
| Adapter details leak into the tool design | Public `Git` capability is backend-neutral |

## Architecture

```text
HOST
 |
 | provideMount('/repo', 'worktree')
 v
EndoMount  <------------------------------+
 |                                         |
 | host-private backing grant              |
 v                                         |
Git provider                               |
 |                                         |
 +--> Git capability over live worktree ---+
 |
 +--> git-tree backend for refs / commits
      |
      +--> ReadableTree / ReadableBlob
```

The public worktree authority remains the `EndoMount`.  Trusted daemon code
uses a hidden backing grant to prove that the mount is physical and to reach
the repository metadata required by the chosen backend.

## Two Git Concerns, Kept Separate

### 1. Physical Worktree Capability

A physical worktree capability is the mutable side:

- status
- add / restore
- commit
- branch switching
- merge / rebase
- stash

It requires a real worktree and repository metadata.  It should be granted
only for an `EndoMount` backed by a physical directory that is exactly the
repository worktree root.

### 2. Git-Tree Backend

A git-tree backend is the immutable side:

- expose `HEAD^{tree}` or another tree-ish as a read-only filesystem tree;
- browse source at a commit without mutating the worktree;
- provide stable inputs for diffs, checkouts, snapshots, or future VFS
  composition.

The result should implement `ReadableTree`, with blobs implementing
`ReadableBlob`.  Once the VFS compositor exists, git trees become ordinary
read-only providers mounted beside physical, memory, and CAS backends.

Keeping these concerns separate avoids forcing immutable commit trees to
pretend they can support live worktree mutations.

## Capability Construction

The preferred host flow is capability-derived.  `provideGit()` takes an
`EndoMount` capability as its first argument and a pet name as the second:

```js
const worktree = await E(host).provideMount('/repo', 'repo-worktree');
const git = await E(host).provideGit(worktree, 'repo-git');
```

A pet-name lookup form is also supported as a convenience:

```js
const git = await E(host).provideGit('repo-worktree', 'repo-git');
```

When the first argument is a string, the host resolves it against its own
name table and treats it as cap-passing of the resolved mount.  The
cap-passing form is canonical; the pet-name form is sugar over it that
exists for parity with other `provide*` host methods.

`provideGit()`:

1. accepts the mount capability directly, or resolves a pet name against
   the host's name table and uses the result;
2. uses the host-private mount backing grant (see
   [daemon-mount-capabilities](daemon-mount-capabilities.md) § Host-Private
   Physical Backing) to prove the mount is physical;
3. verifies that the physical mount root is exactly a git worktree root;
4. constructs a `Git` formula / Exo tied to that mount identity;
5. stores only the formula references required to reconstitute the
   capability, not a guest-visible free-form path.

The required invariant is that git authority can only be derived from an
already-authorized mount.  There must be no parallel host API that mints
local `Git` from a raw path string once the mount model exists; that would
reintroduce an independent filesystem authority path beside `EndoMount`.

Remote repository use composes later without changing that root:

```text
EndoMount --------------------> Git
                                   \
transport cap + credential cap ----> GitRemote
```

## Proposed Public Vocabulary

### `GitRef`

```ts
type GitRef = {
  name: string;
  kind: 'branch' | 'tag' | 'commit' | 'detached';
  oid?: string;
};
```

### `GitStatusEntry`

```ts
type GitStatusEntry = {
  entry: EndoMountEntry;
  path: string; // mount-relative display copy
  index:
    | 'clean'
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'conflicted';
  worktree:
    | 'clean'
    | 'modified'
    | 'deleted'
    | 'untracked'
    | 'ignored'
    | 'conflicted';
  node?: EndoMountFile | EndoMount;
};
```

`entry` is the authority-bearing reference.  `path` is only presentation
data.  `node` is present only when a live worktree object currently exists.

### `GitCommit`

```ts
type GitCommit = {
  oid: string;
  summary: string;
  author?: string;
  committedAt?: number;
};
```

### `Git`

```ts
interface Git {
  // The public filesystem authority this Git capability is tied to.
  worktree(): EndoMount;

  // Repository inspection.
  status(): Promise<GitStatusEntry[]>;
  diff(options?: {
    cached?: boolean;
    base?: GitRef | string;
    head?: GitRef | string;
    entries?: EndoMountEntry[];
  }): Promise<string>;
  log(options?: {
    maxCount?: number;
    ref?: GitRef | string;
  }): Promise<GitCommit[]>;
  show(ref: GitRef | string): Promise<string>;
  revParse(ref: GitRef | string): Promise<GitRef>;

  // Worktree and index mutation.
  add(entries: EndoMountEntry[]): Promise<void>;
  restore(entries: EndoMountEntry[], options?: { staged?: boolean }):
    Promise<void>;
  commit(message: string): Promise<GitCommit>;

  // Branching.
  currentBranch(): Promise<GitRef | undefined>;
  branches(): Promise<GitRef[]>;
  createBranch(name: string, options?: {
    startPoint?: GitRef | string;
    switchAfterCreate?: boolean;
  }): Promise<GitRef>;
  deleteBranch(name: string, options?: { force?: boolean }): Promise<void>;
  renameBranch(from: string, to: string): Promise<void>;
  switch(ref: GitRef | string): Promise<void>;

  // History editing and integration.
  merge(ref: GitRef | string, options?: { noFastForward?: boolean }):
    Promise<string>;
  rebase(input:
    | { mode: 'start'; upstream: GitRef | string }
    | { mode: 'continue' }
    | { mode: 'abort' }
    | { mode: 'skip' }): Promise<string>;

  // Local stash state.
  stashPush(options?: {
    message?: string;
    entries?: EndoMountEntry[];
    includeUntracked?: boolean;
  }): Promise<string>;
  stashList(): Promise<string[]>;
  stashShow(index?: number): Promise<string>;
  stashApply(index?: number): Promise<void>;
  stashPop(index?: number): Promise<void>;
  stashDrop(index?: number): Promise<void>;

  // Immutable tree access (read-only sibling capability).
  trees(): Promise<GitTreeProvider>;
}
```

`trees()` returns the read-only `GitTreeProvider` defined below.  Splitting
immutable tree access off the mutable `Git` capability means a host can
grant a read-only auditor agent just the `GitTreeProvider` without granting
the worktree-mutation surface.  The two concerns named in § Two Git
Concerns, Kept Separate live as two distinguishable capabilities, not as
two methods on one Exo.

The initial implementation can keep some result types textual where the
stable structure is not yet worth committing to.  The path-bearing inputs
should not regress back to arbitrary strings.

### Future Structured Result Shapes

The text-returning methods (`diff`, `show`, `merge`, `rebase`, `stashList`,
`stashShow`) ship as `Promise<string>` in v1 and migrate to structured
shapes in v2.  Naming the eventual shapes now lets first-generation
consumers plan a clean migration instead of writing a parser they will
have to throw away.

```ts
type GitDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ kind: 'context' | 'add' | 'remove'; text: string }>;
};

type GitFileDiff = {
  oldEntry?: EndoMountEntry;
  newEntry?: EndoMountEntry;
  oldMode?: number;
  newMode?: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  hunks: GitDiffHunk[];
  binary?: { oldSizeBytes?: number; newSizeBytes?: number };
};

type GitDiff = { files: GitFileDiff[] };

type GitShow = {
  commit: GitCommit;
  parents: string[];
  diff: GitDiff;
};

type GitConflict = {
  entry: EndoMountEntry;
  base?: { oid: string };
  ours: { oid: string };
  theirs: { oid: string };
  markerStyle: 'merge' | 'diff3';
};

type GitMergeResult =
  | { status: 'up-to-date'; head: GitRef }
  | { status: 'fast-forward'; head: GitRef }
  | { status: 'merged'; head: GitRef; merged: GitCommit }
  | { status: 'conflicts'; conflicts: GitConflict[] };

type GitRebaseResult =
  | { status: 'completed'; head: GitRef; replayed: GitCommit[] }
  | { status: 'conflicts'; current: GitCommit; conflicts: GitConflict[] }
  | { status: 'aborted'; head: GitRef }
  | { status: 'in-progress'; current: GitCommit };
```

`v2` upgrades the `Git` interface in place; v1's text-returning methods
move under `*Text()` siblings (`diffText`, `showText`, …) so callers that
still want the porcelain output for display can keep it.  The migration is
named in `## Migration Strategy` as a discrete step rather than an
ambient "we'll structurally-improve later"; consumers who write against
v1 can flip to v2 by replacing one method call per site.

`stashList`'s structured shape, in the same vein, becomes
`Promise<Array<{ index: number; ref: GitRef; message: string;
created: GitCommit }>>`.  It ships as part of the same v2 cut.

## Why `EndoMountEntry` Is Required

`EndoMountFile` is correct for an existing file, but git routinely needs to
talk about entries that are not live file handles:

- a tracked file deleted from the worktree;
- an untracked path before it is created or staged;
- an index entry absent from the filesystem;
- a conflict path;
- a historical path in another tree.

The git API therefore needs mount-relative entry descriptors in addition to
live handles.  Without them, the design inevitably falls back to free-form
relative strings and loses the provenance supplied by the mount.

## Git-Tree Backend

### Read Surface

```ts
interface GitTreeProvider {
  tree(ref: GitRef | string): Promise<ReadableTree>;
}
```

The tree provider should:

- resolve the ref in the repository object database;
- expose directories as `ReadableTree`;
- expose blobs as `ReadableBlob`;
- never expose mutation methods;
- be usable anywhere a `ReadableTree` is accepted today, including
  checkin, checkout, staging, and later VFS mounting.

Obtain it from a `Git` capability via `await E(git).trees()`.  The host may
also expose a `provideGitTreeProvider()` shortcut for cases where the
intent is read-only auditing and the caller should not be issued the full
`Git` capability at all; that route is part of the *Open Questions*
discussion of long-lived named trees.

### VFS Integration

When the VFS namespace exists, a host could compose:

```text
/worktree        physical EndoMount, read-write
/ref/main        git-tree backend for main, read-only
/ref/review      git-tree backend for feature/review, read-only
/scratch         memory backend, read-write
```

The guest sees ordinary filesystem trees.  Git remains the provider of the
immutable revision-backed trees, not a special path syntax inside the VFS.

### Bulk Tree Data Plane

The public read surface should stay `ReadableTree` / `ReadableBlob`, but the
native backend should not be limited to the smallest possible git primitive
for every use case.  Lazy browsing can reasonably use commands such as
`git ls-tree` and `git cat-file` because an agent may only inspect a handful
of entries.  Whole-tree materialization is different: `storeTree()`,
`stageTree()`, checkout-like flows, caplet source import, and future VFS
composition may need hundreds or thousands of files from one commit.

For those bulk paths, a native backend should be allowed to amortize the
cost of shelling out by streaming a subtree in one operation:

```sh
git archive --format=tar HASH path/to/thing
```

or equivalently by resolving the subtree first and archiving that tree-ish.
Trusted daemon code can then parse the tar stream and feed the content store
or scratch-mount writer directly.  The important point is that the tar stream
is a private backend data plane.  The guest still receives object
capabilities and structured results, not host paths, tar bytes, or raw git
command authority.

This optimization is especially relevant when:

- importing an immutable commit subtree into content-addressed storage;
- staging a git tree into a scratch mount;
- constructing a source archive from a repository subtree;
- comparing or indexing many files from the same revision;
- avoiding one CapTP turn, one Exo lookup, or one `git cat-file` invocation
  per file.

It is less important for one-off interactive reads, where lazy `lookup()` and
blob reads keep latency low and avoid loading data the agent will not use.

The archive path must obey the same authority and validation rules as the
rest of the git-tree backend:

- the ref is resolved inside the already-authorized repository;
- subtree paths are normalized git-tree path segments, not host paths;
- archive entry names are treated as untrusted input and checked for
  absolute paths, `..`, NUL bytes, duplicate entries, and unsupported modes;
- symlink, executable-bit, and directory mode handling is explicit rather
  than inherited from a host `tar` command;
- extraction is performed by trusted code into CAS formulas or an authorized
  scratch mount, never by giving the guest a destination path;
- archive generation uses argument arrays, not shell interpolation.

Compression is a secondary concern.  `git archive --format=tar` is already
valuable because it batches traversal and file transfer.  A compressed
variant may be useful for storage or network hops, but the first optimization
target is reducing process and object-call overhead while preserving the
same public capability boundary.

## Backend Boundary

The public `Git` capability is shaped for the native-git backend in
[`packages/fae`](../packages/fae)'s existing reference implementation.  A
later JS backend (`isomorphic-git`, an Endo-native HTTP git smart-protocol
client, a daemon-local object-database walker) may require contract
revisions in v2 or v3.  The contract below is best-effort
backend-pluggable, not contractually backend-replaceable; methods that
turn out to leak native-git assumptions (sanitization, askpass, allowlist
rejection) move to a `NativeGitBackend` sub-interface during that swap.

```ts
// Essential backend contract (every backend must satisfy):
interface GitBackend {
  assertRepositoryRoot(): Promise<void>;
  status(): Promise<BackendStatusEntry[]>;
  diff(...): Promise<string>;
  add(...): Promise<void>;
  // ...
  trees(): GitTreeProviderBackend;
}

// Native-git-shaped contract; carries the hardening envelope:
interface NativeGitBackend extends GitBackend {
  sanitizeChildEnv(env: Record<string, string>): Record<string, string>;
  rejectRepoLocalExecutables(): Promise<void>;
  // …native-only operational surface
}
```

The split is deliberate: it names the parts of today's implementation that
are accidentally specific to shelling-out, so a future JS backend can
implement the essential contract without inheriting hooks that do not
apply to it.  Until that swap actually happens, the v1 backend is the
native one.

### Initial Backend: Native Git

Start with a `NativeGitBackend` because the existing reference tool already
proves the hardening envelope and local workflow shape:

- exact worktree-root verification;
- no shell interpolation;
- sanitized environment;
- disabled hooks and external execution paths;
- explicit operation allowlist;
- rejection of repo-local executable filters and merge drivers.

This backend uses the host-private physical mount backing, not a path granted
to the guest.

For immutable tree reads, the native backend may expose both a lazy object
view and a bulk archive reader internally.  Callers should not observe which
strategy was used except through performance.  A small `lookup('README.md')`
can use `cat-file`; a `storeTree()` over the same revision can use a single
archive stream.

### Future Backends

A JS implementation such as an `isomorphic-git`-style backend remains a
valid future experiment, especially for commit-tree reads or alternate
storage backends.  Adopting one will sharpen the line between `GitBackend`
(essential) and `NativeGitBackend` (native-only) and may surface methods
that should move from one to the other.  Plan for the contract to evolve
rather than treating it as frozen.

Evaluation criteria for any future backend:

- support for the required local workflow surface;
- ability to honor the same confinement and filter/hook restrictions;
- ability to operate through mount / backend abstractions rather than
  ambient host paths;
- ability to provide an efficient bulk tree data plane for large immutable
  reads, whether by native `git archive`, batched object APIs, or direct
  object-database traversal;
- fidelity with native git behavior for merges, rebases, stashes, and index
  semantics where those operations are exposed.

## Security Model

### Authority Separation

| Capability | Allows |
|---|---|
| `EndoMount` | Live worktree filesystem access within one confined root |
| `Git` | Local repository operations over that worktree |
| network capability | Remote repository interaction, if separately granted |
| shell capability | Process execution, if separately granted |

Granting git does not imply shell or network authority.

Remote repository interaction is still required for an agent MVP; it is
specified separately in [daemon-git-remotes](daemon-git-remotes.md) so that
the extra network and credential authority remains explicit.

### Required Restrictions

- No raw git command passthrough.
- No push, pull, fetch, clone, remote mutation, or credential helpers.
- No public config mutation.
- No hooks.
- No aliases.
- No external diff, fsmonitor, textconv, custom filters, merge drivers, or
  signing helpers unless a future explicit capability design authorizes them.
- No accepting arbitrary host paths.
- All path-bearing operations consume `EndoMountEntry` values from the same
  worktree mount.

### Read-Only and Snapshot Interactions

- A read-only worktree mount may support inspection and immutable tree reads
  but must reject mutating git operations.
- `git.trees()` returns a `GitTreeProvider` whose `tree(ref)` returns
  immutable read capabilities; the provider itself never exposes mutation.
- `worktree.snapshot()` remains the way to capture the live worktree into
  content-addressed snapshot storage.

## Agent-Facing Tool Adapters

`Git` is a capability, not necessarily the exact LLM tool schema.  Lal, Fae,
or Genie can adapt it into tool calls:

- resolve user-entered relative paths through the granted worktree mount;
- convert those paths immediately into `EndoMountEntry` values;
- call the git capability with entries;
- present copied relative paths and structured status data back to the LLM.

The existing Fae git tool can survive as a transitional reference branch and
later be replaced by a thin adapter over the proper `Git` capability.

## Implementation Plan

### Phase 0: Mount Prerequisites

Complete the required phases from
[daemon-mount-capabilities](daemon-mount-capabilities.md):

- `snapshot()`;
- `EndoMountEntry`;
- handle-oriented open/create APIs;
- metadata;
- host-private physical backing provenance.

### Phase 1: Backend Contract and Formula Skeleton

- Add `GitBackend` abstraction.
- Add `Git` interface guards and types.
- Add `git` formula type tying a git capability to a mount formula identity.
- Add host method to derive git from an existing physical worktree mount.
- Add exact-repository-root verification.

### Phase 2: Local Inspection Surface

- Implement `worktree`, `status`, `diff`, `log`, `show`, and `revParse`.
- Convert backend path results into `EndoMountEntry` values minted from the
  worktree mount.
- Return structured status entries with optional live nodes when available.

### Phase 3: Local Mutation Surface

- Implement `add`, `restore`, and `commit`.
- Implement branch listing / create / delete / rename / switch.
- Enforce read-only mount rejection on all mutation calls.
- Port the native hardening checks from the reference implementation into
  backend tests.

### Phase 4: Integration Workflows

- Implement merge, rebase, and stash operations.
- Define conflict-state reporting and ensure conflict entries are represented
  by `EndoMountEntry`, not path strings.
- Add restart / persistence tests for long-lived git capabilities.

### Phase 5: Git-Tree Provider

- Implement `GitTreeProvider` as a standalone capability returned by
  `Git.trees()`.
- Implement `GitTreeProvider.tree(ref) -> ReadableTree`.
- Add tests for browsing blobs and subtrees at specific refs.
- Verify compatibility with existing checkin / checkout / stage-tree flows.
- Add a backend-private bulk tree path for large materialization operations,
  initially using `git archive --format=tar` if the native backend remains
  the practical implementation.
- Add a host shortcut for granting `GitTreeProvider` without granting the
  parent `Git` (the read-only-auditor profile).
- Keep the provider separable so it can later be mounted by the VFS
  compositor.

### Phase 6: Agent Adapters and Migration

- Replace path-root Fae git provisioning with a thin adapter over granted
  `Git`.
- Add Lal / Genie registration over the capability rather than over process
  wrappers.
- Deprecate direct path-string git tool creation once capability-based
  provisioning exists.
- Update [daemon-agent-tools](daemon-agent-tools.md) to point at the
  revised model.

## Testing Plan

### Capability Tests

- git can only be derived from a physical mount;
- mount root must equal the actual worktree root;
- entries from another mount are rejected;
- read-only mounts reject mutation;
- no guest-visible method leaks the physical path.

### Workflow Tests

- clean / modified / added / deleted / untracked / conflicted status;
- add / restore / commit;
- branch create / switch / rename / delete;
- merge, rebase, and stash happy paths plus conflicts;
- exact behavior after daemon restart.

### Hardening Tests

- reject executable filters;
- reject merge drivers;
- ignore hooks and global/system config;
- disable network-facing operations;
- reject arbitrary unsupported operations.

### Tree Provider Tests

- browse commit trees;
- load blobs from historical refs;
- use git trees as `ReadableTree` inputs to existing snapshot and staging
  flows;
- materialize a large subtree through the bulk archive path and confirm it
  produces the same CAS / scratch-mount result as the lazy tree walk;
- reject malicious or malformed archive entries during trusted extraction;
- confirm immutability.

## Migration Strategy

1. Preserve the current Fae implementation as a reference branch and test
   corpus.
2. Build the mount prerequisites.
3. Introduce `Git` v1 (text-returning `diff` / `show` / `merge` / `rebase` /
   `stashList` / `stashShow`) without removing any existing ad hoc tool
   immediately.
4. Move agent adapters onto `Git` v1.
5. Retire path-configured wrappers after the capability path is exercised in
   real workflows.
6. Land `Git` v2 with the structured shapes named in § Future Structured
   Result Shapes; rename the v1 text methods to `*Text` so display
   consumers can keep them.

## Open Questions

1. Should `Git.tree(ref)` be the only public git-tree entry point, or should
   there also be a host-facing `provideGitTree()` formula for long-lived
   named trees?
2. Should textual `diff()` remain the first public shape, or should a
   structured hunk model be introduced before broad use?
3. How much conflict state should be modeled structurally in phase 4 rather
   than returned as backend text?
4. Should the initial git formula reference only the worktree mount, or also
   pin the repository identity separately to guard against replacing `.git`
   underneath the mount?
5. Which operations, if any, should be valid over a read-only worktree mount
   beyond inspection and immutable tree access?
6. Should a host-facing `provideGitTree()` or `stageGitTree()` API expose the
   bulk path explicitly, or should it remain only an optimization behind
   existing `ReadableTree` consumers?

## Design Decisions

1. **Git derives from `EndoMount`, by cap-passing.**  `provideGit(mountCap,
   petName)` is the canonical entry point.  Pet-name lookup is a
   convenience that resolves to cap-passing; no host API mints local `Git`
   from a raw path string once the mount model exists.
2. **Entries, not strings, carry path authority.**  Path strings may appear
   at UI boundaries, but git operations consume mount-minted descriptors.
3. **Live worktree and immutable trees are separate capabilities.**
   Mutable worktree operations live on `Git`; immutable revision-tree reads
   live on a separately-granted `GitTreeProvider` obtained via
   `git.trees()`.  This lets a host grant read-only auditor agents tree
   access without the worktree-mutation surface.
4. **Backend choice is best-effort pluggable, not contractually swappable.**
   The v1 contract is shaped for the `NativeGitBackend` extracted from
   `packages/fae`.  A future JS backend may force the essential
   `GitBackend` contract to narrow as native-only methods migrate to
   `NativeGitBackend`.  The contract is allowed to evolve at backend-swap
   time rather than being treated as frozen by v1.
5. **No hidden authority expansion.**  Git does not imply network or shell
   access, and a read-only mount does not become writable through git.
6. **Bulk reads are a backend data plane.**  Large immutable tree operations
   may use native archive streams internally, but that does not change the
   guest-visible capability surface.

## Prompt

> Revise the git capability design so it follows Endo filesystem
> conventions: base live worktree authority on `EndoMount` /
> `EndoMountFile`, use mount-scoped descriptors instead of free-form path
> strings, keep native git as an implementation detail, and expose commit
> trees through the same read-only filesystem vocabulary as the rest of the
> platform.
