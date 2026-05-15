// @ts-check

import { E } from '@endo/eventual-send';

import { makeEntry, nameOrPathProperty, pathProperty } from './helpers.js';

/** @import { ToolEntry } from '../agent.types.js' */

/** @type {ToolEntry['execute']} */
const executeLocate = ({ petNamePath }, { powers }) => {
  if (!petNamePath) {
    throw new Error('petNamePath is required');
  }
  return E(powers).locate(...petNamePath);
};

/** @type {ToolEntry['execute']} */
const executeInspect = async ({ petNameOrPath }, { powers }) => {
  if (petNameOrPath === undefined) {
    throw new Error('petNameOrPath is required');
  }
  const capability = await E(powers).lookup(petNameOrPath);
  const parts = [];
  try {
    const helpText = await E(capability).help();
    parts.push(helpText);
  } catch {
    parts.push(`Capability at "${petNameOrPath}" does not implement help().`);
  }
  try {
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(capability).__getMethodNames__();
    parts.push(`\nMethods: ${methods.join(', ')}`);
  } catch {
    // No __getMethodNames__ available.
  }
  return parts.join('\n');
};

/** @type {ToolEntry['execute']} */
const executeReadText = async ({ petNameOrPath, fileName }, { powers }) => {
  if (petNameOrPath === undefined || fileName === undefined) {
    throw new Error('petNameOrPath and fileName are required');
  }
  const capability = await E(powers).lookup(petNameOrPath);
  return E(capability).readText(fileName);
};

/** @type {ToolEntry['execute']} */
const executeWriteText = async (
  { petNameOrPath, fileName, content },
  { powers },
) => {
  if (
    petNameOrPath === undefined ||
    fileName === undefined ||
    content === undefined
  ) {
    throw new Error('petNameOrPath, fileName, and content are required');
  }
  const capability = await E(powers).lookup(petNameOrPath);
  return E(capability).writeText(fileName, content);
};

/** @type {Array<[string, ToolEntry]>} */
export const capabilityToolEntries = [
  makeEntry(
    'locate',
    'Get the locator URL for a pet name. Returns an "endo://..." URL string. Use locate(["@self"]) to get your own locator, then compare it against the "from" field of messages to determine if you sent them. Only pass pet names you know exist (use list() first if unsure).',
    {
      petNamePath: pathProperty(
        'The pet name path to locate, e.g., ["@self"] or ["@host"].',
      ),
    },
    ['petNamePath'],
    'parallel',
    executeLocate,
  ),
  makeEntry(
    'inspect',
    'Look up a capability by pet name and call its help() method to learn how to use it. Use this to discover what methods a capability provides.',
    {
      petNameOrPath: nameOrPathProperty(
        'The pet name or path of the capability to inspect.',
      ),
    },
    ['petNameOrPath'],
    'parallel',
    executeInspect,
  ),
  makeEntry(
    'readText',
    'Read text content from a capability (ReadableTree, WritableTree, etc.). Looks up the capability by pet name and calls readText(fileName) on it.',
    {
      petNameOrPath: nameOrPathProperty(
        'The pet name or path of the capability to read from.',
      ),
      fileName: {
        type: 'string',
        description: 'The file name to read within the capability.',
      },
    },
    ['petNameOrPath', 'fileName'],
    'parallel',
    executeReadText,
  ),
  makeEntry(
    'writeText',
    'Write text content to a capability (WritableTree, etc.). Looks up the capability by pet name and calls writeText(fileName, content) on it.',
    {
      petNameOrPath: nameOrPathProperty(
        'The pet name or path of the capability to write to.',
      ),
      fileName: {
        type: 'string',
        description: 'The file name to write within the capability.',
      },
      content: {
        type: 'string',
        description: 'The text content to write.',
      },
    },
    ['petNameOrPath', 'fileName', 'content'],
    'sequential',
    executeWriteText,
  ),
];
