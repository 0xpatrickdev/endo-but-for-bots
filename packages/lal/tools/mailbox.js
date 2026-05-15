// @ts-check

import { E } from '@endo/eventual-send';

import { makeEntry, nameOrPathProperty } from './helpers.js';

/** @import { InboxMessage, ToolEntry, ToolParameterProperty } from '../agent.types.js' */

/** @type {ToolParameterProperty} */
const messageNumberProperty = {
  type: 'string',
  description:
    'The message number (BigInt). Use SmallCaps format: "+5" for message 5.',
};

/** @type {ToolEntry['execute']} */
const executeListMessages = async (_args, { powers }) => {
  const rawMessages = await E(powers).listMessages();
  return harden(
    rawMessages.map(
      (
        /** @type {InboxMessage & {messageId?: string, replyTo?: string}} */ msg,
      ) => {
        const isPackage = msg.type === 'package';
        return {
          number: msg.number,
          date: msg.date,
          from: msg.from,
          to: msg.to,
          type: msg.type,
          strings: isPackage ? msg.strings : undefined,
          names: isPackage ? msg.names : undefined,
          messageId: msg.messageId,
          replyTo: msg.replyTo,
        };
      },
    ),
  );
};

/** @type {ToolEntry['execute']} */
const executeResolve = ({ messageNumber, petNameOrPath }, { powers }) => {
  if (messageNumber === undefined || petNameOrPath === undefined) {
    throw new Error('messageNumber and petNameOrPath are required');
  }
  return E(powers).resolve(messageNumber, petNameOrPath);
};

/** @type {ToolEntry['execute']} */
const executeReject = ({ messageNumber, reason }, { powers }) => {
  if (messageNumber === undefined) {
    throw new Error('messageNumber is required');
  }
  return E(powers).reject(messageNumber, reason);
};

/** @type {ToolEntry['execute']} */
const executeAdopt = ({ messageNumber, edgeName, petName }, { powers }) => {
  if (
    messageNumber === undefined ||
    edgeName === undefined ||
    petName === undefined
  ) {
    throw new Error('messageNumber, edgeName, and petName are required');
  }
  return E(powers).adopt(messageNumber, edgeName, petName);
};

/** @type {ToolEntry['execute']} */
const executeDismiss = ({ messageNumber }, { powers }) => {
  if (messageNumber === undefined) {
    throw new Error('messageNumber is required');
  }
  return E(powers).dismiss(messageNumber);
};

/** @type {ToolEntry['execute']} */
const executeRequest = (
  { recipientName, description, responseName },
  { powers },
) => {
  if (recipientName === undefined || description === undefined) {
    throw new Error('recipientName and description are required');
  }
  return E(powers).request(recipientName, description, responseName);
};

/** @type {Array<[string, ToolEntry]>} */
export const mailboxToolEntries = [
  makeEntry(
    'listMessages',
    'List all messages in your inbox. Returns an array of message objects with number, date, from, type, and content.',
    {},
    [],
    'parallel',
    executeListMessages,
  ),
  makeEntry(
    'resolve',
    'Respond to a request message by providing a named value. The requester receives the resolved value.',
    {
      messageNumber: messageNumberProperty,
      petNameOrPath: nameOrPathProperty(
        'The pet name of the value to send as the response.',
      ),
    },
    ['messageNumber', 'petNameOrPath'],
    'sequential',
    executeResolve,
  ),
  makeEntry(
    'reject',
    'Decline a request message. The requester receives an error.',
    {
      messageNumber: messageNumberProperty,
      reason: {
        type: 'string',
        description: 'Optional reason for declining.',
      },
    },
    ['messageNumber'],
    'sequential',
    executeReject,
  ),
  makeEntry(
    'adopt',
    'Adopt a value from an incoming package message, giving it a pet name. Edge names are the labels the sender attached to values in the package.',
    {
      messageNumber: messageNumberProperty,
      edgeName: nameOrPathProperty(
        'The edge name (label) of the value in the message.',
      ),
      petName: nameOrPathProperty('The pet name to give the adopted value.'),
    },
    ['messageNumber', 'edgeName', 'petName'],
    'sequential',
    executeAdopt,
  ),
  makeEntry(
    'dismiss',
    'Remove a message from your inbox. Use after you have processed a message.',
    {
      messageNumber: messageNumberProperty,
    },
    ['messageNumber'],
    'sequential',
    executeDismiss,
  ),
  makeEntry(
    'request',
    'Send a request to another agent asking for a capability. The recipient sees your request and can resolve or reject it.',
    {
      recipientName: nameOrPathProperty(
        'The pet name of the recipient, e.g., "@host" for your host.',
      ),
      description: {
        type: 'string',
        description: 'A description of what capability you are requesting.',
      },
      responseName: nameOrPathProperty(
        'Optional pet name to store the response under.',
      ),
    },
    ['recipientName', 'description'],
    'sequential',
    executeRequest,
  ),
];
