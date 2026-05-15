// @ts-check
/* global setTimeout */

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';

import {
  executeTool,
  processToolCalls,
  toolRegistry,
  tools,
} from '../tools.js';
import {
  extractToolCallsFromContent,
  normalizeToolCallsFromContent,
} from '../providers/xml-tool-calls.js';
import { toOpenAICompatibleMessages } from '../providers/openai-compatible-messages.js';

/**
 * @param {string} id
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {import('../agent.types.js').ToolCall}
 */
const makeToolCall = (id, name, args) => ({
  id,
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

const waitOneTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test('tool registry exposes one schema per unique handler', t => {
  const names = tools.map(tool => tool.function.name);

  t.is(names.length, toolRegistry.size);
  t.is(new Set(names).size, names.length);

  for (const name of names) {
    const entry = toolRegistry.get(name);
    t.truthy(entry);
    t.is(entry?.schema.function.name, name);
    t.true(
      entry?.executionMode === 'parallel' ||
        entry?.executionMode === 'sequential',
    );
  }
});

test('reply tool computes depth from explicit tool context', async t => {
  /** @type {unknown[]} */
  const replies = [];
  const powers = harden({
    reply(messageNumber, strings, edgeNames, petNames) {
      replies.push({ messageNumber, strings, edgeNames, petNames });
      return 'replied';
    },
  });

  await executeTool(
    'reply',
    {
      messageNumber: 7,
      strings: ['hello'],
      edgeNames: [],
      petNames: [],
    },
    {
      powers,
      leafNode: {
        messageId: 'leaf',
        parentMessageId: null,
        messages: [],
      },
      assembleTranscript: async () => [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', content: 'result' },
      ],
      computeDepth: messages =>
        messages.filter(
          message => message.role === 'user' || message.role === 'assistant',
        ).length,
    },
  );

  t.deepEqual(replies, [
    {
      messageNumber: 7,
      strings: ['[depth:2] hello'],
      edgeNames: [],
      petNames: [],
    },
  ]);
});

test('parallel tool batch starts all read-only tools and preserves result order', async t => {
  /** @type {string[]} */
  const started = [];
  const hasRelease = makePromiseKit();
  const hasStarted = makePromiseKit();

  const powers = harden({
    has(...petNamePath) {
      started.push(`has:${petNamePath.join('/')}`);
      hasStarted.resolve(undefined);
      return hasRelease.promise.then(() => true);
    },
    locate(...petNamePath) {
      started.push(`locate:${petNamePath.join('/')}`);
      return 'endo://self';
    },
  });

  const pending = processToolCalls(
    [
      makeToolCall('first', 'has', { petNamePath: ['counter'] }),
      makeToolCall('second', 'locate', { petNamePath: ['@self'] }),
    ],
    { powers },
  );

  await hasStarted.promise;
  await waitOneTurn();
  t.deepEqual(started, ['has:counter', 'locate:@self']);

  hasRelease.resolve(undefined);
  const results = await pending;
  t.deepEqual(
    results.map(result => result.tool_call_id),
    ['first', 'second'],
  );
});

test('mixed tool batch falls back to sequential execution', async t => {
  /** @type {string[]} */
  const calls = [];
  const helpStarted = makePromiseKit();
  const helpRelease = makePromiseKit();

  const powers = harden({
    help() {
      calls.push('help');
      helpStarted.resolve(undefined);
      return helpRelease.promise;
    },
    send(_recipientName, _strings, _edgeNames, _petNames) {
      calls.push('send');
      return 'sent';
    },
  });

  const pending = processToolCalls(
    [
      makeToolCall('first', 'help', {}),
      makeToolCall('second', 'send', {
        recipientName: '@host',
        strings: ['hello'],
        edgeNames: [],
        petNames: [],
      }),
    ],
    { powers },
  );

  await helpStarted.promise;
  await waitOneTurn();
  t.deepEqual(calls, ['help']);

  helpRelease.resolve('helped');
  const results = await pending;
  t.deepEqual(calls, ['help', 'send']);
  t.deepEqual(
    results.map(result => result.tool_call_id),
    ['first', 'second'],
  );
});

test('XML tool-call normalization is provider-side', t => {
  const content = `<think>hidden</think>
<tool_call>{"name":"list","arguments":{"name":"primer"}}</tool_call>`;

  const extracted = extractToolCallsFromContent(content);
  t.is(extracted.cleanedContent, '');
  t.like(extracted.toolCalls[0], {
    function: {
      name: 'list',
      arguments: '{"name":"primer"}',
    },
  });

  const normalized = normalizeToolCallsFromContent(
    /** @type {import('../agent.types.js').ChatMessage} */ ({
      role: 'assistant',
      content,
    }),
  );
  t.is(normalized.content, '');
  t.is(normalized.tool_calls?.[0].function.name, 'list');
});

test('OpenAI-compatible history preserves tool call type', t => {
  const messages = toOpenAICompatibleMessages([
    { role: 'user', content: 'What tools do you have?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_123',
          function: {
            name: 'reply',
            arguments: { messageNumber: 1, strings: ['hello'] },
          },
        },
      ],
    },
    {
      role: 'tool',
      content: '"Replied"',
      tool_call_id: 'call_123',
    },
  ]);

  t.deepEqual(messages, [
    { role: 'user', content: 'What tools do you have?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'reply',
            arguments: '{"messageNumber":1,"strings":["hello"]}',
          },
        },
      ],
    },
    {
      role: 'tool',
      content: '"Replied"',
      tool_call_id: 'call_123',
    },
  ]);
});
