# A Unified Git Surface Without Unified Authority

| | |
|---|---|
| **Created** | 2026-07-09 |
| **Updated** | 2026-07-09 |
| **Author** | 0xpatrickdev (prompted) |
| **Status** | Draft |

## Motivation

An agent working in a repository wants one coherent way to find its local git
operations, authorized remotes, and any elevated history-editing operations.
Today those capabilities are intentionally separate: local `Git`, a bound
`GitRemote`, and the narrower history-rewrite surface.
That separation should not make the agent reconstruct the capability topology
from unrelated petnames.

The answer is to unify navigation and the code-mode object shape, not to merge
the authorities.

## Preserve the Authority Boundary

`Git` is authority over one already-authorized local worktree.
It deliberately excludes network, endpoint, and credential authority.
`GitRemote` is the visible composition of a writable `Git` with one remote
endpoint's transport, credential, direction, and refspec policy.

Making remote access a `Git` method, or accepting it as a construction option,
would dissolve that boundary.
Every holder of a local commit capability would thereby become a network
principal, despite neither needing nor being authorized for the endpoint or its
credential.
It would also hide the independently revocable parts of the composition that
the remote design deliberately makes visible.

The construction channels make the distinction sharp.
`makeGit(powers, opts)` takes authorities such as `mount`, `backend`, and
`lineageOf` as powers, while `readOnly` and `allowHistoryRewrite` are options
that attenuate the authority already supplied.
A remote is not attenuation configuration: it brings a URL, transport, and
credential authority; one worktree can have several remotes with different
policies; and each one must be revocable separately.
It therefore belongs in the power/composition channel, never in `Git` options.

Clone confirms the same boundary.
At clone time there is no existing repository `Git` capability to call.
`makeGitCloner` instead composes a `GitRemoteEndpoint` with an empty destination
mount, then returns the freshly derived `Git` and its pre-bound remote.
Making `clone` a `Git` method would erase the constructive seam that correctly
exists before local repository authority does.

## Proposed Unified Surface

The host provisions remote capabilities separately, then binds their discovery
to the corresponding local `Git` surface.
The binding is a navigation relation, not a way to mint, retarget, or widen a
remote.

```ts
interface Git {
  remote(name: string): Promise<GitRemote | undefined>;
  remotes(): Promise<GitRemoteSet>;
}
```

`remote(name)` returns only the separately authorized remote bound under that
name.
It must not accept a URL or expose transport or credential components.
`remotes()` is a collection view for discovering only the names and remote
capabilities the holder is authorized to use; it can be backed by the
`GitRemoteSet` already anticipated by the remote design.
Revoking a remote removes or invalidates that entry without changing the local
`Git`, and revoking local `Git` invalidates the bound remotes that compose it.

Code mode should use sibling globals that appear only when their capabilities
are granted:

```js
// A normal local-worktree grant.
git.status();
git.commit('Update documentation');

// A separately granted, policy-bound remote capability.
gitRemote.push({ source: 'agent/topic', destination: 'agent/topic' });

// A separately granted elevated capability.
gitHistory.reword('HEAD', 'Clarify documentation');
```

The existing history-rewrite split is the precedent.
The normal `git` global does not advertise amend or reword operations, while
the elevated `gitHistory` global exposes only the history-rewrite subset when
that authority is granted.
Likewise, a `gitRemote` global should be generated from the separately granted
`GitRemote` type rather than being implied by possession of `git`.
The globals provide a coherent mental model without making every agent that can
commit able to contact a network endpoint or rewrite history.

The `Git.remote(name)` navigation relation and the `gitRemote` global are
complementary.
The first helps code that starts from a local repository object discover an
already-bound remote.
The second keeps code-mode declarations explicit and useful when a host grants
only a remote, or chooses petnames that do not follow the default naming.

## Phasing and Open Questions

This is forward-looking design, not an implementation commitment.
It fits the future-work layer of [daemon-git-next-steps](daemon-git-next-steps.md)
after the local `Git`, remote composition, and historical-read layers are
stable.

1. Define the authorized remotes-accessor contract and decide whether
   `remote(name)` returns `undefined`, rejects an unknown name, or uses a
   result shape that can distinguish unknown from revoked.
2. Decide whether `remotes()` enumerates names, returns a `GitRemoteSet`, or
   offers both operations, while preserving per-remote grant filtering.
3. Specify how `GitCloner` presents its initial `origin` in the same navigation
   surface without pretending clone was an operation on an existing `Git`.
4. Decide whether the roadmap's `GitRemoteSet` is the backing capability for
   `Git.remotes()`, including its revocation and controller interaction.
5. Add generated code-mode declarations for `GitRemote` and retain sibling
   globals for `git`, `gitRemote`, and `gitHistory` rather than a single
   authority-flattening global.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-git-capability](daemon-git-capability.md) | Defines the local `Git` authority and its attenuation options. |
| [daemon-git-remotes](daemon-git-remotes.md) | Defines `GitRemote` as separately authorized endpoint, transport, credential, and local-`Git` composition. |
| [daemon-git-next-steps](daemon-git-next-steps.md) | Supplies the layered roadmap and future-work placement. |
| [agentry-git-verb-gaps](agentry-git-verb-gaps.md) | Establishes the code-mode local-history surface that the elevated `gitHistory` global separates from ordinary `git`. |

## Prompt

> Design one coherent git surface for agents while preserving the separate
> local-repository, remote, credential, endpoint, and history-rewrite
> authorities.
