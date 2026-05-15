import type { JSONSchema7 } from 'json-schema';
import type {
  Name,
  EndoGuest,
  NamePath,
  NameOrPath,
  StampedMessage,
} from '@endo/daemon';

export type { NameOrPath };

/**
 * A schema node in a tool's `parameters` JSON Schema tree.
 *
 * Tool `parameters` are vendor-specified JSON Schema (OpenAI, Anthropic,
 * Gemini, Ollama all forward this shape to their respective APIs — see
 * the provider modules). Aliasing the canonical `JSONSchema7` keeps the
 * typedef honest: the runtime contract is whatever JSON Schema permits.
 */
export type ToolParameterProperty = JSONSchema7;

export type ToolParameters = JSONSchema7 & {
  type: 'object';
  properties: Record<string, JSONSchema7>;
  required: string[];
};

export type ToolFunction = {
  name: string;
  description: string;
  parameters: ToolParameters;
};

export type Tool = {
  type: 'function';
  function: ToolFunction;
};

export type ToolCall = {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolResult = {
  role: 'tool';
  content: string;
  tool_call_id?: string;
};

export type ToolExecutionMode = 'parallel' | 'sequential';

export type ToolCallArgs = {
  methodName?: string;
  petNamePath?: NamePath;
  petNameOrPath?: NameOrPath;
  fromPath?: NamePath;
  toPath?: NamePath;
  messageNumber?: bigint | number;
  reason?: string;
  edgeName?: NameOrPath;
  petName?: NameOrPath;
  recipientName?: NameOrPath;
  description?: string;
  responseName?: NameOrPath;
  strings?: string[];
  edgeNames?: Name[];
  petNames?: NameOrPath[];
  workerName?: string;
  source?: string;
  codeNames?: string[];
  resultName?: NameOrPath;
  /** `list` tool — string or path. */
  name?: NameOrPath;
  /** `readText`/`writeText` tools — file name within the capability. */
  fileName?: string;
  /** `writeText` tool — text content to write. */
  content?: string;
  /** `define` tool — named capability slots for the host to fill. */
  slots?: Record<string, { label: string }>;
};

export type InboxMessage = StampedMessage;
export type GuestPowers = EndoGuest;

export type ToolContext = {
  powers: any;
  leafNode?: TranscriptNode;
  assembleTranscript?: (leafMessageId: string) => Promise<ChatMessage[]>;
  computeDepth?: (messages: ChatMessage[]) => number;
};

export type ToolExecute = (
  args: ToolCallArgs,
  context: ToolContext,
) => Promise<unknown>;

export type ToolEntry = {
  schema: Tool;
  executionMode: ToolExecutionMode;
  execute: ToolExecute;
};

export type PendingProposal = {
  proposalId: number;
  source: string;
  codeNames: string[];
  edgeNames: Name[];
  workerName?: string;
  promise: Promise<unknown>;
};

export type ProposalNotification = {
  status: 'granted' | 'rejected';
  proposalId: number;
  source: string;
  result?: unknown;
  error?: string;
};

/** Configuration for a worker spawned from a form submission */
export type WorkerConfig = {
  name: string;
  host: string;
  model: string;
  authToken: string;
};

/** Context object for cancellation support */
export type LalContext = {
  whenCancelled?: () => Promise<void>;
  cancelled?: Promise<void>;
};

/**
 * A single node in a linked-chain transcript.
 * Each node stores only the messages appended at that step,
 * plus a pointer to the parent node. The full transcript is
 * assembled by walking the chain from root to leaf.
 */
export type TranscriptNode = {
  /** The messageId this node corresponds to. */
  messageId: string;
  /** The messageId of the parent node, or null for root nodes. */
  parentMessageId: string | null;
  /** LLM messages appended at this step only (not the full chain). */
  messages: ChatMessage[];
  /** Inbox message number of the most recent inbound message at this node. */
  lastInboxNumber?: bigint;
};
