// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import harden from '@endo/harden';

import { defineAgent, describeAgent } from '../index.js';

/**
 * @param {string} helpText
 */
const makeStrategy = helpText =>
  harden({
    help: () => helpText,
  });

test('defineAgent preserves strategy object identity', t => {
  const lifecycle = makeStrategy('factory driver lifecycle');
  const inbox = makeStrategy('inbox ingress');
  const mainRole = makeStrategy('main Pi role');
  const orchestrator = makeStrategy('single-role orchestrator');
  const adoption = makeStrategy('mail adoption policy');
  const authority = makeStrategy('ambient authority provider');
  const toolSet = harden({ id: 'tool-set' });

  const definition = defineAgent({
    name: 'fae',
    lifecycle,
    ingress: [inbox],
    roles: { main: mainRole },
    orchestrator,
    adoption,
    authority,
    tools: { builtins: toolSet },
  });

  t.is(definition.lifecycle, lifecycle);
  t.is(definition.ingress[0], inbox);
  t.is(definition.roles.main, mainRole);
  t.is(definition.orchestrator, orchestrator);
  t.is(definition.adoption, adoption);
  t.is(definition.authority, authority);
  t.is(definition.tools.builtins, toolSet);
});

test('describeAgent reads component help through object references', async t => {
  const definition = defineAgent({
    name: 'jaine',
    lifecycle: makeStrategy('factory driver lifecycle'),
    ingress: [makeStrategy('inbox ingress'), makeStrategy('channel ingress')],
    roles: {
      router: makeStrategy('router role'),
      composer: makeStrategy('composer role'),
      executor: makeStrategy('executor role'),
    },
    orchestrator: makeStrategy('channel conversation orchestrator'),
    adoption: makeStrategy('mail adoption policy'),
    authority: makeStrategy('channel authority provider'),
  });

  const description = await describeAgent(definition);
  t.deepEqual(description, {
    name: 'jaine',
    lifecycle: 'factory driver lifecycle',
    ingress: ['inbox ingress', 'channel ingress'],
    roles: {
      router: 'router role',
      composer: 'composer role',
      executor: 'executor role',
    },
    orchestrator: 'channel conversation orchestrator',
    adoption: 'mail adoption policy',
    authority: 'channel authority provider',
  });
});

test('defineAgent requires a name and lifecycle object', t => {
  t.throws(() => defineAgent({ name: '', lifecycle: {} }), {
    message: 'name is required',
  });
  t.throws(
    () =>
      defineAgent({
        name: 'broken',
        lifecycle: /** @type {object} */ (undefined),
      }),
    {
      message: 'lifecycle is required',
    },
  );
});
