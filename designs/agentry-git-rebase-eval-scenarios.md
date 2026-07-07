# Agentry Git Rebase Eval Scenarios

| | |
|---|---|
| **Created** | 2026-07-07 |
| **Source session** | Reflog for `refactor/types-shim-retirement`, 2026-07-07 10:44-12:27 EDT |
| **Status** | Working inventory |

## Summary

This note distills one heavy local rebase session into candidate tests for the
ocap Git interface used by the coding-agent harness.
The exact Codex tool-call transcript was recovered from the local Codex session
store and extracted into
[agentry-git-rebase-tool-transcript.txt](agentry-git-rebase-tool-transcript.txt).
It contains 398 exact `exec_command` calls and 6 `write_stdin` calls.
The reflog summary below is still useful as a Git-history skeleton, but the
tool transcript is the authoritative command source.

The main finding is that the `EndoGit` capability already covers most ordinary
local version-control operations needed by a rebase-capable agent: inspect,
stage, commit, switch branches, merge, rebase, stash, and read historical
trees.
The current JSON-safe `@endo/agent-tools` Git slice is intentionally narrower.
Scenarios that need path-bearing `EndoMountEntry` values, conflict resolution,
or rebase control should run through the code-mode `execute` surface for now.

## Final Stack

The final branch tip was:

```text
473b718b3 test(exo-git): assert EndoGit contract
2fe2b0db6 fix(exo-git): align Git contract with guards
1ba52e9f5 refactor(git): move native backend types to TypeScript
f8123b2c7 fix(lal): include prompts and tools in type build
d66853793 docs: clarify type build cleanup
2b70d4dc0 test(agent-tools): type filesystem fixture
2cd764581 chore: Update yarn.lock
2382bb465 refactor(cancel): move exported types to TypeScript
41f6d2880 refactor(git): retire ambient type shim
199bb9dae refactor(exo-git): retire ambient type shim
41ce90ce4 refactor(fs): retire ambient type shim
```

The final worktree was clean after the rebase.

## Source Artifacts

- Full tool-call transcript:
  [agentry-git-rebase-tool-transcript.txt](agentry-git-rebase-tool-transcript.txt).
- Source Codex session:
  `/Users/pcooney10/.codex/sessions/2026/07/07/rollout-2026-07-07T10-45-53-019f3d0a-e943-70f1-b1ec-be4dc66ea13a.jsonl`.
- Git recovery skeleton:
  `git reflog --date=iso --max-count=80`.

## Transcript Summary

The recovered transcript has 38 user turns and 398 `exec_command` calls.
It is a stronger test source than reflog because it captures the agent's
read/verify/edit loop, not just the Git commands that moved `HEAD`.

Top command categories:

| Category | Count | Notes |
|---|---:|---|
| `sed` inspection | 59 | Small, targeted source/config reads. |
| `git status` | 44 | Constant state checks before and after risky steps. |
| `git diff` | 43 | Worktree, cached, and historical diff inspection. |
| `rg` inspection | 33 | Codebase search before edits. |
| `git show` | 31 | Commit and path archaeology. |
| `yarn lint:types` | 16 | Focused type-test verification. |
| `git log` | 15 | Stack-shape and author verification. |
| `git add` | 11 | Staging chosen paths before commit/rebase continue. |
| `yarn lint` | 10 | Package/root lint checks. |
| package-local `yarn` | 10 | `cd packages/... && yarn ...`. |
| `yarn build:types*` | 21 | Build, clean, and generated-config verification. |
| `gh` commands | 16 | PR body/title updates and CI diagnosis. |
| scripted rebase | 5 | Autosquash, conflict continue, and reword flows. |

## Observed Workflow

The transcript shows a realistic agent loop:

- inspected package configs, generated composite configs, source files, and
  historical commits with `rg`, `sed`, `git show`, and `git diff`;
- reproduced the initial failure with `yarn build:types`;
- explored stale declaration-output cleanup with `git clean -ndX`,
  `yarn build:types:clean`, `yarn clean`, and `yarn build:types`;
- converted and verified `cancel` type exports with `types-index` files;
- configured the repository identity with
  `git config user.name 0xpatrickbot` and
  `git config user.email patchrick@0xpatrick.dev`;
- split `d5820f7` into separate `fs`, `exo-git`, `git`, and `cancel` commits
  using `git stash`, `git reset --hard`, `git checkout <commit> -- <paths>`,
  `git rm`, `git add`, and `git commit`;
- cherry-picked two existing commits with `git cherry-pick 88b0a48d1 ad0b6cbac`;
- created fixup commits and folded them with
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ...`;
- resolved rebase conflicts with `git checkout --ours` / `--theirs`,
  regenerated code-mode types, staged the resolution, and ran
  `GIT_EDITOR=: git rebase --continue`;
- reworded a commit non-interactively with scripted `GIT_SEQUENCE_EDITOR` and
  `GIT_EDITOR`;
- updated PR #623 with `gh pr edit`, inspected CI with `gh pr checks`,
  `gh api`, and `gh run view`;
- repeatedly verified with package-local `yarn lint`, `yarn lint:types`,
  `yarn test`, `yarn test:c8`, `yarn build:types:check`, and
  `yarn clean && yarn build:types`;
- force-pushed with `git push --force-with-lease origin
  refactor/types-shim-retirement`.

## Git History Skeleton

Reflog remains useful for reconstructing stack movement:

- branch checkout from `llm` to `refactor/types-shim-retirement`;
- reset to the parent of `d5820f7` before rebuilding the split stack;
- new commits for `fs`, `exo-git`, `git`, `cancel`, docs, and `lal`;
- cherry-picks of two existing commits;
- fixup commits for `fs` and `exo-git`;
- autosquash rebase with conflicts and `rebase --continue`;
- interactive reword of the `agent-tools` test commit;
- later reset of the top test commit, extraction of mixed-in fixes, and final
  autosquash rebase;
- final `git push --force-with-lease`.

## Coverage Against EndoGit

This table is scoped to the operations exercised or implied by the session.
"Code-mode" means the generated `git` global from
`packages/agentry/src/execute/git-types.js`.
"JSON tools" means `packages/agent-tools/src/git-tool.js`.

| Workflow need | EndoGit | Code-mode | JSON tools | Notes |
|---|---|---|---|---|
| Inspect status | ✅ | ✅ | ❌ | JSON tools need capref/result support for rows. |
| Inspect diff | ✅ | ✅ | ✅ | Text diff is available. |
| Inspect history | ✅ | ✅ | ✅/❌ | JSON tools expose `log` and `show`, not `revParse`. |
| List/current branch | ✅ | ✅ | ✅ | `branches()` and `currentBranch()`. |
| Switch branches | ✅ | ✅ | ✅/❌ | JSON tools expose `switchBranch`, not `switch`/`detach`. |
| Create/delete/rename branch | ✅ | ✅ | ✅/❌ | JSON tools expose create only. |
| Stage paths | ✅ | ✅ | ❌ | Requires `EndoMountEntry` handles. |
| Unstage/restore paths | ✅ | ✅ | ❌ | Requires `EndoMountEntry` handles. |
| Commit | ✅ | ✅ | ✅ | `commit(message)`. |
| Commit amend | ❌ | ❌ | ❌ | Not in current design. |
| Reset commit stack | ❌ | ❌ | ❌ | Not in current design. |
| Cherry-pick | ❌ | ❌ | ❌ | Not in current design. |
| Merge | ✅ | ✅ | ❌ | `merge(ref, { fastForwardOnly, noFastForward })`. |
| Rebase start/continue/abort/skip | ✅ | ✅ | ❌ | Non-interactive rebase control. |
| Interactive rebase reword/edit | ❌ | ❌ | ❌ | No interactive/todo API. |
| Autosquash fixup commits | ✅/❌ | ✅/❌ | ✅/❌ | Fixup commit message yes; autosquash flag no. |
| Stash dirty work | ✅ | ✅ | ❌ | Push/list/show/apply/pop/drop. |
| Pull/fetch/push | ✅ | ❌ | ❌ | Implemented on `GitRemote`, not local `Git`. |
| Clone/bootstrap | ❌ | ❌ | ❌ | Planned as future `provideGitClone` work. |
| Historical read | ✅ | ✅ | ❌ | `tree(ref)` and `filesystemAt(ref)`. |
| Structured conflicts/results | ❌ | ❌ | ❌ | Planned Phase 7 shape upgrade. |

## Scenario Shape

The existing `stage-and-commit` scenario is a good template:

- provision a real repository fixture;
- provide `workspace`, `git`, and a `readText` helper;
- express the task as one prompt;
- assert only the final cap-visible state.

For rebase-oriented scenarios, keep the same shape but add fixture helpers that
construct a small branch graph.
Avoid asking the scorer to verify every intermediate command.
The model may legitimately solve the task with a different sequence as long as
the final repository state and authority boundaries match.

## Transcript-Derived Scenarios

### 1. `triage-build-types-file-list`

Transcript source:
The first turn diagnosed `packages/lal` TS6307 errors, inspected tsconfigs, and
confirmed the fix with `yarn build:types`.

Fixture:
`packages/lal/tsconfig.json` omits `tools/` and `prompts/` from its includes.
The working tree is otherwise clean.

Prompt:
Fix the composite type-build file-list errors for `packages/lal`.
Commit the minimal package-config change.

Expected:
The top commit changes only `packages/lal/tsconfig.json`.
`yarn build:types` succeeds.
`status()` is clean.

Primary APIs:
`status()`, `diff()`, `add()`, `commit()`, plus a harness test-command power.

### 2. `type-output-cleanup-diagnosis`

Transcript source:
The session compared `yarn build:types:clean`, manual ignored-output cleanup,
`yarn clean`, and `yarn build:types`.

Fixture:
Stale generated `.d.ts` outputs exist beside checked source files, causing a
TS5055-style declaration overwrite failure.

Prompt:
Diagnose why the type build fails after generated declaration files are stale.
Use the repository's documented cleanup path, then update `AGENTS.md` with the
maintainer note.

Expected:
The docs commit updates only `AGENTS.md`.
`yarn clean && yarn build:types` succeeds.
The final stack keeps this as a standalone docs commit.

Primary APIs:
`status()`, `diff()`, `add()`, `commit()`, plus shell/test-command power.

### 3. `commit-split-from-mixed-change`

Transcript source:
The user asked to split `d5820f7` into `fs`, `exo-git`, `git`, and `cancel`
commits while preserving unrelated dirty work.

Fixture:
A branch contains one mixed commit touching four package domains and has dirty
follow-up changes in the worktree.

Prompt:
Split the mixed commit into separate commits by domain.
Preserve the dirty follow-up work and restore it after the split.

Expected:
The final stack has separate conventional commits for each package domain.
No dirty work is lost.
The worktree is clean.

Primary operations observed:
`stashPush({ includeUntracked: true })`, branch backup, reset to the mixed
commit's parent, checkout selected paths from the mixed commit, add, commit,
stash inspection, and stash drop.

EndoGit coverage:
Stash/add/commit are covered.
Reset, backup branch naming policy, and checkout-paths-from-commit are gaps.

### 4. `recover-index-and-untracked-from-stash`

Transcript source:
The session inspected `stash@{0}`, `stash@{0}^2`, and `stash@{0}^3` to recover
tracked, index, and untracked pieces separately.

Fixture:
A stash contains tracked changes, staged changes, and untracked files.
Only the `cancel` package subset should be restored into a new commit.

Prompt:
Recover only the `cancel` type-export changes from the saved stash and commit
them as `refactor(cancel): move exported types to TypeScript`.

Expected:
The commit contains the intended tracked and untracked `cancel` files.
Unrelated stashed paths are not restored.
The stash is dropped only after the intended commit exists.

Primary operations observed:
`stashList()`, `stashShow()`, historical tree inspection of stash parents,
path checkout from stash parents, `git rm`, add, commit.

EndoGit coverage:
Current stash methods are too coarse for selective stash-parent recovery.
This is a design-pressure scenario.

### 5. `cherry-pick-known-commits`

Transcript source:
Two existing commits were cherry-picked into the rebuilt stack.

Fixture:
A branch has been reset to a rebuilt stack.
Two known commits exist elsewhere in repository history and should be replayed.

Prompt:
Replay the existing code-mode and lockfile commits onto the current branch in
order.

Expected:
The two commit summaries appear in order on the branch.
The worktree is clean.

Primary operations observed:
`git cherry-pick 88b0a48d1 ad0b6cbac`.

EndoGit coverage:
There is no `cherryPick()` method.
This is a design-pressure scenario if replaying known commits is in scope.

### 6. `fixup-autosquash-with-generated-conflicts`

Transcript source:
The session created `fixup!` commits, ran autosquash rebase, hit generated-file
conflicts, regenerated code-mode types, staged the resolution, and continued.

Fixture:
A branch has an older generated code-mode artifact and a fixup commit that
touches the generator inputs.
Autosquash produces conflicts in generated files.

Prompt:
Autosquash the fixup commits.
When generated artifacts conflict, keep the correct source side, regenerate the
artifacts, stage them, and continue the rebase.

Expected:
The fixup commits are folded into their targets.
Generated files match the generator output.
`status()` is clean.

Primary operations observed:
`commit --fixup`, `rebase -i --autosquash`, `checkout --ours/--theirs`,
generator command, add, `rebase --continue`.

EndoGit coverage:
Fixup messages can be produced with `commit(message)`, and
`rebase({ mode: 'continue' })` exists.
Autosquash and ours/theirs conflict checkout are not exposed.

### 7. `reword-commit-during-stack-cleanup`

Transcript source:
The session reworded `a3ffee1c4` to
`test(agent-tools): type filesystem fixture` with scripted editors.

Fixture:
A branch stack contains a commit with the right diff and the wrong summary.

Prompt:
Rename that commit without changing its diff.

Expected:
The commit has the new summary.
The tree for the reworded commit is unchanged.
The worktree is clean.

Primary operations observed:
Scripted `GIT_SEQUENCE_EDITOR` plus `GIT_EDITOR` around `git rebase -i`.

EndoGit coverage:
No interactive rebase todo or commit reword API exists.
This is a design-pressure scenario.

### 8. `extract-fixes-from-top-test-commit`

Transcript source:
After CI review, the user noticed fixes mixed into a test commit.
The session reset the top commit, amended one prior commit, and committed the
remaining test-only change.

Fixture:
The top commit contains both test additions and production fixes.
The production fixes belong in the previous commit.

Prompt:
Move production fixes out of the top test commit and into the preceding fix
commit.
Leave the top commit test-only.

Expected:
The previous commit contains the production fixes.
The top commit contains only test files.
The branch history remains linear and clean.

Primary operations observed:
`git reset --mixed HEAD^`, selective add, `commit --amend --no-edit`,
selective add, new commit.

EndoGit coverage:
Selective add and ordinary commit are covered.
Mixed reset and amend are not.

### 9. `ci-failure-to-minimal-fix`

Transcript source:
The session inspected GitHub check status, downloaded logs, reproduced a
package failure locally, found a schema mismatch, and folded the fix into the
right commit.

Fixture:
A PR has failing checks.
The local branch contains the same candidate stack.

Prompt:
Find the failing check, identify the minimal code fix, verify locally, and fold
the fix into the appropriate commit.

Expected:
The failing package test passes locally.
The fix lands in the commit that introduced the incompatible behavior.
The PR can be force-pushed with lease.

Primary operations observed:
`gh pr checks`, `gh api`, `gh run view`, package `yarn test`/`test:c8`,
selective add, amend/fixup, autosquash.

EndoGit coverage:
Local Git covers the commit/fixup pieces partially.
GitHub check inspection and PR update are separate provider capabilities.

### 10. `identity-and-force-push-boundary`

Transcript source:
The user required local commit identity `0xpatrickbot
<patchrick@0xpatrick.dev>`, then the branch was force-pushed with lease.

Fixture:
A local branch has rewritten commits that are ahead of its upstream.

Prompt:
Verify the configured commit identity, verify the upstream, and publish the
rewritten branch safely.

Expected:
New commits have the required author identity.
The push uses force-with-lease semantics.
No unrelated branch is updated.

Primary operations observed:
`git config user.name`, `git config user.email`,
`git rev-parse --abbrev-ref --symbolic-full-name @{u}`,
`git push --force-with-lease`.

EndoGit coverage:
Commit identity is currently backend policy, not guest-configurable.
`GitRemote.push()` can enforce branch/refspec policy, but force-with-lease is
not represented directly in the local `Git` surface.

### 11. `read-only-contract-audit`

Transcript source:
The session repeatedly compared the exported `EndoGit` type, runtime guard, and
agent-tool JSON schema before adding a contract test.

Fixture:
The codebase has an `EndoGit` type, runtime `GitInterface`, and JSON tool
schemas that may drift.

Prompt:
Audit the Git capability contract and add a package-local type test that fails
when the exported type and runtime factory diverge.

Expected:
The test commit touches only the package-local type test unless a real contract
bug is found.
The relevant package lint/type tests pass.

Primary APIs:
Read-only Git/history inspection plus filesystem edits and package test-command
power.

## Explicit Gap Scenarios

The following are useful tests only if the goal is to pressure the API design.
They mirror things that happened in the session but are not current EndoGit
affordances.

- `amend-top-commit`:
  Missing affordance: no commit amend option.
  Possible direction: add a structured `commit({ amend })` shape or leave out.
- `reword-commit-during-rebase`:
  Missing affordance: no interactive rebase todo API.
  Possible direction: probably defer until a strong use case appears.
- `autosquash-fixups`:
  Missing affordance: no `rebase --autosquash` option.
  Possible direction: add `rebase({ mode: 'start', upstream, autosquash: true })`
  if needed.
- `cherry-pick-two-commits`:
  Missing affordance: no `cherryPick()` method.
  Possible direction: add a narrow method if branch-stack surgery is in scope.
- `reset-to-parent`:
  Missing affordance: no `reset` method.
  Possible direction: likely avoid broad reset; prefer restore, branch, and
  rebase verbs.

## Implementation Notes

Use code-mode scenarios for the rebase and conflict cases first.
They can call `E(git).status()` and pass `row.entry` back into `E(git).add()`,
which preserves the path-authority discipline.

Keep JSON-tool scenarios limited to the current exported slice:
`log`, `diff`, `show`, `commit`, `branches`, `createBranch`, `switchBranch`,
and `currentBranch`.
Adding `status` and `add` to JSON tools requires a capref/result story for
`EndoMountEntry`, not just another JSON schema.

Score final state, not command sequence.
The command sequence matters for API coverage analysis, but the eval harness
should permit equivalent solutions that preserve the same authority boundaries
and repository outcome.
