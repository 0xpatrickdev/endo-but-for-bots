// @ts-check
/// <reference types="ses"/>

// The reference solution for the stage-and-commit scenario: the `execute`
// source a competent code-mode agent should converge on. Kept beside the
// scenario so `makeStageAndCommitScenario`'s `referenceSourcePath` /
// `referenceSourceExport` fields can point here; the no-LLM test imports this
// to drive the scripted faux model, and a live run's `results.jsonl` row
// carries the same path/export pair so a downstream reporter can link a
// scenario's transcript to its reference solution.

/**
 * Build the reference `execute` source for the stage-and-commit scenario:
 * find the target path's status row, stage it, and commit with `message`.
 *
 * @param {string} filePath
 * @param {string} message
 * @returns {string}
 */
export const stageAndCommitSource = (filePath, message) => `\
(async () => {
  const rows = await E(git).status();
  const row = rows.find(candidate => candidate.path === ${JSON.stringify(filePath)});
  if (row === undefined) {
    throw new Error('target path not found in git status');
  }
  await E(git).add([row.entry]);
  const commit = await E(git).commit(${JSON.stringify(message)});
  return commit.summary;
})()`;
harden(stageAndCommitSource);
