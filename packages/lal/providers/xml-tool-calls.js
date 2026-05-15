// @ts-check

/** @import { ChatMessage, ToolCall } from '../agent.types.js' */

/**
 * Extract tool calls embedded in assistant content.
 *
 * Some OpenAI-compatible local models emit tool calls as XML-tagged JSON in
 * text content instead of structured tool_calls. Keep that provider quirk out
 * of the agent loop.
 *
 * @param {string} content
 * @returns {{ toolCalls: ToolCall[], cleanedContent: string }}
 */
export const extractToolCallsFromContent = content => {
  /** @type {ToolCall[]} */
  const toolCalls = [];
  const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const matches = content.matchAll(toolCallRe);
  let index = 0;
  for (const match of matches) {
    const block = match[1].trim();
    let name = '';
    /** @type {string | object} */
    let args = '{}';
    try {
      const parsed = JSON.parse(block);
      if (parsed && typeof parsed === 'object') {
        name = /** @type {{ name?: string }} */ (parsed).name || '';
        const parsedArgs = /** @type {{ arguments?: string | object }} */ (
          parsed
        ).arguments;
        if (parsedArgs !== undefined) {
          args =
            typeof parsedArgs === 'string'
              ? parsedArgs
              : JSON.stringify(parsedArgs);
        }
      }
    } catch {
      const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/);
      const argsMatch = block.match(/"arguments"\s*:\s*({[\s\S]*})/);
      name = nameMatch ? nameMatch[1] : '';
      args = argsMatch ? argsMatch[1].trim() : '{}';
    }
    if (name) {
      toolCalls.push({
        id: `tool_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name,
          arguments: args,
        },
      });
      index += 1;
    }
  }

  let cleanedContent = content.replace(toolCallRe, '');
  cleanedContent = cleanedContent.replace(/<think>[\s\S]*?<\/think>/g, '');
  cleanedContent = cleanedContent.trim();

  return { toolCalls, cleanedContent };
};

/**
 * Normalize XML-tagged tool calls to the common structured message shape.
 *
 * @template {ChatMessage} T
 * @param {T} message
 * @returns {T}
 */
export const normalizeToolCallsFromContent = message => {
  if (
    (message.tool_calls && message.tool_calls.length > 0) ||
    !message.content
  ) {
    return message;
  }

  const extracted = extractToolCallsFromContent(message.content);
  if (extracted.toolCalls.length === 0) {
    return message;
  }

  return /** @type {T} */ ({
    ...message,
    content: extracted.cleanedContent,
    tool_calls: extracted.toolCalls,
  });
};
