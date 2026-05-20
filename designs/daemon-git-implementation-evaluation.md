# Daemon Git Implementation Evaluation

| | |
|---|---|
| **Created** | 2026-05-20 |
| **Updated** | 2026-05-20 |
| **Author** | 0xPatrick (prompted) |
| **Status** | In Progress |

## Purpose

This document evaluates the current daemon git implementation against the
local-git and remote-git designs:

- [daemon-git-capability](daemon-git-capability.md)
- [daemon-git-remotes](daemon-git-remotes.md)

The goal is to keep the implementation honest about what has landed, what is
only policy shape, and where the next performance and security work should go.

## Current Implementation Shape

The implementation is currently native-git backed.  The daemon does not expose
raw shell access or raw `git` passthrough.  Instead, `Host.provideGit()` derives
a bounded `Git` capability from an existing daemon-minted `EndoMount`.

The important authority boundaries are:

| Surface | Authority carried |
|---|---|
| `EndoMount` | local filesystem authority for one mounted worktree |
| `Git` | bounded local repository and worktree operations for that mount |
| `GitTree` | immutable read authority for one git tree object |
| `GitRemote` | bounded use of one remote name for fetch / pull / push |
| `GitCredential` | non-extractable bearer/basic credential metadata and sealed use |
| `GitRemoteController` / `GitCredentialController` | host-held policy, audit, rotation, and revocation |

The native-git adapter runs selected `git` commands through daemon-owned powers.
The execution envelope disables interactive prompting, system/global git config,
hooks, external diff, fsmonitor, pagers, signing, and ambient credential
helpers.  Credentialed HTTPS calls opt into one daemon-owned helper for that
single invocation.

The first remote implementation is intentionally conservative:

- remote operations are separate from the base `Git` capability;
- every `GitRemote` is scoped to one daemon-minted local `Git`;
- fetch, pull, and push directions are allowlisted independently;
- pushed and fetched refs can be restricted with `allowedRefs`;
- force push is rejected unless explicitly enabled;
- remote protocols default to `https`;
- `file` and `ssh` remotes require explicit opt-in through `allowedProtocols`;
- credential policy accepts either non-secret metadata or a daemon-minted
  non-extractable `GitCredential`;
- remote and credential controllers persist policy, audit, rotation, and
  revocation sidecars across daemon restart.

## What This Branch Starts

This branch begins two data-plane changes from the design notes.

First, git trees now expose an `archiveTar()` method.  The daemon's tree
check-in path prefers that method when it is present, parses the native
`git archive --format=tar` output, validates archive entry paths, and stores
regular files and directories into the daemon content store.  Symlinks and
unsupported modes are rejected until the mount/tree design has a portable
symlink policy.

Second, `GitRemote` now makes the first remote transport policy explicit.
HTTPS is the default protocol.  Local filesystem remotes and SSH-style remotes
are rejected unless the host opts into those protocols for that capability.
Credential-looking secret fields such as `token`, `password`, `secret`,
`privateKey`, and `passphrase` are rejected at capability construction time.

Third, bearer and basic credentials are represented by non-extractable daemon
capabilities.  Credential formulas contain only metadata; secret material lives
in daemon-side sealed state and is supplied to native git only by trusted
backend code.  Remote and credential controllers add the first restart-durable
policy update, audit, rotation, and revocation surfaces.

## Performance Evaluation

### Local Worktree Operations

Single-command operations such as status, add, commit, branch, checkout, diff,
and stash are acceptable native-git shell-outs.  Their cost is dominated by git
itself and repository size, not by the daemon capability wrapper.

The bigger cost appears when a daemon surface causes many small turns or many
small subprocesses:

- walking an immutable git tree one directory or blob at a time;
- materializing a large tree into the daemon content store;
- reading large blobs through per-file calls;
- moving many files through CapTP rather than through a native bulk format.

Those are the cases where the quiet part of "amortize the shell-out" matters.
If the backend must use native git, it should use git operations that move an
entire tree, pack, or batch through one process.

### Git Tree Check-In

Before this branch, `Host.storeTree(gitTree)` used the generic platform tree
walker.  That is correct but inefficient for git-backed trees because it turns
one immutable git tree into many object method calls and, depending on lookup
patterns, many native git reads.

The new `GitTree.archiveTar()` path gives the daemon one bulk tree stream:

```text
git archive --format=tar <tree>
  -> daemon tar validator
  -> content-store blobs and tree JSON
```

That is the right shape for immutable tree materialization because it moves a
whole tree through one native git command and one daemon parser.  It also keeps
the data plane local and binary, rather than stretching tree contents across
many CapTP messages.

### Current Archive Shape

The archive implementation now uses a spawned native git process and streams
stdout through the daemon's existing base64 reader-ref boundary.  The daemon
decodes and parses the tar stream incrementally, validates each entry before
storing it, and rejects path traversal, duplicate paths, unsupported modes, and
symlinks.  That removes the full-archive buffer that existed in the first
data-plane increment.  The daemon only selects this archive acceleration for
GitTree objects registered by the local trusted backend; arbitrary guest objects
that happen to expose an `archiveTar` method fall back to the normal
`ReadableTree` check-in path.

The remaining work is measurement rather than a known buffering bug: benchmark
the generic object-walk check-in path against archive check-in on small,
medium, and large repositories, then keep the faster path behind the
backend-neutral `ReadableTree` contract.

Benchmark note, 2026-05-20: a local proxy benchmark compared a generic
object-walk shape (`git ls-tree -rz -r` plus one `git cat-file blob` process per
file) with the archive shape (`git archive --format=tar HEAD`) on generated
repositories.  This measures the native process/data-plane difference, not the
full daemon content-store write cost.

| Size | Files | Payload bytes | Object-walk wall time | Archive wall time |
|---|---:|---:|---:|---:|
| small | 25 | 25,600 | 332 ms | 14 ms |
| medium | 500 | 512,000 | 6,724 ms | 42 ms |
| large | 2,000 | 4,096,000 | 26,579 ms | 135 ms |

The result is directionally strong enough to keep the archive path as the
preferred daemon check-in acceleration and to reserve object-walk fallback for
non-git `ReadableTree` providers.

### Remote Fetch and Push

Remote git already has an efficient native data plane: git packfiles.  The
daemon should not route packfile bytes through CapTP in the normal case.  CapTP
should carry:

- the authority to use the remote;
- operation requests;
- policy;
- summaries, diagnostics, and audit records.

The packfile bytes should move through a bounded git transport.  For the first
real authenticated implementation, that transport should be HTTPS.

Future Noise-based transport is only relevant if Endo controls both endpoints
or has a strong reason to run git object exchange over an Endo-native channel.
It should not block the HTTPS-first implementation.

### Other Shell-Out Amortization Points

If an isomorphic-git backend is not adequate, native git can still be made
tractable by choosing bulk commands:

| Need | Native git shape |
|---|---|
| snapshot a full immutable tree | `git archive --format=tar <tree>` |
| read many objects | `git cat-file --batch` / `--batch-check` |
| inspect a full tree | `git ls-tree -rz -r <tree>` |
| import many staged paths | index-oriented batch commands where possible |
| fetch or push remote objects | native packfile transport |

The public capability API should remain backend-neutral, but the native backend
should be allowed to use these bulk data paths internally.

## Security Evaluation

### What Is Strong Now

The implementation has several good least-authority properties:

- local git authority derives from an `EndoMount`, not an arbitrary path string;
- read-only mounts cannot be upgraded into writable git capabilities;
- git path arguments are normalized against mount entries or git refs;
- raw command passthrough is not exposed;
- native git runs with a constrained environment;
- ambient prompts, pagers, external diff, signing, hooks, and credential helpers
  are suppressed;
- repository git-dir and common-dir filesystem identities are pinned after the
  first operation, so replacing `.git` under a mounted worktree fails closed;
- remote operations are separated from local repository operations;
- `GitRemote` directions and ref policies are explicit;
- `GitRemote` defaults to HTTPS instead of inheriting arbitrary remote
  transport silently;
- `GitRemote` push rejects raw refspec syntax, deletes, tags, and force by
  default;
- secret-shaped credential fields are rejected rather than stored in formulas
  or echoed through inspect output.
- bearer/basic credentials are daemon-minted, non-extractable capabilities;
- credential secret material is absent from formulas, inspect output, command
  arguments, logs, and guest-visible values;
- credential audience is checked against the remote URL before invoking native
  git;
- remote controllers can update direction/ref/push policy, record audit
  entries, and revoke a remote across daemon restart;
- credential controllers can rotate or revoke sealed credential state across
  daemon restart.

### Remaining Security Gaps

The current remote implementation is now a credential-bearing HTTPS-capable
native-git backend, but it is still a conservative first implementation.

The main remaining gaps are:

| Gap | Why it matters | Direction |
|---|---|---|
| Endpoint policy is protocol-level first | `https` is better than arbitrary transport, but not the same as host/repo allowlisting | Bind remotes to exact origins and repository identities |
| Existing repo remote config is still consulted when no explicit URL is supplied | A preexisting `origin` can affect operations if the host does not bind an expected URL | Prefer explicit endpoint binding and controller-owned policy over mutable repo config |
| Credential helper injection uses a helper command plus sealed-state path | The secret value is absent from argv/env, but a pipe/fd helper would further narrow process-visible metadata | Move from helper-file state reads to trusted pipe or fd-passing once portability is verified |
| Native git is trusted process code | Any native-git backend inherits git's parser and transport attack surface | Keep backend swappable and narrow inputs |
| Archive tar is parsed in daemon code | Bulk input needs path and type validation | Keep accepting only regular file and directory entries until symlink policy is designed |
| In-flight revocation does not interrupt already-running native git | Long-running native git processes need interruption semantics | Connect remote and credential controller revocation to process cancellation |

The most important principle is that the guest-visible `GitRemote` should never
receive a token, private key, credential-helper output, or arbitrary network
capability.  It should receive only the ability to ask trusted code to perform
bounded git operations against one approved endpoint.

## Data Plane Guidance

There are three data planes to keep distinct.

### CapTP Control Plane

CapTP is the right place for:

- capability handoff;
- operation invocation;
- policy inspection;
- small summaries;
- structured results;
- revocation control.

CapTP is not the right default path for large git tree contents or packfiles.

### Local Bulk Tree Plane

`git archive` is the right first local bulk data plane for immutable git trees.
It gives one bounded command that emits a standard archive format.  The daemon
can validate paths and entry types before committing content to the content
store.

The current shape is a streaming tar reader:

```text
GitTree.archiveTar()
  -> Reader<base64 chunk>
  -> streaming tar validation
  -> content-store blobs
  -> content-store tree JSON
```

This is intentionally an internal acceleration path for daemon tree check-in,
not a reason to make arbitrary host archives a general guest-visible authority.

### Remote Packfile Plane

For remote object transfer, the forward-looking shape is:

```text
GitRemote.fetch()
  -> trusted HTTPS git backend
  -> endpoint policy check
  -> sealed credential use
  -> native git packfile exchange
  -> structured summary back over CapTP
```

This keeps GitRemote out of the CapTP data plane while still making all
authority explicit.

## Near-Term Implementation Plan

1. Add archive tests for nested directories, duplicate paths, path traversal
   rejection, and larger-tree behavior beyond the current symlink rejection
   coverage.
2. Keep tightening `GitRemote` around explicit endpoint policy rather than
   mutable repository remote config.
3. Bind `GitRemote` to explicit HTTPS origins and repository URLs, not just
   protocol names.
4. Extend structured fetch / pull / push summaries with updated-ref detail and
   audit-safe stderr separation.
5. Add audit records for endpoint, refs, direction, result, and credential
   policy label.
6. Add cancellation and revocation tests for in-flight native git processes.

## Longer-Term Backend Options

The public API should not commit Endo to native git forever.

| Backend | Why it might be useful | Constraint |
|---|---|---|
| native git | complete compatibility and efficient packfile / archive support | trusted process boundary and shell-out cost |
| isomorphic-git | tighter JS embedding and fewer process launches | may lag git behavior and remote edge cases |
| daemon-native object store | strongest integration with Endo CAS | largest implementation cost |
| Noise-backed remote transport | Endo-native authenticated channel | only worth it when both endpoints are under Endo control |

The practical path is HTTPS-first native git with a backend-neutral public
capability contract.

## Success Criteria

The git data-plane work is on track when:

- storing a git tree uses one bulk archive stream rather than one object turn
  per file;
- large git tree check-in streams instead of buffering whole archives;
- `GitRemote` cannot use `file`, `ssh`, or arbitrary protocols by default;
- authenticated remotes can use credentials without exposing them through
  formulas, inspect output, logs, command arguments, or guest-visible values;
- remote operations bind endpoint, credential audience, allowed refs, and
  direction before any network traffic starts;
- fetch and push move packfiles over a bounded transport instead of CapTP;
- failures report structured policy or git errors that are safe to show to the
  guest.
