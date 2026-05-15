// @ts-check

import { E } from '@endo/eventual-send';

import { makeEntry, nameOrPathProperty } from './helpers.js';

/** @import { ToolEntry } from '../agent.types.js' */

/** @type {ToolEntry['execute']} */
const executeEvaluate = (
  {
    workerName: rawWorkerName,
    source,
    codeNames = [],
    edgeNames = [],
    resultName,
  },
  { powers },
) => {
  if (source === undefined) {
    throw new Error('source is required');
  }
  if (resultName === undefined) {
    throw new Error('resultName is required');
  }
  const workerName =
    rawWorkerName === 'undefined' || rawWorkerName === '#undefined'
      ? undefined
      : rawWorkerName;

  return E(powers).evaluate(
    workerName,
    source,
    harden(codeNames),
    harden(edgeNames),
    resultName,
  );
};

/** @type {ToolEntry['execute']} */
const executeDefine = ({ source, slots }, { powers }) => {
  if (source === undefined) {
    throw new Error('source is required');
  }
  if (slots === undefined) {
    throw new Error('slots is required');
  }
  return E(powers).define(source, harden(slots));
};

/** @type {Array<[string, ToolEntry]>} */
export const codeToolEntries = [
  makeEntry(
    'evaluate',
    `\
Evaluate JavaScript code directly.

The code executes immediately and returns the result. The result is stored under
the pet name you specify as resultName. You can then lookup(resultName) or send
it to the requester.

The code can reference values from your directory using the codeNames/edgeNames mapping:
- codeNames: Variable names that will be available in your source code
- edgeNames: Pet names of values from your directory to provide as those variables

Example: To run "E(counter).increment()" where counter is a value you have named "my-counter",
and store the result as "increment-result":
  evaluate(undefined, "E(counter).increment()", ["counter"], ["my-counter"], "increment-result")`,
    {
      workerName: {
        type: 'string',
        description:
          'Optional worker name to execute in. Use undefined for the default worker.',
      },
      source: {
        type: 'string',
        description: 'The JavaScript source code to evaluate.',
      },
      codeNames: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Variable names used in the source code that need to be provided.',
      },
      edgeNames: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Pet names from your directory providing the values for each codeName.',
      },
      resultName: nameOrPathProperty(
        'Pet name (or path) where the evaluation result will be stored. You can then lookup and send the result.',
      ),
    },
    ['source', 'codeNames', 'edgeNames', 'resultName'],
    'sequential',
    executeEvaluate,
  ),
  makeEntry(
    'define',
    `\
Propose a reusable program with named capability slots for the host to fill.
Unlike evaluate(), you do NOT provide the capabilities yourself — the host
chooses what to bind from their own inventory. This is the preferred way to
request code execution when you don't have the required capabilities.

The host sees the code and slot labels, fills each slot with a capability
from their pet store, and the code is executed. The host can submit the
program multiple times with different bindings. You do not receive any
notification when the program is submitted — the result is private to the host.

Example: To request incrementing a counter you don't have:
  define("E(counter).increment()", {"counter": {"label": "A counter to increment"}})

The host will choose which counter to provide.`,
    {
      source: {
        type: 'string',
        description: 'The JavaScript source code to evaluate.',
      },
      slots: {
        type: 'object',
        description:
          'Named capability slots. Keys are variable names in source, values are objects with a "label" string describing what capability is needed.',
        additionalProperties: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description:
                'Human-readable description of what this slot needs.',
            },
          },
          required: ['label'],
        },
      },
    },
    ['source', 'slots'],
    'sequential',
    executeDefine,
  ),
];
