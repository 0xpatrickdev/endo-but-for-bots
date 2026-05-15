// @ts-check
/* eslint-disable no-await-in-loop */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/eventual-send';
import { makeRefIterator } from '@endo/daemon/ref-reader.js';
import { makeLocalTree } from '@endo/platform/fs/node';

import { createProvider } from './providers/index.js';
import { systemPrompt } from './system-prompt.js';
import { processToolCalls, tools } from './tools.js';

/** @import { FarRef } from '@endo/eventual-send' */
/** @import { GuestPowers, ToolCall, ChatMessage, InboxMessage, LalContext } from './agent.types.js' */

// ============================================================================
// Interface Definition
// ============================================================================

const LalInterface = M.interface('Lal', {
  help: M.call().optional(M.string()).returns(M.string()),
});

// ============================================================================
// Agent Implementation
// ============================================================================

/**
 * Spawn a worker loop that follows a guest's inbox and processes messages
 * using the given LLM configuration.
 *
 * @param {any} powers - Guest powers (manager's own or a sub-guest's)
 * @param {Promise<object> | object | null | undefined} context - Context for cancellation
 * @param {{ LAL_HOST?: string, LAL_MODEL?: string, LAL_AUTH_TOKEN?: string }} workerEnv - LLM provider config
 * @returns {Promise<void>}
 */
export const spawnWorkerLoop = async (powers, context, workerEnv) => {
  const getCancelled = async () => {
    if (!context) return null;
    const resolvedContext = await context;
    if (!resolvedContext) return null;
    if (typeof resolvedContext.whenCancelled === 'function') {
      return E(resolvedContext).whenCancelled();
    }
    if (resolvedContext.cancelled) {
      return resolvedContext.cancelled;
    }
    return null;
  };

  const provider = createProvider(workerEnv);

  /**
   * Chat with the LLM.
   * @param {ChatMessage[]} messages
   * @returns {Promise<{message: ChatMessage}>}
   */
  const chat = messages => provider.chat(messages, tools);

  // ---- Transcript Node Store ----
  // Each transcript is a linked chain of nodes. Each node stores only the
  // messages appended at that step, plus a pointer to the parent node.
  // The full transcript is assembled by walking the chain when calling the LLM.

  /** @import { TranscriptNode } from './agent.types.js' */

  /** @type {Map<string, TranscriptNode>} */
  const nodeCache = new Map();

  /**
   * Look up a transcript node, loading from durable storage if needed.
   * @param {string} messageId
   * @returns {Promise<TranscriptNode | undefined>}
   */
  const getNode = async messageId => {
    const cached = nodeCache.get(messageId);
    if (cached !== undefined) return cached;

    const petName = `transcript-${messageId}`;
    try {
      if (await E(powers).has(petName)) {
        const stored = /** @type {TranscriptNode} */ (
          await E(powers).lookup(petName)
        );
        // The stored node is hardened; make a mutable working copy.
        const mutable = { ...stored, messages: [...stored.messages] };
        nodeCache.set(messageId, mutable);
        return mutable;
      }
    } catch {
      // Storage lookup failed; treat as missing.
    }
    return undefined;
  };

  /**
   * Store a transcript node both in cache and durable storage.
   * @param {TranscriptNode} node
   */
  const putNode = async node => {
    nodeCache.set(node.messageId, node);
    const petName = `transcript-${node.messageId}`;
    try {
      // Harden a snapshot for storage; the working node stays mutable.
      await E(powers).storeValue(
        harden({ ...node, messages: [...node.messages] }),
        petName,
      );
    } catch (error) {
      console.error(
        `[transcript] Failed to persist node ${node.messageId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  /**
   * Assemble the full LLM transcript by walking the chain from leaf to root.
   * @param {string} leafMessageId
   * @returns {Promise<ChatMessage[]>}
   */
  const assembleTranscript = async leafMessageId => {
    /** @type {ChatMessage[][]} */
    const chain = [];
    /** @type {string | null} */
    let current = leafMessageId;
    while (current !== null) {
      const node = await getNode(current);
      if (node === undefined) break;
      chain.push(node.messages);
      current = node.parentMessageId;
    }
    chain.reverse();
    return chain.flat();
  };

  /**
   * Compute the conversational depth of a transcript (user + assistant turns).
   * @param {ChatMessage[]} messages
   * @returns {number}
   */
  const computeDepth = messages => {
    let count = 0;
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        count += 1;
      }
    }
    return count;
  };

  let nextRootId = 0;
  /**
   * Generate a unique string for use as a root node messageId.
   * These are only used as internal transcript-store keys, not as
   * cryptographic identifiers.
   * @returns {string}
   */
  const makeRootNodeId = () => {
    nextRootId += 1;
    return `root-${Date.now()}-${nextRootId}`;
  };

  /**
   * Run the agentic loop for a specific transcript node.
   * @param {TranscriptNode} leafNode - The leaf node of the transcript chain
   * @returns {Promise<void>}
   */
  const runAgenticLoop = async leafNode => {
    let continueLoop = true;
    while (continueLoop) {
      // Assemble the full transcript from the chain
      const transcript = await assembleTranscript(leafNode.messageId);

      console.log(
        `[lal] ${JSON.stringify(transcript[transcript.length - 1], null, 2)}`,
      );
      const response = await chat(transcript);

      const { message: responseMessage } = response;
      if (!responseMessage) {
        break;
      }

      // Add the assistant's response to the leaf node
      leafNode.messages.push(/** @type {ChatMessage} */ (responseMessage));
      console.log(
        `[lal] sent: ${JSON.stringify(leafNode.messages[leafNode.messages.length - 1], null, 2)}`,
      );

      // Check if there are tool calls to process
      const toolCalls = Array.isArray(responseMessage.tool_calls)
        ? responseMessage.tool_calls
        : [];
      if (toolCalls.length !== 0) {
        const toolResults = await processToolCalls(
          /** @type {ToolCall[]} */ (toolCalls),
          {
            powers,
            leafNode,
            assembleTranscript,
            computeDepth,
          },
        );
        console.log(
          `[lal] tool results: ${JSON.stringify(toolResults, null, 2)}`,
        );
        leafNode.messages.push(...toolResults);
        await putNode(leafNode);
      } else {
        continueLoop = false;
        await putNode(leafNode);

        // If the LLM produced text content (which it shouldn't), log it
        if (responseMessage.content) {
          console.log(`[assistant] ${responseMessage.content}`);
        }
      }
    }
  };

  /**
   * Build the user-role message content for an inbound message.
   * @param {InboxMessage & {type?: string}} _message
   * @param _message
   * @returns {string}
   */
  const formatInboundMessage = _message => {
    return 'You have new mail. Check your messages and respond appropriately.';
  };

  /**
   * Handle an own outbound message: create an alias so future replies
   * to this outbound messageId find the correct transcript chain.
   * @param {InboxMessage & {messageId?: string, replyTo?: string}} message
   */
  const handleOwnMessage = async message => {
    const { messageId, replyTo } = message;
    if (typeof messageId !== 'string' || typeof replyTo !== 'string') {
      return;
    }

    // replyTo points to the inbound message that triggered this response.
    // Create an alias: outboundMessageId → same node as replyTo.
    const node = await getNode(replyTo);
    if (node !== undefined) {
      nodeCache.set(messageId, node);
      const petName = `transcript-${messageId}`;
      try {
        await E(powers).storeValue(harden(node), petName);
      } catch (error) {
        console.error(
          `[transcript] Failed to alias ${messageId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };

  /**
   * Run the agent loop, processing incoming messages.
   * Each reply chain is routed to an independent transcript.
   *
   * @returns {Promise<void>}
   */
  const runAgent = async () => {
    // Announce ourselves with a call to action.
    // The host sees this from whatever pet name they gave us.
    await E(powers).send(
      '@host',
      [
        "Hello! I'm ready to help.\n\n" +
          'Send me a message to get started — in Chat, type ' +
          '`@` followed by my name and your request.\n\n' +
          'A few things to try:\n' +
          '- Ask me what I can do\n' +
          '- Ask me to list your inventory\n' +
          '- Ask me to help write a program\n\n' +
          'Type `/help` to see all available Chat commands.',
      ],
      [],
      [],
    );

    /** @type {string | undefined} */
    const selfLocator = await E(powers).locate('@self');
    const cancelled = await getCancelled();
    const cancelledSignal = cancelled
      ? cancelled.then(
          () => ({ cancelled: true }),
          () => ({ cancelled: true }),
        )
      : null;

    // Follow messages and route each to the correct transcript chain
    const messageIterator = makeRefIterator(E(powers).followMessages());
    while (true) {
      const nextMessage = messageIterator.next();
      const raced = cancelledSignal
        ? await Promise.race([
            cancelledSignal,
            nextMessage.then(result => ({ cancelled: false, result })),
          ])
        : { cancelled: false, result: await nextMessage };
      if (raced.cancelled) {
        try {
          await messageIterator.return?.();
        } catch {
          // ignore iterator return errors on cancellation
        }
        break;
      }
      const { value: message, done } = raced.result;
      if (done) {
        break;
      }
      const inboxMessage =
        /** @type {InboxMessage & {type?: string, messageId?: string, replyTo?: string}} */ (
          message
        );
      const {
        from: fromLocator,
        number,
        type,
        messageId,
        replyTo,
      } = inboxMessage;

      // Own outbound messages: index them for future reply lookups
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (fromLocator === selfLocator) {
        await handleOwnMessage(inboxMessage);
      } else {
        console.log(
          `[mail] New message #${number} (type: ${type || 'package'})`,
        );

        // Resolve or create the transcript chain for this message.
        /** @type {TranscriptNode | undefined} */
        let parentNode;
        /** @type {string} */
        let parentId;

        if (typeof replyTo === 'string') {
          parentNode = await getNode(replyTo);
        }

        if (parentNode !== undefined) {
          // Continue existing conversation.
          parentId = /** @type {string} */ (replyTo);
          console.log(
            `[transcript] Continuing chain from ${parentId.slice(0, 12)}...`,
          );
        } else {
          // New conversation — create a root node with the system prompt.
          const rootId = makeRootNodeId();
          /** @type {TranscriptNode} */
          const rootNode = {
            messageId: rootId,
            parentMessageId: null,
            messages: [{ role: 'system', content: systemPrompt }],
          };
          await putNode(rootNode);
          parentId = rootId;
          console.log('[transcript] Starting new conversation chain');
        }

        // Create a new node for this turn, chained to the parent.
        const userContent = formatInboundMessage(inboxMessage);

        /** @type {TranscriptNode} */
        const turnNode = {
          messageId:
            typeof messageId === 'string' ? messageId : makeRootNodeId(),
          parentMessageId: parentId,
          messages: [{ role: 'user', content: userContent }],
          lastInboxNumber: number,
        };
        await putNode(turnNode);

        // Run the agentic loop for this transcript chain
        try {
          await runAgenticLoop(turnNode);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error('[agent] LLM error, notifying sender:', errorMessage);
          try {
            await E(powers).reply(
              number,
              [`LLM provider error: ${errorMessage}`],
              [],
              [],
            );
          } catch (replyError) {
            console.error('[agent] Failed to notify sender:', replyError);
          }
        }

        const transcriptLength = (await assembleTranscript(turnNode.messageId))
          .length;
        console.log(
          `[lal] Transcript chain has ${transcriptLength} messages after processing`,
        );
      }
    }
  };

  // Start the worker loop
  await runAgent();
};
harden(spawnWorkerLoop);

// ============================================================================
// Manager / Entry Point
// ============================================================================

/**
 * Creates a Lal agent manager.
 *
 * Sends a configuration form to HOST on startup. Each form submission
 * creates a new guest profile and spawns a worker loop for it.
 *
 * @param {FarRef<GuestPowers>} guestPowers - Guest powers from the Endo daemon
 * @param {Promise<LalContext> | LalContext | undefined} _context - Context for cancellation support
 * @returns {object} The Lal exo object
 */
export const make = (guestPowers, _context) => {
  /** @type {any} */
  const powers = guestPowers;

  // Send the configuration form to HOST for adding agents.
  const runManager = async () => {
    await E(powers).form(
      '@host',
      'Add an agent',
      harden([
        { name: 'name', label: 'Agent name' },
        {
          name: 'host',
          label: 'API host',
          default: 'http://localhost:11434/v1',
          example: 'https://api.anthropic.com for Anthropic',
        },
        {
          name: 'model',
          label: 'Model name',
          default: 'qwen3',
          example: 'claude-sonnet-4-6-20250514 for Anthropic',
        },
        {
          name: 'authToken',
          label: 'API auth token',
          default: 'ollama',
          example: 'sk-ant-... for Anthropic',
          secret: true,
        },
      ]),
    );

    // Resolve the host agent reference for provideGuest calls.
    const agent = await E(powers).lookup('host-agent');
    const selfLocator = await E(powers).locate('@self');
    const activeWorkers = new Map();

    // Check in the primer directory as a content-addressed readable-tree.
    // Stored once in the host namespace; each sub-guest gets a reference.
    const primerDirPath = new URL('./primer', import.meta.url).pathname;
    const localPrimerTree = makeLocalTree(primerDirPath);
    await E(agent).storeTree(localPrimerTree, 'lal-primer');
    const primerTreeId = await E(agent).identify('lal-primer');
    console.log(`[lal] Primer tree checked in (${primerTreeId})`);

    /**
     * Ensure the sub-guest has a `primer` reference.
     * @param {any} guest
     */
    const provisionPrimer = async guest => {
      const hasPrimer = await E(guest).has('primer');
      if (!hasPrimer) {
        await E(guest).storeIdentifier('primer', primerTreeId);
        console.log('[lal] Primer provisioned for guest');
      }
    };

    // Pre-scan existing messages to find our latest form messageId so that
    // old value messages (from prior sessions) that reply to an earlier form
    // are not accidentally matched when the iterator replays history.
    /** @type {string | undefined} */
    let formMessageId;
    const existingMessages = /** @type {any[]} */ (
      await E(powers).listMessages()
    );
    for (const msg of existingMessages) {
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (msg.from === selfLocator && msg.type === 'form') {
        formMessageId = msg.messageId;
      }
    }

    const messageIterator = makeRefIterator(E(powers).followMessages());
    while (true) {
      const { value: message, done } = await messageIterator.next();
      if (done) break;

      const msg = /** @type {any} */ (message);

      // Capture the form's messageId from our own outbound message.
      // eslint-disable-next-line @endo/restrict-comparison-operands
      if (msg.from === selfLocator && msg.type === 'form') {
        formMessageId = msg.messageId;
      } else if (
        msg.type === 'value' &&
        // eslint-disable-next-line @endo/restrict-comparison-operands
        msg.replyTo === formMessageId
      ) {
        // Only process value messages that reply to our form.
        try {
          // Resolve the submitted values from the value message.
          const config =
            /** @type {{ name: string, host: string, model: string, authToken: string }} */ (
              await E(powers).lookupById(msg.valueId)
            );

          const { name } = config;

          if (activeWorkers.has(name)) {
            // A worker is already running for this name.
            await E(powers).reply(
              msg.number,
              [`Agent "${name}" already exists.`],
              [],
              [],
            );
          } else {
            // Create the guest profile via the host agent.
            // provideGuest returns the full EndoGuest (not the handle).
            // Guard with has() — on restart the guest already exists and
            // re-running provideGuest hits "Formula already exists".
            let guest;
            if (await E(agent).has(name)) {
              guest = await E(agent).lookup(name);
            } else {
              guest = await E(agent).provideGuest(name, {
                agentName: `profile-for-${name}`,
              });
            }

            // Ensure the sub-guest has the primer directory.
            await provisionPrimer(guest);

            // Spawn a worker loop for this guest.
            const workerP = spawnWorkerLoop(guest, null, {
              LAL_HOST: config.host,
              LAL_MODEL: config.model,
              LAL_AUTH_TOKEN: config.authToken,
            });
            activeWorkers.set(name, workerP);
            workerP.catch(error => {
              console.error(`[lal] Worker "${name}" error:`, error);
              activeWorkers.delete(name);
            });

            await E(powers).reply(
              msg.number,
              [`Agent "${name}" is now running.`],
              [],
              [],
            );
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error('[lal] Form submission error:', errorMessage);
          try {
            await E(powers).reply(
              msg.number,
              [`Error creating agent: ${errorMessage}`],
              [],
              [],
            );
          } catch {
            // Best-effort reply.
          }
        }
      }
    }
  };

  runManager().catch(error => {
    console.error('[lal] Manager error:', error);
  });

  return makeExo('Lal', LalInterface, {
    /**
     * @param {string} [methodName]
     * @returns {string}
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Lal agent manager. Submit the configuration form to add agents.';
      }
      return `No documentation for method "${methodName}".`;
    },
  });
};
