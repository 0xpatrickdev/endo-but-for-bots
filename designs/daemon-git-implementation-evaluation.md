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

The native-git adapter runs selected `git` commands through daemon-owned powers.
The execution envelope disables interactive prompting, system/global git config,
hooks, external diff, fsmonitor, pagers, signing, and credential helpers.

The first remote implementation is intentionally conservative:

- remote operations are separate from the base `Git` capability;
- every `GitRemote` is scoped to one daemon-minted local `Git`;
- fetch, pull, and push directions are allowlisted independently;
- pushed and fetched refs can be restricted with `allowedRefs`;
- force push is rejected unless explicitly enabled;
- remote protocols default to `https`;
- `file` and `ssh` remotes require explicit opt-in through `allowedProtocols`;
- credential policy currently accepts only non-secret metadata.

## What This Branch Starts

This branch begins two data-plane changes from the design notes.

First, git trees now expose an `archiveTar()` method.  The daemon's tree
check-in path prefers that method when it is present, parses the native
`git archive --format=tar` output, validates archive entry paths, and stores
regular files, directories, and symlinks into the daemon content store.

Second, `GitRemote` now makes the first remote transport policy explicit.
HTTPS is the default protocol.  Local filesystem remotes and SSH-style remotes
are rejected unless the host opts into those protocols for that capability.
Credential-looking secret fields such as `token`, `password`, `secret`,
`privateKey`, and `passphrase` are rejected at capability construction time.

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

### Current Archive Limit

The initial archive implementation still buffers the tar output through the
existing git command helper.  That is a deliberate first increment, not the
final performance design.

The next archive step should stream stdout from a spawned git process directly
into a tar parser and the content store.  Until then, very large trees can still
hit the native command buffer limit, and a large blob can still transiently live
in memory as part of the full tar output.

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
- remote operations are separated from local repository operations;
- `GitRemote` directions and ref policies are explicit;
- `GitRemote` defaults to HTTPS instead of inheriting arbitrary remote
  transport silently;
- secret-shaped credential fields are rejected rather than stored in formulas
  or echoed through inspect output.

### Remaining Security Gaps

The current remote implementation is not yet a full credential-safe HTTPS
backend.  It is a safer policy envelope around native git remotes.

The main remaining gaps are:

| Gap | Why it matters | Direction |
|---|---|---|
| No sealed credential cap yet | Authenticated HTTPS cannot happen without exposing or ambiently using a secret | Add non-extractable bearer/basic credential capabilities |
| Endpoint policy is protocol-level first | `https` is better than arbitrary transport, but not the same as host/repo allowlisting | Bind remotes to exact origins and repository identities |
| Existing repo remote config is still consulted | A preexisting `origin` can affect operations if the host does not bind an expected URL | Prefer controller-owned endpoint binding over mutable repo config |
| `remote add` mutates `.git/config` | Policy state should not be hidden in mutable repository config | Use trusted temp config or backend-owned config state |
| Credential helper suppression is coarse | Good for safety, but not a complete positive credential story | Inject credentials only through trusted backend code |
| Native git is trusted process code | Any native-git backend inherits git's parser and transport attack surface | Keep backend swappable and narrow inputs |
| Archive tar is parsed in daemon code | Bulk input needs path and type validation | Keep accepting only git archive's regular file / dir / symlink set |
| Revocation is formula-level only | Long-running native git processes need interruption semantics | Connect remote and credential controller revocation to process cancellation |

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

The forward-looking shape is a streaming tar reader:

```text
GitTree.archiveTar()
  -> Reader<base64 chunk>
  -> streaming tar validation
  -> content-store blobs
  -> content-store tree JSON
```

The current branch has the API and validation shape but still buffers the tar
inside the native git helper.

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

1. Land the current archive and HTTPS-default policy increment.
2. Replace buffered `archiveTar()` with a streaming `spawn`-based native git
   path.
3. Add archive tests for nested directories, symlinks, duplicate paths, path
   traversal rejection, and large-tree behavior.
4. Introduce credential capabilities that can be used by trusted backend code
   without giving the guest secret material.
5. Bind `GitRemote` to explicit HTTPS origins and repository URLs, not just
   protocol names.
6. Stop using mutable repository remote config as the policy source of record.
7. Return structured fetch / pull / push summaries with stdout and stderr as
   diagnostic fields, not as the primary API contract.
8. Add audit records for endpoint, refs, direction, result, and credential
   policy label.
9. Add cancellation and revocation tests for in-flight native git processes.
10. Benchmark object-walk check-in versus archive check-in on small, medium, and
    large repositories.

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

