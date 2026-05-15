// @ts-check

import { mailboxToolEntries } from './mailbox.js';
import { messagingToolEntries } from './messaging.js';

/** @import { ToolEntry } from '../agent.types.js' */

/** @type {Array<[string, ToolEntry]>} */
export const mailToolEntries = [...mailboxToolEntries, ...messagingToolEntries];
