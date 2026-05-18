// @ts-check
/* global process */
// endo run --UNCONFINED setup-git-tool.js --powers @agent
// Optional: FAE_GIT_ROOT=/path/to/repo endo run ... to set repo root
// (default: FAE_CWD, then process.cwd()).
//
// Creates a repository-scoped git tool caplet in the host's inventory.

import { E } from '@endo/eventual-send';

/**
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
export const main = async agent => {
  const repoRoot =
    process.env.FAE_GIT_ROOT || process.env.FAE_CWD || process.cwd();
  const env = { FAE_GIT_ROOT: repoRoot };
  const gitUrl = new URL('tools/git.js', import.meta.url).href;

  await E(agent).makeUnconfined('@main', gitUrl, {
    resultName: 'git-tool',
    env,
  });
  console.log('[setup-git-tool] Created git-tool (repo root:', repoRoot, ')');
};
harden(main);
