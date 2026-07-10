---
'@endo/git': minor
'@endo/exo-git': minor
'@endo/agent-tools': minor
'@endo/agentry': minor
---

Add commit amendment and commit-message rewording to the Git APIs.
`@endo/agent-tools` provides these history-rewrite operations through the new
explicitly elevated `makeGitHistoryTool` maker; the default `makeGitTool`
inventory continues to expose only new-commit creation.
`makeGit` now takes powers separately from `{ readOnly, allowHistoryRewrite }`
options; callers must migrate from the former single-object signature.
