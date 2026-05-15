// @ts-check

import { E } from '@endo/eventual-send';

import { makeEntry, nameOrPathProperty } from './helpers.js';

/** @import { ToolEntry, ToolParameterProperty } from '../agent.types.js' */

/** @type {ToolParameterProperty} */
const stringsProperty = {
  type: 'array',
  items: { type: 'string' },
  description: 'Text fragments. Length should be edgeNames.length + 1.',
};

/** @type {ToolParameterProperty} */
const edgeNamesProperty = {
  type: 'array',
  items: { type: 'string' },
  description: 'Labels for the values being sent.',
};

/** @type {ToolParameterProperty} */
const petNamesProperty = {
  type: 'array',
  items: nameOrPathProperty('A pet name or pet name path.'),
  description: 'Pet names of values to include (same length as edgeNames).',
};

/** @type {ToolEntry['execute']} */
const executeSend = (
  { recipientName, strings, edgeNames, petNames },
  { powers },
) => {
  if (recipientName === undefined || !strings || !edgeNames || !petNames) {
    throw new Error(
      'recipientName, strings, edgeNames, and petNames are required',
    );
  }
  return E(powers).send(recipientName, strings, edgeNames, petNames);
};

/** @type {ToolEntry['execute']} */
const executeReply = async (
  { messageNumber, strings, edgeNames, petNames },
  { powers, leafNode, assembleTranscript, computeDepth },
) => {
  if (messageNumber === undefined || !strings || !edgeNames || !petNames) {
    throw new Error(
      'messageNumber, strings, edgeNames, and petNames are required',
    );
  }

  let depthStrings = strings;
  if (leafNode !== undefined && assembleTranscript && computeDepth) {
    const transcript = await assembleTranscript(leafNode.messageId);
    const depth = computeDepth(transcript);
    if (depthStrings.length !== 0) {
      depthStrings = [
        `[depth:${depth}] ${depthStrings[0]}`,
        ...depthStrings.slice(1),
      ];
    } else {
      depthStrings = [`[depth:${depth}]`];
    }
  }

  return E(powers).reply(messageNumber, depthStrings, edgeNames, petNames);
};

/** @type {Array<[string, ToolEntry]>} */
export const messagingToolEntries = [
  makeEntry(
    'send',
    `\
Send a package message with values to another agent.

The message is constructed from alternating text strings and value references:
- strings: Array of text fragments
- edgeNames: Array of labels for the values being sent (one fewer than strings)
- petNames: Array of pet names providing the values (same length as edgeNames)

Example: To send "Here is [counter] for you" where counter is a value:
  send("@host", ["Here is ", " for you"], ["counter"], ["my-counter"])

The recipient sees: "Here is @counter for you" and can adopt @counter.

IMPORTANT for code: When sending code, use a single string without edge names:
  send("@host", ["Here is the code:\\n\`\`\`javascript\\nconst x = 1;\\n\`\`\`"], [], [])

For multi-line content, include literal newlines in the string.`,
    {
      recipientName: nameOrPathProperty(
        'The pet name of the recipient, e.g., "@host" for your host.',
      ),
      strings: stringsProperty,
      edgeNames: edgeNamesProperty,
      petNames: petNamesProperty,
    },
    ['recipientName', 'strings', 'edgeNames', 'petNames'],
    'sequential',
    executeSend,
  ),
  makeEntry(
    'reply',
    `\
Reply to a message in your inbox, threading the response to the original message.
Use this instead of send() when responding to a received message.

The reply is automatically sent to the other party in the original conversation
and is threaded as a reply (the daemon sets replyTo on the outgoing message).

The message is constructed the same way as send():
- strings: Array of text fragments
- edgeNames: Array of labels for the values being sent
- petNames: Array of pet names providing the values

IMPORTANT: Always use reply() instead of send() when responding to a message.
Use send() only for initiating brand new conversations.`,
    {
      messageNumber: {
        type: 'string',
        description:
          'The message number (BigInt) to reply to. Use SmallCaps format: "+5" for message 5.',
      },
      strings: stringsProperty,
      edgeNames: edgeNamesProperty,
      petNames: petNamesProperty,
    },
    ['messageNumber', 'strings', 'edgeNames', 'petNames'],
    'sequential',
    executeReply,
  ),
];
