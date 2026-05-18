// @ts-check
/* global process */

import { makeExo } from '@endo/exo';

import { FaeToolInterface } from '../src/fae-tool-interface.js';
import { makeGitTool } from '../src/tool-makers.js';

/**
 * FaeTool caplet: local git operations for one repository root.
 * Root is fixed at creation time via env.FAE_GIT_ROOT, then env.FAE_CWD,
 * then process.cwd().
 *
 * @param _powers
 * @param _context
 * @param root0
 * @param root0.env
 */
// eslint-disable-next-line no-underscore-dangle
export const make = (_powers, _context, { env = {} } = {}) => {
  const envRecord = /** @type {Record<string, string | undefined>} */ (env);
  const repoRoot =
    envRecord.FAE_GIT_ROOT || envRecord.FAE_CWD || process.cwd();
  const impl = makeGitTool(repoRoot);
  return makeExo('GitTool', FaeToolInterface, {
    schema: () => impl.schema(),
    execute: args => impl.execute(args),
    help: () => impl.help(),
  });
};
harden(make);
