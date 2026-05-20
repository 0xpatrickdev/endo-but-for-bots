# EndoMount Capability Completion Plan

| | |
|---|---|
| **Created** | 2026-05-18 |
| **Updated** | 2026-05-18 |
| **Author** | 0xPatrick (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

`EndoMount` is already useful: it grants live, confined access to one
physical directory, exposes the `ReadableTree` read surface, and returns
`EndoMountFile` handles for existing files.  It is also already relied on
by higher-level workflows such as staging trees into scratch mounts.

However, the current implementation stops one step short of becoming the
general live-filesystem capability that newer agent features need:

- `snapshot()` is part of the interface but still throws.
- The public surface is still primarily path-string based.
- `lookup()` can only produce handles for nodes that already exist.
- There is no mount-scoped descriptor for a deleted, staged, or not-yet-
  created entry.
- The mount surface lacks metadata-oriented operations such as `stat()`.
- The physical path backing a mount is encoded in the formula, but there
  is no explicit host-private way for trusted providers to derive adjacent
  capabilities from that backing without leaking the path through the
  public mount facet.

These gaps matter on their own, and they are blocking for a principled git
capability.  Git needs to discuss files that do not currently have live
handles, and it needs a stable bridge between a public mount capability
and trusted host-side access to the same physical worktree.

This document completes the current `EndoMount` design into the concrete
live-directory capability that [daemon-git-capability](daemon-git-capability.md)
will build on.  It narrows the older speculative filesystem work in
[daemon-capability-filesystem](daemon-capability-filesystem.md) to the
pieces needed by the implementation already in tree.

## Goals

1. Finish the live-mount lifecycle already promised by the interface.
2. Make new filesystem work handle-first while preserving compatibility
   with the existing `ReadableTree`-compatible methods.
3. Introduce a mount-scoped descriptor for entries that may not currently
   exist as live nodes.
4. Align `EndoMount` and `EndoMountFile` with the `Directory` / `File`
   vocabulary in [platform-fs](platform-fs.md).
5. Provide the trusted host-side bridge required for capabilities such as
   git without exposing ambient host paths to guests.

## Non-Goals

- Designing the full multi-provider VFS namespace.
- Replacing `EndoMount` with a new public type in one step.
- Giving guests ambient path access or raw `FilePowers`.
- Making every VFS backend usable as a writable git worktree.
- Solving stable inode identity on Node.js; descriptors in this design are
  mount-relative logical identities, not OS inode handles.

## Current State

### Implemented Today

`EndoMount` currently provides:

- `has(...pathSegments)`
- `list(...pathSegments)`
- `lookup(path)`
- `readText(path)`
- `maybeReadText(path)`
- `writeText(path, content)`
- `remove(path)`
- `move(from, to)`
- `makeDirectory(path)`
- `readOnly()`
- `snapshot()` placeholder

`EndoMountFile` currently provides:

- `text()`
- `streamBase64()`
- `json()`
- `writeText(content)`
- `writeBytes(readableRef)`
- `readOnly()`

The implementation is symlink-aware and confines all resolved paths to the
mount root.  `EndoMount` is already structurally compatible with the read
surface of `ReadableTree`; `EndoMountFile` is already structurally
compatible with the read surface of `ReadableBlob`.

### Existing Related Designs

| Design | Relationship |
|---|---|
| [daemon-mount](daemon-mount.md) | Current implementation note for mount and scratch-mount formulas.  This plan completes the unfinished capability surface. |
| [platform-fs](platform-fs.md) | Shared type lattice for `ReadableBlob`, `ReadableTree`, `File`, `Directory`, `SnapshotBlob`, and `SnapshotTree`. |
| [daemon-capability-filesystem](daemon-capability-filesystem.md) | Broader VFS vision covering `Dir` / `File`, multi-provider backends, and caretaker control. |
| [virtual-filesystem-design](../docs/virtual-filesystem-design.md) | Earlier handle-oriented sketch and logical-node-identity model. |

## Design Principles

### 1. Public Authority Is an Object, Not a Host Path

The guest should hold `EndoMount`, `EndoMountFile`, and related
capabilities.  The guest should not receive the physical path that the
daemon uses internally to implement a mount.

### 2. Strings Select Within a Capability; They Are Not the Capability

Relative strings remain useful for user input and convenience calls, but
they should be consumed to mint mount-owned capabilities.  New APIs should
prefer passing `EndoMountEntry`, `EndoMountFile`, or `EndoMount` values
after that first resolution step.

### 3. Separate Live Handles from Logical Entry References

An existing file can be represented by `EndoMountFile`.  A deleted file,
an untracked path before creation, or a staged path that is absent from the
worktree cannot.  Those require a separate logical descriptor rooted in a
mount.

### 4. Keep the Read Surface Structurally Compatible

Existing code that consumes `ReadableTree` or `ReadableBlob` should
continue to work with mounts and mount files on the read path.

### 5. Make Attenuation Structural Where Practical

`readOnly()` should continue to remove mutation authority.  Future
read-only views should prefer exposing read-only interfaces rather than
only exposing writable methods that throw.

## Capability Model

### Public Facets

| Capability | Role |
|---|---|
| `EndoMount` | Live mutable directory rooted at a confined physical subtree |
| `EndoMountFile` | Live mutable file inside an `EndoMount` |
| `EndoMountEntry` | Mount-scoped logical reference to a normalized relative entry, whether or not that entry currently exists |

### Host-Private Facets

| Capability | Role |
|---|---|
| `EndoMountBacking` | Trusted physical-backing facet or sealed grant for daemon providers that need the real worktree path |
| `EndoMountControl` | Future caretaker facet for host-only mutability / revocation control, if the broader capability-filesystem plan is realized |

`EndoMountBacking` is deliberately not part of the guest-facing interface.
It is the bridge a trusted provider such as native git needs in order to
operate on the same physical worktree without making that path observable
to the guest.  Its purpose is to keep adjacent capabilities such as `Git`
downstream of an already-authorized mount rather than letting them become
parallel raw-path grants.

## Proposed Interfaces

The names below are intentionally explicit about their daemon role.  A
later package-level migration can map them onto `Directory`, `File`, and
related `@endo/platform/fs` vocabulary.

### `EndoMount`

```ts
interface EndoMount {
  // Existing ReadableTree-compatible surface.
  has(...path: string[]): Promise<boolean>;
  list(...path: string[]): Promise<string[]>;
  lookup(path: string | string[] | EndoMountEntry):
    Promise<EndoMount | EndoMountFile>;

  // Descriptor minting.
  entry(path: string | string[]): EndoMountEntry;

  // Handle-oriented navigation and creation.
  openDirectory(path: string | string[] | EndoMountEntry): Promise<EndoMount>;
  openFile(path: string | string[] | EndoMountEntry): Promise<EndoMountFile>;
  createDirectory(path: string | string[] | EndoMountEntry):
    Promise<EndoMount>;
  createFile(path: string | string[] | EndoMountEntry):
    Promise<EndoMountFile>;

  // Metadata.
  stat(path: string | string[] | EndoMountEntry):
    Promise<EndoMountStat | undefined>;

  // Existing convenience I/O.  Retain for compatibility.
  readText(path: string | string[] | EndoMountEntry): Promise<string>;
  maybeReadText(path: string | string[] | EndoMountEntry):
    Promise<string | undefined>;
  writeText(path: string | string[] | EndoMountEntry, content: string):
    Promise<void>;

  // Mutation.
  remove(path: string | string[] | EndoMountEntry): Promise<void>;
  move(
    from: string | string[] | EndoMountEntry,
    to: string | string[] | EndoMountEntry,
  ): Promise<void>;

  // Attenuation and capture.
  readOnly(): EndoMount;
  snapshot(): Promise<SnapshotTree>;
}
```

`lookup()` remains for compatibility with the `ReadableTree` read surface.
New code that wants a concrete node kind should prefer `openDirectory()` or
`openFile()` because those make the expected handle type explicit.

### `EndoMountFile`

```ts
interface EndoMountFile {
  // Existing ReadableBlob-compatible surface.
  text(): Promise<string>;
  streamBase64(): AsyncIterator<string>;
  json(): Promise<unknown>;

  // Mutable File surface.
  writeText(content: string): Promise<void>;
  writeBytes(readableRef: AsyncIterator<Uint8Array>): Promise<void>;
  append(content: string): Promise<void>;
  stat(): Promise<EndoMountStat>;

  // Attenuation and capture.
  readOnly(): EndoMountFile;
  snapshot(): Promise<SnapshotBlob>;
}
```

`streamBase64()` already provides binary read access.  The next increment
should favor file handles over adding more directory-level path convenience
methods for byte I/O.

### `EndoMountEntry`

```ts
interface EndoMountEntry {
  // Copyable presentation data, always mount-relative.
  segments(): string[];
  displayPath(): string;

  // Existence and metadata at the moment of the call.
  exists(): Promise<boolean>;
  stat(): Promise<EndoMountStat | undefined>;

  // Convert to live handles when the node exists.
  lookup(): Promise<EndoMount | EndoMountFile>;
  openDirectory(): Promise<EndoMount>;
  openFile(): Promise<EndoMountFile>;

  // Narrow to a child entry without granting access outside the mount.
  child(name: string): EndoMountEntry;
}
```

An `EndoMountEntry` is a logical mount-relative identity:

- It can represent a missing path.
- It cannot be fabricated by the caller for a different mount.
- It does not claim inode stability.
- It can carry enough relative presentation data for user interfaces and
  status reports without leaking host absolute paths.

The implementation can model an entry as `{ mountGrant, normalizedSegments }`
inside an Exo, with `mountGrant` checked by identity when another capability
accepts the entry.

### `EndoMountStat`

```ts
type EndoMountStat = {
  kind: 'file' | 'directory' | 'symlink';
  sizeBytes?: number;
  modifiedMs?: number;
};
```

This is intentionally narrower than Node's `Stats` object.  It exposes the
portable facts callers commonly need without coupling public APIs to Node.

## Path and Descriptor Semantics

### Path Input

Path strings remain accepted only as relative selectors within an already
granted mount.  They are normalized once when turned into an
`EndoMountEntry`.

Recommended rules:

- Reject empty segments.
- Reject embedded `/`, `\`, or NUL bytes in segment-oriented APIs.
- For descriptor minting, reject `..` rather than silently clamping it.
- Preserve compatibility behavior for older convenience methods until
  callers migrate.

Rejecting traversal when minting descriptors is preferable to preserving a
representation that only becomes safe after later clamping.

### Descriptor Provenance

Any operation accepting `EndoMountEntry` must verify that:

1. The entry was minted by the same mount lineage.
2. The caller is not using an entry from an attenuated view to regain write
   authority removed by `readOnly()`.
3. The normalized path remains confined at operation time after symlink
   resolution.

The third condition preserves the current TOCTOU-resistant confinement
check already used by `EndoMount`.

## Snapshot Semantics

`snapshot()` should become the canonical bridge from live mutable storage to
immutable snapshot storage:

```text
EndoMount.snapshot()
    -> recursively check in the mount read surface
    -> persist readable-blob / readable-tree formulas
    -> return SnapshotTree
```

Implementation should reuse the existing platform checkin machinery rather
than reimplementing traversal:

- `EndoMount` already satisfies the `ReadableTree` read surface.
- `EndoMountFile` already satisfies the `ReadableBlob` read surface.
- The daemon already delegates tree ingestion to
  `@endo/platform/fs/lite` `checkinTree()`.

`snapshot()` must state its consistency guarantee.  The minimum viable
contract is "best-effort point-in-time traversal": if concurrent writers
mutate the live tree during capture, the result is a valid snapshot but not
necessarily one produced from a single filesystem instant.  Stronger
transactional capture can be future work.

## Host-Private Physical Backing

Some trusted providers need more than the public read/write surface.  A git
provider, for example, needs to operate on repository metadata and the
physical worktree together.

Add a host-private backing abstraction:

```ts
interface EndoMountBacking {
  kind(): 'physical';
  // Returned only to trusted daemon code, never to guests.
  getPhysicalRoot(): string;
  grantFor(entry?: EndoMountEntry): SealedMountGrant;
}
```

### Implementation: Hidden Facet on the Mount Formula

The mount formula gains an additional Exo facet — `EndoMountBacking` —
that lives alongside the guest-visible `EndoMount` and `EndoMountFile`
facets but is never returned by any public method.  Trusted daemon code
holds a reference to the backing facet through a private host-side name
table keyed on the mount's formula identifier; guest-visible introspection
(`__getMethodNames__`, `inspect`, etc.) sees only the public facets.

Trade-off rationale (WeakMap vs sealer/unsealer were the other live
options):

- a hidden Exo facet **survives daemon restart trivially** because it is
  reconstituted from the same formula as its sibling public facet, which
  matches `provideGit()`'s expectation that "the mount-derived `Git`
  capability re-derives correctly after restart" without any extra
  persistence machinery;
- a `WeakMap` keyed on the public Exo would not survive restart; every
  `provideGit()` after restart would have to re-derive the backing
  out-of-band, doubling the surface that has to know about mount
  internals;
- a sealer/unsealer pair would need a persisted seal key with its own
  threat model (where does the key live, how is it rotated, who else has
  unseal authority) and adds a separate first-class secret to the daemon.

The hidden-facet implementation:

- guests can pass mounts and entries around without ever observing the
  backing facet;
- trusted providers prove two values belong to the same physical mount by
  identity-checking against the backing facet keyed on the public mount's
  formula id;
- no public method reveals ambient filesystem paths; `getPhysicalRoot()`
  is on the backing facet only.

## Relationship to `@endo/platform/fs`

The intended convergence is:

| Current daemon term | Shared filesystem role |
|---|---|
| `EndoMountFile` | `File` |
| `EndoMount` | `Directory` |
| `EndoMountFile.readOnly()` | `ReadableBlob` view |
| `EndoMount.readOnly()` | `ReadableTree` view |
| `EndoMountFile.snapshot()` | `SnapshotBlob` |
| `EndoMount.snapshot()` | `SnapshotTree` |

This plan does not require renaming the current daemon interfaces first.
Instead, it requires every new method to move toward the shared shape so a
later adapter or migration is mostly mechanical.

## Security Considerations

- **No public physical path leak.**  `displayPath()` is mount-relative only.
- **Descriptor provenance is enforced.**  Callers cannot fabricate entries
  for another mount by passing arbitrary host strings.
- **Symlink confinement remains operation-time.**  A descriptor does not
  bypass realpath checks.
- **Read-only attenuation remains irreversible.**  A read-only mount should
  mint read-only entries and read-only handles.
- **Descriptors are not ambient authority.**  They are useful only with the
  mount lineage that minted them.
- **Missing paths are representable without write authority.**  Merely
  naming a possible entry does not create it or grant mutation.

## Implementation Plan

### Phase 1: Finish the Existing Contract

- Implement `EndoMount.snapshot()`.
- Add integration tests for snapshot round-tripping:
  - live mount -> snapshot tree
  - nested directories
  - binary file streaming
  - symlink confinement behavior
- Update `daemon-mount.md` status once shipped.

### Phase 2: Add Entry Descriptors

- Add `EndoMountEntryInterface`.
- Add `entry(path)` to `EndoMount`.
- Store normalized relative segments plus mount lineage provenance.
- Add `exists()`, `stat()`, `lookup()`, `openFile()`, and
  `openDirectory()` on entries.
- Add descriptor provenance tests:
  - entries from one mount rejected by another mount
  - read-only entries cannot regain write authority
  - missing entries can round-trip without creating files

### Phase 3: Add Handle-Oriented Navigation and Metadata

- Add `openFile`, `openDirectory`, `createFile`, `createDirectory`, and
  `stat` on `EndoMount`.
- Add `stat`, `append`, and `snapshot` on `EndoMountFile`.
- Keep existing path convenience methods for compatibility.
- Update help text and TypeScript declarations together with interface
  guards.

### Phase 4: Add Trusted Backing Provenance

- Introduce the host-private physical-backing facet or sealed-grant
  mechanism.
- Ensure public mounts do not expose backing paths.
- Add tests proving trusted code can correlate a mount with its backing
  while guest-visible introspection cannot recover that path.

### Phase 5: Converge with Shared Filesystem Types

- Add adapters or aliases to make `EndoMount` / `EndoMountFile` satisfy the
  `Directory` / `File` contracts where practical.
- Decide whether `EndoMount` remains a daemon-specific wrapper around
  `Directory` or becomes a daemon-local specialization.
- Keep `ReadableTree` / `ReadableBlob` compatibility tests in place during
  migration.

## Migration Notes

- Existing users of `list`, `lookup`, `readText`, `writeText`, `remove`,
  and `move` continue to work.
- New code that performs more than one operation on the same node should
  prefer entries and handles.
- Git should depend on `EndoMountEntry`, not on free-form relative path
  strings.
- Future Fae / Lal filesystem tools should expose user-friendly path
  arguments at the tool boundary, then immediately convert them into mount
  entries internally.

## Open Questions

1. Should `readOnly()` return a structurally narrower `ReadableTree`
   interface once shared `Directory` / `File` adoption is complete, or keep
   the current daemon convention of same-named Exos whose writes throw?
2. Should `entry(path)` accept multi-segment arrays only, or also preserve a
   slash-delimited string convenience form?
3. Should `EndoMountEntry.displayPath()` be public, or should callers carry
   their own presentation string separately from the capability?
4. Should `snapshot()` remain best-effort, or should physical mounts grow a
   stronger capture mode before it is used for build reproducibility?
5. When the full VFS namespace arrives, should descriptors be mount-local or
   namespace-local?

## Prompt

> Finish the concrete `EndoMount` capability so it can serve as the live,
> handle-first filesystem basis for future agent tools and for a revised git
> capability.  Preserve today's useful read compatibility, add the missing
> snapshot bridge, and introduce mount-scoped descriptors for paths that do
> not currently have live file handles.
