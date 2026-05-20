// @ts-check

import { bytesToText } from '@endo/bytes/to-string.js';
import harden from '@endo/harden';

/** @import { GitPowers } from './types.js' */

const GIT_OUTPUT_LIMIT = 50_000;

/**
 * @param {string} output
 * @returns {string}
 */
const truncateOutput = output => {
  if (output.length > GIT_OUTPUT_LIMIT) {
    return `${output.slice(0, GIT_OUTPUT_LIMIT)}\n\n... (truncated, ${output.length} chars total)`;
  }
  return output;
};
harden(truncateOutput);

/**
 * @param {Error & {
 *   stdout?: string | Uint8Array,
 *   stderr?: string | Uint8Array,
 *   code?: number,
 * }} err
 * @returns {string}
 */
const gitErrorDetail = err => {
  const detail = err.stderr || err.stdout || err.message || 'unknown error';
  return typeof detail === 'string' ? detail : bytesToText(detail);
};
harden(gitErrorDetail);

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {GitPowers} args.gitPowers
 */
export const makeNativeGitBackend = ({ repoRoot, gitPowers }) => {
  /** @type {Promise<string> | undefined} */
  let verifiedRepoRoot;
  /** @type {Promise<{ gitDir: string, commonDir: string, gitDirIdentity: string, commonDirIdentity: string }> | undefined} */
  let pinnedRepoIdentity;

  const getRepoRoot = async () => {
    if (verifiedRepoRoot === undefined) {
      verifiedRepoRoot = gitPowers.getRepositoryRoot(repoRoot);
      const root = await verifiedRepoRoot;
      pinnedRepoIdentity = gitPowers.getRepositoryIdentity(root);
      await pinnedRepoIdentity;
      return root;
    }
    const root = await verifiedRepoRoot;
    if (pinnedRepoIdentity === undefined) {
      throw new Error('Git repository identity was not pinned');
    }
    const pinned = await pinnedRepoIdentity;
    const current = await gitPowers.getRepositoryIdentity(root);
    if (
      current.gitDir !== pinned.gitDir ||
      current.commonDir !== pinned.commonDir ||
      current.gitDirIdentity !== pinned.gitDirIdentity ||
      current.commonDirIdentity !== pinned.commonDirIdentity
    ) {
      throw new Error('Git repository identity changed under mounted worktree');
    }
    return root;
  };

  /**
   * @param {string[]} gitArgs
   * @param {Error & {
   *   stdout?: string | Uint8Array,
   *   stderr?: string | Uint8Array,
   *   code?: number,
   * }} err
   */
  const wrapGitError = (gitArgs, err) => {
    const detail = truncateOutput(gitErrorDetail(err).trim());
    return new Error(
      `git ${gitArgs[0]} failed (exit ${err.code ?? 'unknown'}):\n${detail}`,
    );
  };

  /**
   * @param {string[]} gitArgs
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  const runGitRaw = async gitArgs => {
    const root = await getRepoRoot();
    try {
      return await gitPowers.runGit(root, gitArgs);
    } catch (error) {
      throw wrapGitError(
        gitArgs,
        /** @type {Error & { stdout?: string, stderr?: string, code?: number }} */ (
          error
        ),
      );
    }
  };

  /**
   * @param {string[]} gitArgs
   * @returns {Promise<{ stdout: Uint8Array, stderr: string }>}
   */
  const runGitBytesRaw = async gitArgs => {
    const root = await getRepoRoot();
    try {
      return await gitPowers.runGitBytes(root, gitArgs);
    } catch (error) {
      throw wrapGitError(
        gitArgs,
        /** @type {Error & { stdout?: Uint8Array, stderr?: string, code?: number }} */ (
          error
        ),
      );
    }
  };

  /**
   * @param {string[]} gitArgs
   * @returns {Promise<import('@endo/stream').Reader<Uint8Array>>}
   */
  const runGitReaderRaw = async gitArgs => {
    const root = await getRepoRoot();
    try {
      return await gitPowers.runGitReader(root, gitArgs);
    } catch (error) {
      throw wrapGitError(
        gitArgs,
        /** @type {Error & { stdout?: Uint8Array, stderr?: string, code?: number }} */ (
          error
        ),
      );
    }
  };

  /**
   * @param {string[]} gitArgs
   * @returns {Promise<string>}
   */
  const runGit = async gitArgs => {
    const { stdout, stderr } = await runGitRaw(gitArgs);
    const output = `${stdout}${stderr ? `\n[stderr]:\n${stderr}` : ''}`;
    return truncateOutput(output.trim() || '(no output)');
  };

  const assertNoExecutableRepoConfig = async () => {
    await gitPowers.assertNoExecutableRepoConfig(await getRepoRoot());
  };

  /**
   * @param {string} branchName
   */
  const checkBranchName = async branchName => {
    await gitPowers.checkRefFormat(await getRepoRoot(), branchName);
    return branchName;
  };

  return harden({
    getRepoRoot,
    runGitRaw,
    runGitBytesRaw,
    runGitReaderRaw,
    runGit,
    assertNoExecutableRepoConfig,
    checkBranchName,
  });
};
harden(makeNativeGitBackend);
