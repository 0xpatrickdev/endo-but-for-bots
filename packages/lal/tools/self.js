// @ts-check

import { E } from '@endo/eventual-send';

import { makeEntry } from './helpers.js';

/** @import { ToolEntry } from '../agent.types.js' */

/** @type {ToolEntry['execute']} */
const executeHelp = ({ methodName }, { powers }) => E(powers).help(methodName);

/** @type {Array<[string, ToolEntry]>} */
export const selfToolEntries = [
  makeEntry(
    'help',
    'Get documentation for guest capabilities or a specific method. Call with no arguments for an overview, or with a method name for specific documentation.',
    {
      methodName: {
        type: 'string',
        description: 'Optional method name to get specific documentation for.',
      },
    },
    [],
    'parallel',
    executeHelp,
  ),
];
