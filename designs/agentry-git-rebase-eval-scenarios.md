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

## Git History Summary

The reflog shows the following user-visible Git operation classes.
Commands marked "inferred" name the natural shell command behind the reflog
event, not an exact captured argv.

- 10:43: `pull: Fast-forward`.
  Command class: `git pull` or `git pull --ff-only`.
- 10:44: `checkout: moving from llm to refactor/types-shim-retirement`.
  Command class: `git checkout` / `git switch`.
- 11:24: `reset: moving to HEAD`; `reset: moving to d5820f7^`.
  Command class: `git reset` cleanup before rebuilding the stack.
- 11:25: `commit`; `commit (amend)`.
  Command class: ordinary commits and amend while shaping commits.
- 11:27: two `cherry-pick` entries.
  Command class: cherry-pick existing commits into the branch.
- 11:34-11:42: `commit: fixup! ...`.
  Command class: create fixup commits for later autosquash.
- 11:54: `rebase (start)`; `rebase (fixup)`; `rebase (continue)`.
  Command class: inferred interactive/autosquash rebase with conflict
  continuation.
- 11:57: `rebase (pick)`; `rebase (reword)`; `rebase (finish)`.
  Command class: inferred interactive rebase with a reword operation.
- 12:11: `reset: moving to HEAD^`; `commit (amend)`; new commits.
  Command class: undo/rework top commit and append replacement commits.
- 12:27: `commit: fixup! ...`; `rebase (fixup)`; `rebase (finish)`.
  Command class: final fixup plus autosquash-style rebase.

Other supporting commands such as `status`, `diff`, `log`, `show`, and `add`
are not visible in reflog, but the recovered Codex transcript confirms they
were heavily used to drive the session.

## Recovered Workflow Detail

The recovered transcript shows a more realistic agent loop than reflog alone:

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

## Thin Scenarios

### 1. `branch-and-commit`

Fixture:
An initial `main` branch has `README.md`.
The working tree has a requested edit already written but unstaged.

Prompt:
Create branch `agent/readme-note`, stage `README.md`, and commit with exactly
`docs: add agent note`.

Expected:
`currentBranch()` is `agent/readme-note`.
`log({ maxCount: 1 })[0].summary` is the expected message.
`filesystemAt('HEAD')` contains the expected `README.md` bytes.
`status()` is clean.

Primary APIs:
`createBranch({ switchAfterCreate: true })`, `status()`, `add()`, `commit()`.

### 2. `restore-staged-mistake`

Fixture:
Two files are modified.
Both are staged, but only `src/kept.js` should be committed.

Prompt:
Commit only `src/kept.js` with exactly `fix: keep intended change`.
Do not include `src/noise.js`.

Expected:
The new commit contains `src/kept.js`.
`src/noise.js` remains modified in the worktree but is not staged.
The commit message matches.

Primary APIs:
`status()`, `restore([noise.entry], { staged: true })`, `add()`, `commit()`,
`diff({ cached: true })`.

### 3. `fixup-commit-for-earlier-change`

Fixture:
The branch has two commits.
The earlier commit summary is `fix(exo-git): align Git contract with guards`.
A small follow-up edit is present in the working tree.

Prompt:
Stage the follow-up and commit it as a fixup for
`fix(exo-git): align Git contract with guards`.
Do not autosquash it.

Expected:
The top commit summary is exactly
`fixup! fix(exo-git): align Git contract with guards`.
The worktree is clean.

Primary APIs:
`log()`, `status()`, `add()`, `commit()`.

Why it matters:
This covers a useful part of autosquash workflows that EndoGit can already do
without exposing interactive rebase.

### 4. `linear-rebase-clean`

Fixture:
`main` advances by one commit after `topic` branches.
`topic` has one non-conflicting commit.
The repository starts on `topic`.

Prompt:
Rebase the current branch onto `main`.

Expected:
`topic` is still the current branch.
`log({ maxCount: 2 })` shows the topic commit above the new `main` commit.
There is no merge commit.
`status()` is clean.

Primary APIs:
`currentBranch()`, `rebase({ mode: 'start', upstream: 'main' })`, `log()`,
`status()`.

### 5. `rebase-conflict-resolve-continue`

Fixture:
`main` and `topic` both edit the same line in `src/config.js`.
The repository starts on `topic`.

Prompt:
Rebase `topic` onto `main`.
If there is a conflict in `src/config.js`, keep the combined setting
`export const mode = 'agent-main';`, then continue the rebase.

Expected:
The current branch is `topic`.
`src/config.js` at `HEAD` has the combined content.
`status()` is clean.
The rebased topic commit is above `main`.

Primary APIs:
`rebase({ mode: 'start', upstream: 'main' })`, `status()`, filesystem write,
`add()`, `rebase({ mode: 'continue' })`, `filesystemAt('HEAD')`.

Harness note:
This is a code-mode scenario today.
It needs `status()` rows with `entry` handles and `rebase()`, neither of which
is exposed by the current JSON-safe git-tool slice.

### 6. `rebase-abort-on-conflict`

Fixture:
Same branch graph as `rebase-conflict-resolve-continue`.
Record the original `topic` `HEAD` oid before the run.

Prompt:
Start rebasing `topic` onto `main`.
If the rebase conflicts, abort it and leave the branch exactly as it was.

Expected:
`revParse('HEAD').oid` equals the original `topic` oid.
`status()` is clean.
No conflict markers remain in the worktree.

Primary APIs:
`revParse('HEAD')`, `rebase({ mode: 'start', upstream: 'main' })`,
`rebase({ mode: 'abort' })`, `status()`.

### 7. `stash-before-switch`

Fixture:
The repository starts on `topic`.
There is a tracked modification and an untracked note.
Branch `review` already exists.

Prompt:
Preserve the dirty work, switch to `review`, then re-apply the preserved work.

Expected:
The current branch is `review`.
The tracked modification and untracked note are present.
`stashList()` is empty after a successful pop.

Primary APIs:
`stashPush({ includeUntracked: true })`, `switchBranch('review')`,
`stashPop()`, `stashList()`, filesystem reads.

### 8. `read-historical-file`

Fixture:
`HEAD~1` has `packages/exo-git/src/types.ts` with an older exported shape.
`HEAD` has a newer exported shape.

Prompt:
Compare the current file with the previous commit and report whether the
`EndoGit` type includes `rebase`.
Do not modify the repository.

Expected:
The model uses read-only inspection only.
`status()` remains clean.
The answer or returned value identifies `rebase` in the current file.

Primary APIs:
`filesystemAt('HEAD~1')`, `worktree()`, `diff({ base: 'HEAD~1', head: 'HEAD' })`,
`readOnly()`.

### 9. `read-only-git-rejects-mutation`

Fixture:
Give the scenario a read-only `Git` cap and a writable or read-only workspace
depending on the exact authority boundary being tested.

Prompt:
Inspect the current branch and latest commit.
Do not make repository changes.

Expected:
Read methods work.
A scripted negative variant that attempts `commit()` or `rebase()` receives a
permission error from the read-only `Git`.
`status()` remains clean.

Primary APIs:
`readOnly()`, `log()`, `currentBranch()`, rejected `commit()` or `rebase()`.

### 10. `ff-only-pull-policy`

Fixture:
A local bare remote advances `main`.
The local branch is behind and has no local divergence.
Construct a `GitRemote` with fetch direction and a narrow fetch refspec.

Prompt:
Pull from the configured remote using fast-forward-only strategy.

Expected:
`GitRemote.pull({ strategy: 'ff-only' })` succeeds.
`HEAD` advances to the remote commit.
The audit log records a pull with fast-forward integration.

Primary APIs:
`GitRemote.pull()`, `log()`, remote controller audit.

Harness note:
This is outside the local `Git` code-mode global unless the harness also grants
the remote capability.

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
