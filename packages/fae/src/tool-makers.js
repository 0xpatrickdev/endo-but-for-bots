// @ts-check

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import process from 'node:process';
import { promisify as nodePromisify } from 'util';

import { E } from '@endo/eventual-send';

/**
 * @typedef {object} ToolFunction
 * @property {string} name
 * @property {string} description
 * @property {object} parameters
 */

/**
 * @typedef {object} ToolSchema
 * @property {'function'} type
 * @property {ToolFunction} function
 */

/**
 * @typedef {object} FaeTool
 * @property {() => ToolSchema} schema
 * @property {(args: Record<string, unknown>) => Promise<string>} execute
 * @property {() => string} help
 */

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
const isOutsideRoot = (root, target) => {
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative);
};

/**
 * Resolve a relative path against the working directory and ensure it
 * does not escape above cwd.
 *
 * @param {string} relativePath
 * @param {string} cwd
 * @returns {string}
 */
const resolveSafe = (relativePath, cwd) => {
  const resolved = path.resolve(cwd, relativePath);
  if (isOutsideRoot(cwd, resolved)) {
    throw new Error(`Path traversal not allowed: ${relativePath}`);
  }
  return resolved;
};

const execFileAsync = nodePromisify(execFile);

const gitNullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

const GIT_BASE_ARGS = harden([
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
]);

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const TOOL_OUTPUT_LIMIT = 50_000;

/**
 * @param {string} repoRoot
 */
const makeGitEnv = repoRoot => ({
  PATH: process.env.PATH || '',
  HOME: path.join(repoRoot, '.git-fae-home'),
  XDG_CONFIG_HOME: path.join(repoRoot, '.git-fae-home'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: gitNullDevice,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LANG: 'C',
  LC_ALL: 'C',
});

/**
 * @param {string} output
 * @returns {string}
 */
const truncateOutput = output => {
  if (output.length > TOOL_OUTPUT_LIMIT) {
    return `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n\n... (truncated, ${output.length} chars total)`;
  }
  return output;
};

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
const requireNonEmptyString = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  if (value.includes('\0')) {
    throw new Error(`${name} must not contain NUL bytes`);
  }
  return value;
};

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
const requireRevision = (value, name) => {
  const revision = requireNonEmptyString(value, name);
  if (revision.startsWith('-')) {
    throw new Error(`${name} must not start with "-"`);
  }
  return revision;
};

/**
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @returns {FaeTool}
 */
export const makeEvaluateTool = host => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'evaluate',
      description:
        'Evaluate JavaScript source code in an isolated Endo daemon worker. ' +
        'The code runs in a SES Compartment with E(), M, and makeExo as globals. ' +
        'Use endowments to pass named capabilities from the petname store into scope. ' +
        'Use resultName to store the result under a petname for later lookup.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'JavaScript source code to evaluate.',
          },
          endowments: {
            type: 'object',
            description:
              'Map of variable names to petnames. Each key becomes a variable ' +
              'in the evaluated code, bound to the capability stored under the petname value. ' +
              'Example: { "counter": "my-counter" } makes the capability named "my-counter" ' +
              'available as the variable `counter` in the source code.',
            additionalProperties: { type: 'string' },
          },
          resultName: {
            type: 'string',
            description:
              'Petname to store the evaluation result under. ' +
              'If provided, the result can be retrieved later via lookup.',
          },
          workerName: {
            type: 'string',
            description:
              'Name of the worker to evaluate in. Defaults to "@main". ' +
              'Use provideWorker first if you need a separate worker.',
          },
        },
        required: ['source'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const {
        source,
        endowments = {},
        resultName,
        workerName = '@main',
      } = /** @type {{ source: string, endowments?: Record<string, string>, resultName?: string, workerName?: string }} */ (
        args
      );
      if (!source) {
        throw new Error('source is required');
      }
      const codeNames = Object.keys(
        /** @type {Record<string, string>} */ (endowments),
      );
      const petNames = Object.values(
        /** @type {Record<string, string>} */ (endowments),
      );
      const resultPath = resultName ? [resultName] : undefined;
      const result = await E(host).evaluate(
        workerName,
        source,
        codeNames,
        petNames,
        resultPath,
      );
      if (result === undefined) {
        return 'undefined';
      }
      try {
        return JSON.stringify(result, null, 2);
      } catch {
        return String(result);
      }
    },
    help() {
      return 'Evaluate JavaScript source code in an isolated Endo daemon worker.';
    },
  });
};
harden(makeEvaluateTool);

/**
 * @param {string} cwd
 * @returns {FaeTool}
 */
export const makeReadFileTool = cwd => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'readFile',
      description:
        'Read the contents of a file. Path is relative to the working directory.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Relative path to the file to read.',
          },
        },
        required: ['filePath'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { filePath } = /** @type {{ filePath: string }} */ (args);
      if (!filePath) {
        throw new Error('filePath is required');
      }
      const resolved = resolveSafe(filePath, cwd);
      const content = await fs.promises.readFile(resolved, 'utf-8');
      if (content.length > 50_000) {
        return `${content.slice(0, 50_000)}\n\n... (truncated, ${content.length} chars total)`;
      }
      return content;
    },
    help() {
      return 'Read the contents of a file relative to the working directory.';
    },
  });
};
harden(makeReadFileTool);

/**
 * @param {string} cwd
 * @returns {FaeTool}
 */
export const makeWriteFileTool = cwd => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'writeFile',
      description:
        'Write contents to a file, creating it if it does not exist. ' +
        'Path is relative to the working directory.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Relative path to the file to write.',
          },
          contents: {
            type: 'string',
            description: 'The full contents to write to the file.',
          },
        },
        required: ['filePath', 'contents'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { filePath, contents } =
        /** @type {{ filePath: string, contents: string }} */ (args);
      if (!filePath || contents === undefined) {
        throw new Error('filePath and contents are required');
      }
      const resolved = resolveSafe(filePath, cwd);
      const dir = path.dirname(resolved);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(resolved, contents, 'utf-8');
      return `Wrote ${contents.length} chars to ${filePath}`;
    },
    help() {
      return 'Write contents to a file, creating it if it does not exist.';
    },
  });
};
harden(makeWriteFileTool);

/**
 * @param {string} cwd
 * @returns {FaeTool}
 */
export const makeEditFileTool = cwd => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'editFile',
      description:
        'Edit a file by replacing the first occurrence of a string with another. ' +
        'Path is relative to the working directory.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Relative path to the file to edit.',
          },
          oldString: {
            type: 'string',
            description: 'The exact string to search for and replace.',
          },
          newString: {
            type: 'string',
            description: 'The replacement string.',
          },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { filePath, oldString, newString } =
        /** @type {{ filePath: string, oldString: string, newString: string }} */ (
          args
        );
      if (!filePath || oldString === undefined || newString === undefined) {
        throw new Error('filePath, oldString, and newString are required');
      }
      const resolved = resolveSafe(filePath, cwd);
      const content = await fs.promises.readFile(resolved, 'utf-8');
      if (!content.includes(oldString)) {
        throw new Error(
          `oldString not found in ${filePath}. Ensure the string matches exactly.`,
        );
      }
      const updated = content.replace(oldString, newString);
      await fs.promises.writeFile(resolved, updated, 'utf-8');
      return `Edited ${filePath}`;
    },
    help() {
      return 'Edit a file by replacing the first occurrence of a string with another.';
    },
  });
};
harden(makeEditFileTool);

/**
 * @param {string} cwd
 * @returns {FaeTool}
 */
export const makeListDirTool = cwd => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'listDir',
      description:
        'List the contents of a directory. Path is relative to the working directory. ' +
        'Omit path to list the working directory itself.',
      parameters: {
        type: 'object',
        properties: {
          dirPath: {
            type: 'string',
            description:
              'Relative path to the directory. Defaults to "." (working directory).',
          },
        },
        required: [],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { dirPath = '.' } = /** @type {{ dirPath?: string }} */ (args);
      const resolved = resolveSafe(dirPath, cwd);
      const entries = await fs.promises.readdir(resolved, {
        withFileTypes: true,
      });
      const lines = entries.map(e => {
        const suffix = e.isDirectory() ? '/' : '';
        return `${e.name}${suffix}`;
      });
      return lines.join('\n');
    },
    help() {
      return 'List the contents of a directory relative to the working directory.';
    },
  });
};
harden(makeListDirTool);

/**
 * @param {string} cwd
 * @returns {FaeTool}
 */
export const makeRunCommandTool = cwd => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'runCommand',
      description:
        'Execute a shell command in the working directory. ' +
        'Returns stdout on success. Use for running npm scripts, git commands, ' +
        'linters, tests, and other CLI tools. Commands are run with a timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The shell command to execute (e.g., "npm test", "git status").',
          },
          timeout: {
            type: 'number',
            description:
              'Maximum execution time in milliseconds. Defaults to 30000 (30 seconds).',
          },
        },
        required: ['command'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { command, timeout = 30_000 } =
        /** @type {{ command: string, timeout?: number }} */ (args);
      if (!command) {
        throw new Error('command is required');
      }
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
        });
        const output = stdout + (stderr ? `\n[stderr]:\n${stderr}` : '');
        if (output.length > 50_000) {
          return `${output.slice(0, 50_000)}\n\n... (truncated, ${output.length} chars total)`;
        }
        return output || '(no output)';
      } catch (err) {
        const error =
          /** @type {Error & { stdout?: string, stderr?: string, code?: number }} */ (
            err
          );
        throw new Error(
          `Command failed (exit ${error.code ?? 'unknown'}):\n${error.stderr || error.message}`,
        );
      }
    },
    help() {
      return 'Execute a shell command in the working directory.';
    },
  });
};
harden(makeRunCommandTool);

/**
 * Repository-scoped git operations for local work only. This intentionally
 * omits raw command execution, networking, git config, and hook management.
 *
 * @param {string} configuredRoot
 * @returns {FaeTool}
 */
export const makeGitTool = configuredRoot => {
  /** @type {Promise<string> | undefined} */
  let repoRootPromise;

  const getRepoRoot = () => {
    if (!repoRootPromise) {
      repoRootPromise = (async () => {
        const resolvedRoot = await fs.promises.realpath(configuredRoot);
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', '--show-toplevel'],
          {
            cwd: resolvedRoot,
            env: makeGitEnv(resolvedRoot),
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
          },
        );
        const actualRoot = await fs.promises.realpath(stdout.trim());
        if (actualRoot !== resolvedRoot) {
          throw new Error(
            `Git root must be the configured root: expected ${resolvedRoot}, got ${actualRoot}`,
          );
        }
        return actualRoot;
      })();
    }
    return repoRootPromise;
  };

  /**
   * @param {string[]} args
   * @returns {Promise<string>}
   */
  const runGit = async args => {
    const repoRoot = await getRepoRoot();
    try {
      const { stdout, stderr } = await execFileAsync(
        'git',
        [...GIT_BASE_ARGS, ...args],
        {
          cwd: repoRoot,
          env: makeGitEnv(repoRoot),
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
        },
      );
      const output = `${stdout}${stderr ? `\n[stderr]:\n${stderr}` : ''}`;
      return truncateOutput(output.trim() || '(no output)');
    } catch (err) {
      const error =
        /** @type {Error & { stdout?: string, stderr?: string, code?: number }} */ (
          err
        );
      const detail =
        error.stderr || error.stdout || error.message || 'unknown git error';
      throw new Error(
        `git ${args[0]} failed (exit ${error.code ?? 'unknown'}):\n${truncateOutput(detail.trim())}`,
      );
    }
  };

  /**
   * @param {unknown} branchName
   * @param {string} fieldName
   * @returns {Promise<string>}
   */
  const requireBranchName = async (branchName, fieldName) => {
    const name = requireRevision(branchName, fieldName);
    await runGit(['check-ref-format', '--branch', name]);
    return name;
  };

  /**
   * @param {unknown} candidate
   * @param {string} fieldName
   * @returns {Promise<string>}
   */
  const normalizeRepoPath = async (candidate, fieldName) => {
    const relativePath = requireNonEmptyString(candidate, fieldName);
    if (path.isAbsolute(relativePath)) {
      throw new Error(`${fieldName} must contain repository-relative paths`);
    }
    const repoRoot = await getRepoRoot();
    const resolved = path.resolve(repoRoot, relativePath);
    if (isOutsideRoot(repoRoot, resolved)) {
      throw new Error(`Path traversal not allowed: ${relativePath}`);
    }
    const normalized = path.relative(repoRoot, resolved);
    return normalized || '.';
  };

  /**
   * @param {unknown} candidates
   * @param {string} fieldName
   * @returns {Promise<string[]>}
   */
  const normalizeRepoPaths = async (candidates, fieldName) => {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`${fieldName} must be a non-empty array`);
    }
    return Promise.all(
      candidates.map(candidate => normalizeRepoPath(candidate, fieldName)),
    );
  };

  const EXECUTABLE_REPO_CONFIG =
    /^(filter\..*\.(clean|smudge|process)|merge\..*\.driver)$/u;

  const assertNoExecutableRepoConfig = async () => {
    const repoRoot = await getRepoRoot();
    const { stdout } = await execFileAsync(
      'git',
      [...GIT_BASE_ARGS, 'config', '--local', '--name-only', '--list'],
      {
        cwd: repoRoot,
        env: makeGitEnv(repoRoot),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    const executableConfig = stdout
      .split('\n')
      .filter(name => EXECUTABLE_REPO_CONFIG.test(name));
    if (executableConfig.length > 0) {
      throw new Error(
        `Refusing git operation because repository config can execute commands: ${executableConfig.join(', ')}`,
      );
    }
  };

  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'git',
      description:
        'Run repository-scoped local git operations without exposing raw git, network access, or git configuration. ' +
        'Supports status, diff, log, show, revParse, add, restore, commit, branch management, switch, merge, rebase, and stash workflows.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            description:
              'One of: status, diff, log, show, revParse, add, restore, commit, currentBranch, branchList, branchCreate, branchDelete, branchRename, switch, merge, rebase, stashPush, stashList, stashShow, stashApply, stashPop, stashDrop.',
          },
          paths: {
            type: 'array',
            description:
              'Repository-relative file paths for add, restore, diff, or stashPush.',
            items: { type: 'string' },
          },
          staged: {
            type: 'boolean',
            description: 'Use the index for diff or restore.',
          },
          all: {
            type: 'boolean',
            description: 'Include remote branches for branchList.',
          },
          from: {
            type: 'string',
            description: 'Base revision for diff.',
          },
          to: {
            type: 'string',
            description: 'Target revision for diff.',
          },
          ref: {
            type: 'string',
            description: 'Revision or stash reference for read operations.',
          },
          maxCount: {
            type: 'number',
            description: 'Maximum commits to return for log.',
          },
          message: {
            type: 'string',
            description: 'Commit or stash message.',
          },
          branch: {
            type: 'string',
            description: 'Branch name for branch operations or rebase.',
          },
          newName: {
            type: 'string',
            description: 'Replacement branch name for branchRename.',
          },
          startPoint: {
            type: 'string',
            description:
              'Starting revision for branchCreate or switch(create).',
          },
          switchAfterCreate: {
            type: 'boolean',
            description: 'Switch to a branch immediately after branchCreate.',
          },
          target: {
            type: 'string',
            description: 'Target branch or revision for switch.',
          },
          create: {
            type: 'boolean',
            description: 'Create the branch while switching.',
          },
          detach: {
            type: 'boolean',
            description: 'Detach HEAD while switching to a revision.',
          },
          force: {
            type: 'boolean',
            description: 'Force branch deletion.',
          },
          noFastForward: {
            type: 'boolean',
            description: 'Create a merge commit instead of fast-forwarding.',
          },
          mode: {
            type: 'string',
            description: 'Rebase mode: start, continue, abort, or skip.',
          },
          upstream: {
            type: 'string',
            description: 'Upstream revision for rebase(start).',
          },
          includeUntracked: {
            type: 'boolean',
            description: 'Include untracked files for stashPush.',
          },
          stash: {
            type: 'string',
            description: 'Stash reference such as stash@{0}.',
          },
        },
        required: ['operation'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { operation } = /** @type {{ operation?: unknown }} */ (args);
      switch (operation) {
        case 'status':
          return runGit(['status', '--short', '--branch']);
        case 'diff': {
          const {
            staged = false,
            from,
            to,
            paths,
          } = /** @type {{ staged?: boolean, from?: unknown, to?: unknown, paths?: unknown }} */ (
            args
          );
          const command = ['diff', '--no-ext-diff', '--no-textconv'];
          if (staged) {
            command.push('--cached');
          }
          if (from !== undefined) {
            command.push(requireRevision(from, 'from'));
          }
          if (to !== undefined) {
            command.push(requireRevision(to, 'to'));
          }
          if (paths !== undefined) {
            command.push('--', ...(await normalizeRepoPaths(paths, 'paths')));
          }
          return runGit(command);
        }
        case 'log': {
          const { maxCount = 20, ref } =
            /** @type {{ maxCount?: number, ref?: unknown }} */ (args);
          if (!Number.isSafeInteger(maxCount) || maxCount <= 0) {
            throw new Error('maxCount must be a positive safe integer');
          }
          const command = [
            'log',
            '--oneline',
            '--decorate',
            `--max-count=${maxCount}`,
          ];
          if (ref !== undefined) {
            command.push(requireRevision(ref, 'ref'));
          }
          return runGit(command);
        }
        case 'show': {
          const { ref = 'HEAD' } = /** @type {{ ref?: unknown }} */ (args);
          return runGit([
            'show',
            '--no-ext-diff',
            '--no-textconv',
            '--stat',
            '--oneline',
            '--decorate',
            requireRevision(ref, 'ref'),
          ]);
        }
        case 'revParse': {
          const { ref } = /** @type {{ ref?: unknown }} */ (args);
          return runGit(['rev-parse', '--verify', requireRevision(ref, 'ref')]);
        }
        case 'add': {
          const { paths } = /** @type {{ paths?: unknown }} */ (args);
          await assertNoExecutableRepoConfig();
          return runGit([
            'add',
            '--',
            ...(await normalizeRepoPaths(paths, 'paths')),
          ]);
        }
        case 'restore': {
          const {
            paths,
            staged = false,
            ref,
          } = /** @type {{ paths?: unknown, staged?: boolean, ref?: unknown }} */ (
            args
          );
          await assertNoExecutableRepoConfig();
          const command = ['restore'];
          if (staged) {
            command.push('--staged');
          }
          if (ref !== undefined) {
            command.push(`--source=${requireRevision(ref, 'ref')}`);
          }
          command.push('--', ...(await normalizeRepoPaths(paths, 'paths')));
          return runGit(command);
        }
        case 'commit': {
          const { message } = /** @type {{ message?: unknown }} */ (args);
          return runGit([
            'commit',
            '--no-verify',
            '--no-gpg-sign',
            '-m',
            requireNonEmptyString(message, 'message'),
          ]);
        }
        case 'currentBranch':
          return runGit(['branch', '--show-current']);
        case 'branchList': {
          const { all = false } = /** @type {{ all?: boolean }} */ (args);
          return runGit(['branch', '--list', ...(all ? ['--all'] : [])]);
        }
        case 'branchCreate': {
          const {
            branch,
            startPoint,
            switchAfterCreate = false,
          } = /** @type {{ branch?: unknown, startPoint?: unknown, switchAfterCreate?: boolean }} */ (
            args
          );
          const name = await requireBranchName(branch, 'branch');
          if (switchAfterCreate) {
            await assertNoExecutableRepoConfig();
          }
          const command = switchAfterCreate
            ? ['switch', '-c', name]
            : ['branch', name];
          if (startPoint !== undefined) {
            command.push(requireRevision(startPoint, 'startPoint'));
          }
          return runGit(command);
        }
        case 'branchDelete': {
          const { branch, force = false } =
            /** @type {{ branch?: unknown, force?: boolean }} */ (args);
          return runGit([
            'branch',
            force ? '-D' : '-d',
            await requireBranchName(branch, 'branch'),
          ]);
        }
        case 'branchRename': {
          const { branch, newName } =
            /** @type {{ branch?: unknown, newName?: unknown }} */ (args);
          return runGit([
            'branch',
            '-m',
            await requireBranchName(branch, 'branch'),
            await requireBranchName(newName, 'newName'),
          ]);
        }
        case 'switch': {
          const {
            target,
            create = false,
            detach = false,
            startPoint,
          } = /** @type {{ target?: unknown, create?: boolean, detach?: boolean, startPoint?: unknown }} */ (
            args
          );
          if (create && detach) {
            throw new Error('switch cannot combine create and detach');
          }
          await assertNoExecutableRepoConfig();
          const command = ['switch'];
          if (create) {
            command.push('-c', await requireBranchName(target, 'target'));
          } else if (detach) {
            command.push('--detach', requireRevision(target, 'target'));
          } else {
            command.push(requireRevision(target, 'target'));
          }
          if (startPoint !== undefined) {
            if (!create) {
              throw new Error('startPoint is only valid when create is true');
            }
            command.push(requireRevision(startPoint, 'startPoint'));
          }
          return runGit(command);
        }
        case 'merge': {
          const { ref, noFastForward = false } =
            /** @type {{ ref?: unknown, noFastForward?: boolean }} */ (args);
          await assertNoExecutableRepoConfig();
          return runGit([
            'merge',
            '--no-edit',
            '--no-verify',
            ...(noFastForward ? ['--no-ff'] : []),
            requireRevision(ref, 'ref'),
          ]);
        }
        case 'rebase': {
          const { mode, upstream, branch } =
            /** @type {{ mode?: unknown, upstream?: unknown, branch?: unknown }} */ (
              args
            );
          switch (mode) {
            case 'start': {
              await assertNoExecutableRepoConfig();
              const command = [
                'rebase',
                '--no-verify',
                requireRevision(upstream, 'upstream'),
              ];
              if (branch !== undefined) {
                command.push(requireRevision(branch, 'branch'));
              }
              return runGit(command);
            }
            case 'continue':
              await assertNoExecutableRepoConfig();
              return runGit(['rebase', '--continue']);
            case 'abort':
              await assertNoExecutableRepoConfig();
              return runGit(['rebase', '--abort']);
            case 'skip':
              await assertNoExecutableRepoConfig();
              return runGit(['rebase', '--skip']);
            default:
              throw new Error(
                'mode must be one of: start, continue, abort, skip',
              );
          }
        }
        case 'stashPush': {
          const {
            message,
            includeUntracked = false,
            paths,
          } = /** @type {{ message?: unknown, includeUntracked?: boolean, paths?: unknown }} */ (
            args
          );
          const command = ['stash', 'push'];
          await assertNoExecutableRepoConfig();
          if (includeUntracked) {
            command.push('--include-untracked');
          }
          if (message !== undefined) {
            command.push('-m', requireNonEmptyString(message, 'message'));
          }
          if (paths !== undefined) {
            command.push('--', ...(await normalizeRepoPaths(paths, 'paths')));
          }
          return runGit(command);
        }
        case 'stashList':
          return runGit(['stash', 'list']);
        case 'stashShow': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          const command = [
            'stash',
            'show',
            '--patch',
            '--no-ext-diff',
            '--no-textconv',
          ];
          if (stash !== undefined) {
            command.push(requireRevision(stash, 'stash'));
          }
          return runGit(command);
        }
        case 'stashApply': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          await assertNoExecutableRepoConfig();
          const command = ['stash', 'apply'];
          if (stash !== undefined) {
            command.push(requireRevision(stash, 'stash'));
          }
          return runGit(command);
        }
        case 'stashPop': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          await assertNoExecutableRepoConfig();
          const command = ['stash', 'pop'];
          if (stash !== undefined) {
            command.push(requireRevision(stash, 'stash'));
          }
          return runGit(command);
        }
        case 'stashDrop': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          const command = ['stash', 'drop'];
          if (stash !== undefined) {
            command.push(requireRevision(stash, 'stash'));
          }
          return runGit(command);
        }
        default:
          throw new Error(
            'Unsupported git operation. Allowed: status, diff, log, show, revParse, add, restore, commit, currentBranch, branchList, branchCreate, branchDelete, branchRename, switch, merge, rebase, stashPush, stashList, stashShow, stashApply, stashPop, stashDrop.',
          );
      }
    },
    help() {
      return (
        'Use local repository-scoped git operations only. ' +
        'Read: status, diff, log, show, revParse, currentBranch, branchList, stashList, stashShow. ' +
        'Write: add, restore, commit, branchCreate, branchDelete, branchRename, switch, merge, rebase, stashPush, stashApply, stashPop, stashDrop. ' +
        'The tool does not expose raw git commands, push, pull, fetch, config, hooks, remotes, or any network operation. ' +
        'Operations that could trigger repository-configured clean/smudge/process filters or merge drivers are refused when those executable settings are present.'
      );
    },
  });
};
harden(makeGitTool);

/**
 * LLM-facing git adapter backed by daemon Git capabilities. It keeps
 * the existing Fae git tool's string-path schema at the tool boundary,
 * but immediately converts path strings into EndoMountEntry values and
 * delegates to the daemon `Git` cap.
 *
 * @param {import('@endo/eventual-send').ERef<object>} git
 * @returns {FaeTool}
 */
export const makeDaemonGitTool = git => {
  /** @type {ToolSchema} */
  const toolSchema = makeGitTool('/').schema();

  /** @type {Promise<import('@endo/eventual-send').ERef<object>> | undefined} */
  let worktreePromise;
  const getWorktree = () => {
    if (worktreePromise === undefined) {
      worktreePromise = E(git).worktree();
    }
    return worktreePromise;
  };

  /**
   * @param {unknown} candidate
   * @param {string} fieldName
   * @returns {string[]}
   */
  const repoPathSegments = (candidate, fieldName) => {
    const relativePath = requireNonEmptyString(candidate, fieldName);
    if (relativePath.startsWith('/') || relativePath.includes('\0')) {
      throw new Error(`${fieldName} must contain repository-relative paths`);
    }
    if (relativePath === '.') {
      return harden([]);
    }
    const segments = relativePath.split('/');
    for (const segment of segments) {
      if (
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\')
      ) {
        throw new Error(`Invalid repository path: ${relativePath}`);
      }
    }
    return harden(segments);
  };

  /**
   * @param {unknown} candidates
   * @param {string} fieldName
   */
  const entriesFromPaths = async (candidates, fieldName) => {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`${fieldName} must be a non-empty array`);
    }
    const worktree = await getWorktree();
    return harden(
      await Promise.all(
        candidates.map(candidate =>
          E(worktree).entry(repoPathSegments(candidate, fieldName)),
        ),
      ),
    );
  };

  /**
   * @param {unknown} value
   */
  const formatResult = value =>
    value === undefined
      ? 'undefined'
      : typeof value === 'string'
        ? value
        : JSON.stringify(value, undefined, 2);

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { operation } = /** @type {{ operation?: unknown }} */ (args);
      switch (operation) {
        case 'status':
          return E(git).statusText();
        case 'diff': {
          const {
            staged = false,
            from,
            to,
            paths,
          } = /** @type {{ staged?: boolean, from?: unknown, to?: unknown, paths?: unknown }} */ (
            args
          );
          const options = {
            staged,
            ...(from !== undefined && { base: requireRevision(from, 'from') }),
            ...(to !== undefined && { head: requireRevision(to, 'to') }),
            ...(paths !== undefined && {
              entries: await entriesFromPaths(paths, 'paths'),
            }),
          };
          return E(git).diff(harden(options));
        }
        case 'log': {
          const { maxCount = 20, ref } =
            /** @type {{ maxCount?: number, ref?: unknown }} */ (args);
          if (!Number.isSafeInteger(maxCount) || maxCount <= 0) {
            throw new Error('maxCount must be a positive safe integer');
          }
          return E(git).log(
            harden({
              maxCount,
              ...(ref !== undefined && { ref: requireRevision(ref, 'ref') }),
            }),
          );
        }
        case 'show': {
          const { ref = 'HEAD' } = /** @type {{ ref?: unknown }} */ (args);
          return E(git).show(requireRevision(ref, 'ref'));
        }
        case 'revParse': {
          const { ref } = /** @type {{ ref?: unknown }} */ (args);
          return formatResult(
            await E(git).revParse(requireRevision(ref, 'ref')),
          );
        }
        case 'add': {
          const { paths } = /** @type {{ paths?: unknown }} */ (args);
          return E(git).add(await entriesFromPaths(paths, 'paths'));
        }
        case 'restore': {
          const { paths, staged = false } =
            /** @type {{ paths?: unknown, staged?: boolean }} */ (args);
          return E(git).restore(
            await entriesFromPaths(paths, 'paths'),
            harden({ staged }),
          );
        }
        case 'commit': {
          const { message } = /** @type {{ message?: unknown }} */ (args);
          return formatResult(
            await E(git).commit(requireNonEmptyString(message, 'message')),
          );
        }
        case 'currentBranch':
          return formatResult(await E(git).currentBranch());
        case 'branchList': {
          const { all = false } = /** @type {{ all?: boolean }} */ (args);
          return formatResult(await E(git).branches(harden({ all })));
        }
        case 'branchCreate': {
          const {
            branch,
            startPoint,
            switchAfterCreate = false,
          } = /** @type {{ branch?: unknown, startPoint?: unknown, switchAfterCreate?: boolean }} */ (
            args
          );
          return formatResult(
            await E(git).createBranch(
              requireNonEmptyString(branch, 'branch'),
              harden({
                switchAfterCreate,
                ...(startPoint !== undefined && {
                  startPoint: requireRevision(startPoint, 'startPoint'),
                }),
              }),
            ),
          );
        }
        case 'branchDelete': {
          const { branch, force = false } =
            /** @type {{ branch?: unknown, force?: boolean }} */ (args);
          return E(git).deleteBranch(
            requireNonEmptyString(branch, 'branch'),
            harden({ force }),
          );
        }
        case 'branchRename': {
          const { branch, newName } =
            /** @type {{ branch?: unknown, newName?: unknown }} */ (args);
          return E(git).renameBranch(
            requireNonEmptyString(branch, 'branch'),
            requireNonEmptyString(newName, 'newName'),
          );
        }
        case 'switch': {
          const {
            target,
            create = false,
            detach = false,
            startPoint,
          } = /** @type {{ target?: unknown, create?: boolean, detach?: boolean, startPoint?: unknown }} */ (
            args
          );
          return E(git).switch(
            requireRevision(target, 'target'),
            harden({
              create,
              detach,
              ...(startPoint !== undefined && {
                startPoint: requireRevision(startPoint, 'startPoint'),
              }),
            }),
          );
        }
        case 'merge': {
          const { ref, noFastForward = false } =
            /** @type {{ ref?: unknown, noFastForward?: boolean }} */ (args);
          return E(git).merge(
            requireRevision(ref, 'ref'),
            harden({ noFastForward }),
          );
        }
        case 'rebase': {
          const { mode, upstream, branch } =
            /** @type {{ mode?: unknown, upstream?: unknown, branch?: unknown }} */ (
              args
            );
          return E(git).rebase(
            harden({
              mode,
              ...(upstream !== undefined && {
                upstream: requireRevision(upstream, 'upstream'),
              }),
              ...(branch !== undefined && {
                branch: requireRevision(branch, 'branch'),
              }),
            }),
          );
        }
        case 'stashPush': {
          const {
            message,
            includeUntracked = false,
            paths,
          } = /** @type {{ message?: unknown, includeUntracked?: boolean, paths?: unknown }} */ (
            args
          );
          return E(git).stashPush(
            harden({
              includeUntracked,
              ...(message !== undefined && {
                message: requireNonEmptyString(message, 'message'),
              }),
              ...(paths !== undefined && {
                entries: await entriesFromPaths(paths, 'paths'),
              }),
            }),
          );
        }
        case 'stashList':
          return E(git).stashList();
        case 'stashShow': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          return E(git).stashShow(
            stash === undefined ? undefined : requireRevision(stash, 'stash'),
          );
        }
        case 'stashApply': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          return E(git).stashApply(
            stash === undefined ? undefined : requireRevision(stash, 'stash'),
          );
        }
        case 'stashPop': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          return E(git).stashPop(
            stash === undefined ? undefined : requireRevision(stash, 'stash'),
          );
        }
        case 'stashDrop': {
          const { stash } = /** @type {{ stash?: unknown }} */ (args);
          return E(git).stashDrop(
            stash === undefined ? undefined : requireRevision(stash, 'stash'),
          );
        }
        default:
          throw new Error(
            'Unsupported git operation. Allowed: status, diff, log, show, revParse, add, restore, commit, currentBranch, branchList, branchCreate, branchDelete, branchRename, switch, merge, rebase, stashPush, stashList, stashShow, stashApply, stashPop, stashDrop.',
          );
      }
    },
    help() {
      return (
        'Use daemon Git capabilities through LLM-friendly path strings. ' +
        'Path inputs are converted to EndoMountEntry values before reaching Git. ' +
        'The tool does not expose raw git commands, host paths, or direct remote configuration.'
      );
    },
  });
};
harden(makeDaemonGitTool);

/**
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @returns {FaeTool}
 */
export const makeListPetnamesTool = host => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'list',
      description:
        'List petnames in the Endo directory. Returns an array of stored capability names.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    // eslint-disable-next-line no-underscore-dangle
    async execute(_args) {
      const names = await E(host).list();
      return JSON.stringify(names, null, 2);
    },
    help() {
      return 'List all petnames in the Endo directory.';
    },
  });
};
harden(makeListPetnamesTool);

/**
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @returns {FaeTool}
 */
export const makeLookupTool = host => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'lookup',
      description:
        'Look up a stored value by petname. Returns the value stored under that name.',
      parameters: {
        type: 'object',
        properties: {
          petName: {
            type: 'string',
            description: 'The petname to look up.',
          },
        },
        required: ['petName'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { petName } = /** @type {{ petName: string }} */ (args);
      if (!petName) {
        throw new Error('petName is required');
      }
      const value = await E(host).lookup([petName]);
      if (value === undefined) {
        return 'undefined';
      }
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    },
    help() {
      return 'Look up a stored value by petname.';
    },
  });
};
harden(makeLookupTool);

/**
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @returns {FaeTool}
 */
export const makeStoreTool = host => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'store',
      description:
        'Store a JSON-serializable value under a petname. ' +
        'The value is persisted in the Endo daemon and can be retrieved with lookup.',
      parameters: {
        type: 'object',
        properties: {
          value: {
            description: 'The value to store (must be JSON-serializable).',
          },
          petName: {
            type: 'string',
            description: 'The petname to store the value under.',
          },
        },
        required: ['value', 'petName'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { value, petName } =
        /** @type {{ value: unknown, petName: string }} */ (args);
      if (petName === undefined) {
        throw new Error('petName is required');
      }
      await E(host).storeValue(value, petName);
      return `Stored value under "${petName}"`;
    },
    help() {
      return 'Store a JSON-serializable value under a petname.';
    },
  });
};
harden(makeStoreTool);

/**
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @returns {FaeTool}
 */
export const makeRemoveTool = host => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'remove',
      description: 'Remove a petname from the Endo directory.',
      parameters: {
        type: 'object',
        properties: {
          petName: {
            type: 'string',
            description: 'The petname to remove.',
          },
        },
        required: ['petName'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { petName } = /** @type {{ petName: string }} */ (args);
      if (!petName) {
        throw new Error('petName is required');
      }
      await E(host).remove(petName);
      return `Removed "${petName}"`;
    },
    help() {
      return 'Remove a petname from the Endo directory.';
    },
  });
};
harden(makeRemoveTool);

/**
 * Meta-tool for adopting a capability from a mail message as a tool.
 * Adopted capabilities are placed in the tools/ directory and become
 * immediately available.
 *
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @returns {FaeTool}
 */
/**
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @returns {FaeTool}
 */
export const makeSendTool = powers => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'send',
      description:
        'Send a message to another agent or the HOST. ' +
        'Strings are text content, edgeNames attach capabilities from your directory, ' +
        'petNames are the local names for those capabilities.',
      parameters: {
        type: 'object',
        properties: {
          recipient: {
            type: 'string',
            description:
              'Who to send to (e.g., "@host", or a petname for an agent).',
          },
          strings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Text parts of the message.',
          },
          edgeNames: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Labels for attached capabilities (as seen by the recipient).',
          },
          petNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Your local petnames for the capabilities to attach.',
          },
        },
        required: ['recipient', 'strings'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const {
        recipient,
        strings = [],
        edgeNames = [],
        petNames = [],
      } = /** @type {{ recipient: string, strings?: string[], edgeNames?: string[], petNames?: string[] }} */ (
        args
      );
      if (!recipient) {
        throw new Error('recipient is required');
      }
      await E(powers).send(recipient, strings, edgeNames, petNames);
      return `Sent message to "${recipient}"`;
    },
    help() {
      return 'Send a message to another agent or the HOST.';
    },
  });
};
harden(makeSendTool);

/**
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @returns {FaeTool}
 */
export const makeReplyTool = powers => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'reply',
      description:
        'Reply to a specific message by number. The reply is automatically ' +
        'routed to the original sender — no need to know their pet name. ' +
        'Use this instead of send when responding to an incoming message.',
      parameters: {
        type: 'object',
        properties: {
          messageNumber: {
            type: 'integer',
            description: 'The message number to reply to.',
          },
          strings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Text parts of the reply.',
          },
          edgeNames: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Labels for attached capabilities (as seen by the recipient).',
          },
          petNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Your local petnames for the capabilities to attach.',
          },
        },
        required: ['messageNumber', 'strings'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const {
        messageNumber,
        strings = [],
        edgeNames = [],
        petNames = [],
      } = /** @type {{ messageNumber: number, strings?: string[], edgeNames?: string[], petNames?: string[] }} */ (
        args
      );
      if (messageNumber === undefined) {
        throw new Error('messageNumber is required');
      }
      await E(powers).reply(
        BigInt(messageNumber),
        strings,
        edgeNames,
        petNames,
      );
      return `Replied to message #${messageNumber}`;
    },
    help() {
      return 'Reply to a message by number, automatically routing to the sender.';
    },
  });
};
harden(makeReplyTool);

/**
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @returns {FaeTool}
 */
export const makeListMessagesTool = powers => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'listMessages',
      description:
        'List messages in your inbox. Returns an array of message summaries ' +
        'with number, from, and edge names.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    // eslint-disable-next-line no-underscore-dangle
    async execute(_args) {
      return E(powers).listMessages();
    },
    help() {
      return 'List messages in your inbox.';
    },
  });
};
harden(makeListMessagesTool);

/**
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @returns {FaeTool}
 */
export const makeDismissTool = powers => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'dismiss',
      description: 'Dismiss (acknowledge) a message from your inbox by number.',
      parameters: {
        type: 'object',
        properties: {
          messageNumber: {
            type: 'integer',
            description: 'The message number to dismiss (integer).',
          },
        },
        required: ['messageNumber'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { messageNumber } = /** @type {{ messageNumber: number }} */ (args);
      if (messageNumber === undefined) {
        throw new Error('messageNumber is required');
      }
      await E(powers).dismiss(BigInt(messageNumber));
      return `Dismissed message #${messageNumber}`;
    },
    help() {
      return 'Dismiss a message from your inbox by number.';
    },
  });
};
harden(makeDismissTool);

/**
 * Meta-tool for adopting a capability from a mail message as a tool.
 * Adopted capabilities are placed in the tools/ directory and become
 * immediately available.
 *
 * @param {import('@endo/eventual-send').ERef<object>} host
 * @returns {FaeTool}
 */
export const makeAdoptToolTool = host => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'adoptTool',
      description:
        'Adopt a capability from a mail message and install it as a tool. ' +
        'The adopted capability must implement the FaeTool interface (schema, execute, help). ' +
        'Once adopted, the tool is immediately available — use it right away.',
      parameters: {
        type: 'object',
        properties: {
          messageNumber: {
            type: 'integer',
            description:
              'The message number containing the tool capability (integer).',
          },
          edgeName: {
            type: 'string',
            description: 'The edge name (label) of the tool in the message.',
          },
          toolName: {
            type: 'string',
            description:
              'Name for the tool in the tools/ directory (e.g., "my-tool").',
          },
        },
        required: ['messageNumber', 'edgeName', 'toolName'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { messageNumber, edgeName, toolName } =
        /** @type {{ messageNumber: number, edgeName: string, toolName: string }} */ (
          args
        );
      if (messageNumber === undefined || !edgeName || !toolName) {
        throw new Error('messageNumber, edgeName, and toolName are required');
      }
      await E(host).adopt(BigInt(messageNumber), edgeName, ['tools', toolName]);
      return `Adopted tool "${toolName}" from message #${messageNumber}. It is now available — use it immediately.`;
    },
    help() {
      return 'Adopt a capability from a mail message and install it as a tool.';
    },
  });
};
harden(makeAdoptToolTool);

/**
 * @param {object} host
 */
export const makeAdoptTool = host => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'adopt',
      description:
        'Adopt a value from an incoming package message, giving it a pet name. ' +
        'Edge names are the labels the sender attached to values in the package ' +
        '(the @name references in the message text).',
      parameters: {
        type: 'object',
        properties: {
          messageNumber: {
            type: 'integer',
            description: 'The message number containing the value (integer).',
          },
          edgeName: {
            type: 'string',
            description: 'The edge name (label) of the value in the message.',
          },
          petName: {
            type: 'string',
            description:
              'The pet name to give the adopted value in your directory.',
          },
        },
        required: ['messageNumber', 'edgeName', 'petName'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { messageNumber, edgeName, petName } =
        /** @type {{ messageNumber: number, edgeName: string, petName: string }} */ (
          args
        );
      if (messageNumber === undefined || !edgeName || !petName) {
        throw new Error('messageNumber, edgeName, and petName are required');
      }
      await E(host).adopt(BigInt(messageNumber), edgeName, petName);
      return `Adopted "${edgeName}" from message #${messageNumber} as "${petName}".`;
    },
    help() {
      return 'Adopt a value from a mail message into your petname directory.';
    },
  });
};
harden(makeAdoptTool);

/**
 * Create a general-purpose exec tool that lets the agent run arbitrary
 * JavaScript with access to its own guest powers and E (eventual send).
 * Code runs in a Compartment with powers, E, harden, and console as
 * endowments, so the agent can adopt, join channels, post, and compose
 * multi-step operations in a single tool call.
 *
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @returns {FaeTool}
 */
export const makeExecTool = powers => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'exec',
      description:
        'Execute JavaScript code with access to your guest powers. ' +
        'The code runs as an async function body (top-level await works). ' +
        'Return a value to get it as the tool result.\n\n' +
        'Available globals:\n' +
        '- powers: your guest interface (adopt, reply, send, lookup, list, followMessages, etc.)\n' +
        '- E: eventual send — use E(ref).method() for all remote calls\n' +
        '- harden: freeze objects for safe passing\n' +
        '- console: for logging\n\n' +
        'Example — adopt a channel, join it, and post a reply:\n' +
        '```\n' +
        'await E(powers).adopt(13n, "danzone", "my-channel");\n' +
        'const channel = await E(powers).lookup("my-channel");\n' +
        'const member = await E(channel).join("fae");\n' +
        'await E(member).post(["Hello from fae!"], [], []);\n' +
        'return "Posted to channel";\n' +
        '```',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'JavaScript code to execute. Runs as an async function body. ' +
              'Use E(powers).method() for guest operations. Return a result.',
          },
        },
        required: ['code'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { code } = /** @type {{ code: string }} */ (args);
      if (!code) {
        throw new Error('code is required');
      }
      // Wrap in an async IIFE so top-level await works
      const wrappedSource = `(async (powers, E, harden, console) => {\n${code}\n})`;
      const c = new Compartment({
        __options__: true,
        globals: { BigInt },
      });
      const fn = c.evaluate(wrappedSource);
      const result = await fn(powers, E, harden, console);
      if (result === undefined) {
        return 'done (no return value)';
      }
      try {
        return JSON.stringify(result, null, 2);
      } catch {
        return String(result);
      }
    },
    help() {
      return (
        'Execute JavaScript code with access to guest powers, E, and harden. ' +
        'Use for multi-step operations like adopting values, joining channels, ' +
        'and posting messages in a single call.'
      );
    },
  });
};
harden(makeExecTool);

/**
 * Create a readChannel tool that returns a formatted transcript of
 * channel messages with IDs, authors, and thread structure.
 *
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @returns {FaeTool}
 */
export const makeReadChannelTool = powers => {
  /** @type {ToolSchema} */
  const toolSchema = harden({
    type: 'function',
    function: {
      name: 'readChannel',
      description:
        'Read messages from a channel. Returns a transcript with ' +
        'message IDs, authors, thread structure, and content. ' +
        'Use the message ID in the replyTo parameter of post() to ' +
        'reply to a specific message thread.',
      parameters: {
        type: 'object',
        properties: {
          channelName: {
            type: 'string',
            description: 'Pet name of the channel to read.',
          },
          count: {
            type: 'integer',
            description: 'Number of recent messages to return (default: 20).',
          },
        },
        required: ['channelName'],
      },
    },
  });

  return harden({
    schema() {
      return toolSchema;
    },
    async execute(args) {
      const { channelName, count = 20 } =
        /** @type {{ channelName: string, count?: number }} */ (args);
      if (!channelName) {
        throw new Error('channelName is required');
      }
      const channel = await E(powers).lookup(channelName);
      const rawMessages = await E(channel).listMessages();
      const messages = /** @type {any[]} */ (rawMessages);

      // Build member name lookup
      /** @type {Map<string, string>} */
      const memberNames = new Map();
      try {
        const adminId = await E(channel).getMemberId();
        const adminName = await E(channel).getProposedName();
        memberNames.set(adminId, adminName);
      } catch {
        // not available
      }
      try {
        const members = /** @type {any[]} */ (await E(channel).getMembers());
        for (const m of members) {
          memberNames.set(m.memberId, m.proposedName || m.invitedAs);
        }
      } catch {
        // not available
      }

      const shown = messages.slice(-count);
      const lines = [];
      for (const msg of shown) {
        const author = memberNames.get(msg.memberId) || msg.memberId;
        const text = Array.isArray(msg.strings) ? msg.strings.join('') : '';
        const replyTo = msg.replyTo ? ` (reply to #${msg.replyTo})` : '';
        // eslint-disable-next-line @endo/restrict-comparison-operands
        const preview = text.length > 300 ? `${text.slice(0, 300)}...` : text;
        lines.push(`[#${msg.number}] ${author}${replyTo}: ${preview}`);
      }
      return lines.join('\n');
    },
    help() {
      return (
        'Read channel messages with IDs, authors, and thread info. ' +
        'Use message IDs to reply to specific threads.'
      );
    },
  });
};
harden(makeReadChannelTool);
