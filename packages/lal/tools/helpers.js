// @ts-check

/** @import { ToolEntry, ToolParameterProperty } from '../agent.types.js' */

/**
 * @param {string} description
 * @returns {ToolParameterProperty}
 */
export const pathProperty = description => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

/**
 * @param {string} description
 * @returns {ToolParameterProperty}
 */
export const nameOrPathProperty = description => ({
  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description,
});

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, ToolParameterProperty>} properties
 * @param {string[]} required
 * @param {'parallel' | 'sequential'} executionMode
 * @param {ToolEntry['execute']} execute
 * @returns {[string, ToolEntry]}
 */
export const makeEntry = (
  name,
  description,
  properties,
  required,
  executionMode,
  execute,
) => [
  name,
  {
    schema: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties,
          required,
        },
      },
    },
    executionMode,
    execute,
  },
];
