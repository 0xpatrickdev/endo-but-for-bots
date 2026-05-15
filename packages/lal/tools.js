// @ts-check
/* eslint-disable no-await-in-loop */

import { makeMarshal, passableAsJustin } from '@endo/marshal';

import { capabilityToolEntries } from './tools/capability.js';
import { codeToolEntries } from './tools/code.js';
import { directoryToolEntries } from './tools/directory.js';
import { mailToolEntries } from './tools/mail.js';
import { selfToolEntries } from './tools/self.js';

/** @import { Tool, ToolCall, ToolCallArgs, ToolContext, ToolEntry, ToolResult } from './agent.types.js' */

const { unserialize } = makeMarshal(undefined, undefined, {
  serializeBodyFormat: 'smallcaps',
});

/** @type {Array<[string, ToolEntry]>} */
const toolEntries = [
  ...selfToolEntries,
  ...directoryToolEntries,
  ...mailToolEntries,
  ...capabilityToolEntries,
  ...codeToolEntries,
];

/** @type {ReadonlyMap<string, ToolEntry>} */
export const toolRegistry = harden(new Map(toolEntries));

/** @type {Tool[]} */
export const tools = harden(toolEntries.map(([_name, entry]) => entry.schema));

/**
 * Decode a tool call's arguments.
 *
 * @param {ToolCall['function']['arguments']} argsRaw
 * @returns {ToolCallArgs}
 */
export const decodeToolCallArgs = argsRaw => {
  const jsonString =
    typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
  try {
    return /** @type {ToolCallArgs} */ (
      unserialize({ body: `#${jsonString}`, slots: [] })
    );
  } catch {
    try {
      return /** @type {ToolCallArgs} */ (JSON.parse(jsonString));
    } catch {
      return {};
    }
  }
};

/**
 * Execute a named tool call.
 *
 * @param {string} name
 * @param {ToolCallArgs} args
 * @param {ToolContext} context
 * @returns {Promise<unknown>}
 */
export const executeTool = async (name, args, context) => {
  const entry = toolRegistry.get(name);
  if (entry === undefined) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return entry.execute(args, context);
};

/**
 * @param {ToolCall} toolCall
 * @param {ToolContext} context
 * @returns {Promise<ToolResult>}
 */
const processOneToolCall = async (toolCall, context) => {
  const { name, arguments: argsRaw } = toolCall.function;
  const args = decodeToolCallArgs(argsRaw);

  console.log(
    `[tool] ${name}(${passableAsJustin(/** @type {any} */ (harden(args)), false)})`,
  );

  /** @type {unknown} */
  let result;
  try {
    result = await executeTool(name, args, context);
    console.log(
      `[tool] ${name} -> ${passableAsJustin(/** @type {any} */ (result), false)}`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result = harden({ error: errorMessage });
    console.error(`[tool] ${name} error: ${errorMessage}`);
  }

  return {
    role: 'tool',
    content: passableAsJustin(/** @type {any} */ (result), false),
    tool_call_id: toolCall.id,
  };
};

/**
 * Process tool calls from an LLM response. A batch runs in parallel only when
 * every requested tool is marked parallel; mixed or mutating batches remain
 * sequential.
 *
 * @param {ToolCall[]} toolCalls
 * @param {ToolContext} context
 * @returns {Promise<ToolResult[]>}
 */
export const processToolCalls = async (toolCalls, context) => {
  const canRunParallel = toolCalls.every(
    toolCall =>
      toolRegistry.get(toolCall.function.name)?.executionMode === 'parallel',
  );

  if (canRunParallel) {
    return Promise.all(
      toolCalls.map(toolCall => processOneToolCall(toolCall, context)),
    );
  }

  /** @type {ToolResult[]} */
  const results = [];
  for (const toolCall of toolCalls) {
    results.push(await processOneToolCall(toolCall, context));
  }
  return results;
};
