// @ts-check

import { E } from '@endo/eventual-send';

import { makeEntry, nameOrPathProperty, pathProperty } from './helpers.js';

/** @import { ToolEntry } from '../agent.types.js' */

/** @type {ToolEntry['execute']} */
const executeHas = ({ petNamePath }, { powers }) => {
  if (!petNamePath) {
    throw new Error('petNamePath is required');
  }
  return E(powers).has(...petNamePath);
};

/** @type {ToolEntry['execute']} */
const executeList = async ({ name }, { powers }) => {
  if (name !== undefined) {
    const capability = await E(powers).lookup(name);
    return E(capability).list();
  }
  return E(powers).list();
};

/** @type {ToolEntry['execute']} */
const executeLookup = ({ petNameOrPath }, { powers }) => {
  if (petNameOrPath === undefined) {
    throw new Error('petNameOrPath is required');
  }
  return E(powers).lookup(petNameOrPath);
};

/** @type {ToolEntry['execute']} */
const executeRemove = ({ petNamePath }, { powers }) => {
  if (!petNamePath) {
    throw new Error('petNamePath is required');
  }
  return E(powers).remove(...petNamePath);
};

/** @type {ToolEntry['execute']} */
const executeMove = ({ fromPath, toPath }, { powers }) => {
  if (!fromPath || !toPath) {
    throw new Error('fromPath and toPath are required');
  }
  return E(powers).move(fromPath, toPath);
};

/** @type {ToolEntry['execute']} */
const executeCopy = ({ fromPath, toPath }, { powers }) => {
  if (!fromPath || !toPath) {
    throw new Error('fromPath and toPath are required');
  }
  return E(powers).copy(fromPath, toPath);
};

/** @type {ToolEntry['execute']} */
const executeMakeDirectory = ({ petNamePath }, { powers }) => {
  if (!petNamePath) {
    throw new Error('petNamePath is required');
  }
  return E(powers).makeDirectory(petNamePath);
};

/** @type {Array<[string, ToolEntry]>} */
export const directoryToolEntries = [
  makeEntry(
    'has',
    'Check if a pet name exists in the directory. Returns true or false.',
    {
      petNamePath: pathProperty(
        'The pet name path to check, e.g., ["counter"] or ["subdir", "value"].',
      ),
    },
    ['petNamePath'],
    'parallel',
    executeHas,
  ),
  makeEntry(
    'list',
    'List contents of your directory or any capability you have a pet name for. With no arguments, lists pet names in your root directory. With a name, looks up that capability and calls list() on it (works on ReadableTree, WritableTree, directories, etc.).',
    {
      name: nameOrPathProperty(
        'Optional pet name or path of a capability to list. Omit to list your own root directory.',
      ),
    },
    [],
    'parallel',
    executeList,
  ),
  makeEntry(
    'lookup',
    'Resolve a pet name or path to its value. Returns the value stored under that name.',
    {
      petNameOrPath: nameOrPathProperty(
        'A pet name string like "counter" or a path array like ["subdir", "value"].',
      ),
    },
    ['petNameOrPath'],
    'parallel',
    executeLookup,
  ),
  makeEntry(
    'remove',
    'Remove a pet name from the directory. The underlying value is not deleted, just the name mapping.',
    {
      petNamePath: pathProperty('The pet name path to remove.'),
    },
    ['petNamePath'],
    'sequential',
    executeRemove,
  ),
  makeEntry(
    'move',
    'Move/rename a reference from one name to another. The original name is removed.',
    {
      fromPath: pathProperty('The source pet name path.'),
      toPath: pathProperty('The destination pet name path.'),
    },
    ['fromPath', 'toPath'],
    'sequential',
    executeMove,
  ),
  makeEntry(
    'copy',
    'Copy a reference to a new name. Both names will refer to the same value.',
    {
      fromPath: pathProperty('The source pet name path.'),
      toPath: pathProperty('The destination pet name path.'),
    },
    ['fromPath', 'toPath'],
    'sequential',
    executeCopy,
  ),
  makeEntry(
    'makeDirectory',
    'Create a new subdirectory at the given path.',
    {
      petNamePath: pathProperty('The path for the new directory.'),
    },
    ['petNamePath'],
    'sequential',
    executeMakeDirectory,
  ),
];
