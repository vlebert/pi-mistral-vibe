/**
 * Pure wire-format helpers for the mistral-vibe provider.
 *
 * This module is deliberately dependency-free (no pi-ai imports) so the
 * request/header contract can be reasoned about and unit-tested in isolation.
 * The contract mirrors what the `mistral-vibe` harness (vibe/core/llm/backend/
 * mistral.py + the official `mistralai` Python SDK 2.6.0) sends to
 * https://api.mistral.ai — including the User-Agent and x-affinity headers,
 * reasoning_effort mapping, temperature forcing and the absence of
 * prompt_cache_key in the body.
 */

export const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
/** Fallback when the installed vibe version cannot be read. */
export const DEFAULT_VERSION = "2.24.1";

export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** vibe utils/http.py get_user_agent(backend="mistral"). */
export function buildUserAgent(version: string): string {
  return `mistral-client-python/Mistral-Vibe/${version}`;
}

export type ReasoningEffort = "none" | "high";

/**
 * vibe mapping (vibe/core/llm/backend/mistral.py _THINKING_TO_REASONING_EFFORT):
 * low -> "none", medium/high/max -> "high". "off" (and anything else) is
 * omitted from the request, exactly like vibe (reasoning_effort=None).
 * pi adds a "minimal" level; vibe has no equivalent, so it maps to "none".
 */
export function mapThinkingToReasoningEffort(
  level: string | undefined,
): ReasoningEffort | undefined {
  switch (level) {
    case "minimal":
    case "low":
      return "none";
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return undefined;
  }
}

/** Replace lone surrogates (which crash TUI renderers) with U+FFFD. */
export function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

/**
 * Minimal .env parser (KEY=VALUE lines, optional `export ` prefix, # comments,
 * quoted values). Used to read ~/.vibe/.env, where vibe persists its API key.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

export interface TomlDoc {
  /** [section] tables */
  tables: Map<string, Record<string, unknown>>;
  /** [[section]] array-of-tables */
  arrays: Map<string, Array<Record<string, unknown>>>;
}

/**
 * Minimal TOML-subset parser covering the parts of ~/.vibe/config.toml this
 * provider needs: [table] / [[array-table]] headers and
 * `key = string | number | boolean | inline-array`. Everything else is
 * ignored. Zero dependencies.
 */
export function parseTomlSubset(text: string): TomlDoc {
  const tables = new Map<string, Record<string, unknown>>();
  const arrays = new Map<string, Array<Record<string, unknown>>>();
  const getTable = (name: string) => {
    let t = tables.get(name);
    if (!t) {
      t = {};
      tables.set(name, t);
    }
    return t;
  };
  const getArray = (name: string) => {
    let a = arrays.get(name);
    if (!a) {
      a = [];
      arrays.set(name, a);
    }
    return a;
  };

  let current: {
    kind: "table" | "array";
    name: string;
    obj: Record<string, unknown>;
  } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const arrayHeader = line.match(/^\[\[([^\]]+)\]\]\s*$/);
    if (arrayHeader) {
      const name = arrayHeader[1].trim();
      const obj: Record<string, unknown> = {};
      getArray(name).push(obj);
      current = { kind: "array", name, obj };
      continue;
    }
    const tableHeader = line.match(/^\[([^\]]+)\]\s*$/);
    if (tableHeader) {
      const name = tableHeader[1].trim();
      current = { kind: "table", name, obj: getTable(name) };
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_\-."]+)\s*=\s*(.+)$/);
    if (kv && current) {
      current.obj[kv[1].trim()] = parseTomlValue(kv[2]);
    }
  }
  return { tables, arrays };
}

function parseTomlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Strip trailing comments for non-quoted values.
  const value = trimmed.split(/\s+#/)[0]?.trim() ?? trimmed;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[")) {
    const inner = value.slice(1, value.lastIndexOf("]"));
    return inner
      .split(",")
      .map((part) => parseTomlValue(part.trim()))
      .filter((part) => part !== "");
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/* ------------------------------------------------------------------ */
/* Message transformation (pi format -> Mistral chat format)           */
/* ------------------------------------------------------------------ */

export interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  redacted?: boolean;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  data?: string;
  mimeType?: string;
}

export interface PiMessageLike {
  role: string;
  content: PiContentBlock[] | string | null;
  provider?: string;
  api?: string;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  timestamp?: number;
}

export interface MistralChatMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  name?: string;
  toolCalls?: unknown[];
}

const NON_VISION_USER_IMAGE_PLACEHOLDER =
  "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
  "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(
  content: PiContentBlock[],
  placeholder: string,
): PiContentBlock[] {
  const result: PiContentBlock[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

/**
 * Port of pi's transformMessages (dist/api/transform-messages.js):
 *  - downgrades unsupported images to placeholders
 *  - keeps thinking blocks for the same model (replay), converts across models
 *  - normalizes tool call IDs (cross-model only, like the built-in provider)
 *  - inserts synthetic tool results for orphaned tool calls
 *  - drops errored/aborted assistant messages
 */
export function transformMessages(
  messages: PiMessageLike[],
  opts: {
    provider: string;
    api: string;
    modelId: string;
    supportsImages: boolean;
    normalizeToolCallId?: (id: string, attempt: number) => string;
  },
): PiMessageLike[] {
  const toolCallIdMap = new Map<string, string>();
  const normalized = messages.map((msg) =>
    msg.content == null ? { ...msg, content: [] } : msg,
  );
  const imageAware = opts.supportsImages
    ? normalized
    : normalized.map((msg) => {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: replaceImagesWithPlaceholder(
              msg.content,
              NON_VISION_USER_IMAGE_PLACEHOLDER,
            ),
          };
        }
        if (msg.role === "toolResult" && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: replaceImagesWithPlaceholder(
              msg.content,
              NON_VISION_TOOL_IMAGE_PLACEHOLDER,
            ),
          };
        }
        return msg;
      });

  const transformed = imageAware.map((msg) => {
    if (msg.role === "user") return msg;
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId ?? "");
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }
    if (msg.role === "assistant") {
      const assistantMsg = msg as PiMessageLike & {
        content: PiContentBlock[];
      };
      const isSameModel =
        assistantMsg.provider === opts.provider &&
        assistantMsg.api === opts.api &&
        assistantMsg.model === opts.modelId;
      const transformedContent: PiContentBlock[] = [];
      for (const block of assistantMsg.content) {
        if (block.type === "thinking") {
          if (block.redacted) {
            if (isSameModel) transformedContent.push(block);
            continue;
          }
          if (isSameModel && block.thinkingSignature) {
            transformedContent.push(block);
            continue;
          }
          if (!block.thinking || block.thinking.trim() === "") continue;
          transformedContent.push(
            isSameModel
              ? block
              : { type: "text", text: block.thinking },
          );
          continue;
        }
        if (block.type === "text") {
          transformedContent.push({ type: "text", text: block.text ?? "" });
          continue;
        }
        if (block.type === "toolCall") {
          let toolCall = { ...block };
          if (!isSameModel && toolCall.thinkingSignature) {
            delete toolCall.thinkingSignature;
          }
          if (!isSameModel && opts.normalizeToolCallId && toolCall.id) {
            const normalizedId = opts.normalizeToolCallId(toolCall.id, 0);
            if (normalizedId !== toolCall.id) {
              toolCallIdMap.set(toolCall.id, normalizedId);
              toolCall = { ...toolCall, id: normalizedId };
            }
          }
          transformedContent.push(toolCall);
          continue;
        }
        transformedContent.push(block);
      }
      return { ...assistantMsg, content: transformedContent };
    }
    return msg;
  });

  // Second pass: synthetic tool results for orphaned tool calls.
  const result: PiMessageLike[] = [];
  let pendingToolCalls: PiContentBlock[] = [];
  let existingToolResultIds = new Set<string>();
  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (tc.id && !existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          });
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
  };

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      insertSyntheticToolResults();
      const assistantMsg = msg as PiMessageLike & {
        content: PiContentBlock[];
      };
      if (
        assistantMsg.stopReason === "error" ||
        assistantMsg.stopReason === "aborted"
      ) {
        continue;
      }
      const toolCalls = assistantMsg.content.filter(
        (b) => b.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId ?? "");
      result.push(msg);
    } else if (msg.role === "user") {
      insertSyntheticToolResults();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }
  insertSyntheticToolResults();
  return result;
}

/**
 * Port of pi's toChatMessages (dist/api/mistral-conversations.js): pi message
 * shapes -> Mistral chat messages (system/user/assistant/tool), including
 * ThinkChunk replay and data-URL images.
 */
export function toMistralMessages(
  messages: PiMessageLike[],
  supportsImages: boolean,
  systemPrompt?: string,
): MistralChatMessage[] {
  const result: MistralChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({
          role: "user",
          content: sanitizeSurrogates(msg.content),
        });
        continue;
      }
      const content = msg.content ?? [];
      const hadImages = content.some((item) => item.type === "image");
      const parts = content
        .filter((item) => item.type === "text" || supportsImages)
        .map((item) => {
          if (item.type === "text")
            return { type: "text", text: sanitizeSurrogates(item.text ?? "") };
          return {
            type: "image_url",
            imageUrl: `data:${item.mimeType};base64,${item.data}`,
          };
        });
      if (parts.length > 0) {
        result.push({ role: "user", content: parts });
        continue;
      }
      if (hadImages && !supportsImages) {
        result.push({
          role: "user",
          content: "(image omitted: model does not support images)",
        });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const contentParts: unknown[] = [];
      const toolCalls: unknown[] = [];
      for (const block of (msg.content ?? []) as PiContentBlock[]) {
        if (block.type === "text") {
          if ((block.text ?? "").trim().length > 0) {
            contentParts.push({
              type: "text",
              text: sanitizeSurrogates(block.text ?? ""),
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          if ((block.thinking ?? "").trim().length > 0) {
            contentParts.push({
              type: "thinking",
              thinking: [
                { type: "text", text: sanitizeSurrogates(block.thinking ?? "") },
              ],
            });
          }
          continue;
        }
        if (block.type === "toolCall") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.arguments ?? {}),
            },
          });
        }
      }
      const assistantMessage: MistralChatMessage = { role: "assistant" };
      if (contentParts.length > 0) assistantMessage.content = contentParts;
      if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
      if (contentParts.length > 0 || toolCalls.length > 0) {
        result.push(assistantMessage);
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const content = msg.content ?? [];
      const textResult = content
        .filter((part) => part.type === "text")
        .map((part) =>
          part.type === "text" ? sanitizeSurrogates(part.text ?? "") : "",
        )
        .join("\n");
      const hasImages = content.some((part) => part.type === "image");
      const toolText = buildToolResultText(
        textResult,
        hasImages,
        supportsImages,
        msg.isError,
      );
      const toolContent: unknown[] = [{ type: "text", text: toolText }];
      if (supportsImages) {
        for (const part of content) {
          if (part.type !== "image") continue;
          toolContent.push({
            type: "image_url",
            imageUrl: `data:${part.mimeType};base64,${part.data}`,
          });
        }
      }
      result.push({
        role: "tool",
        toolCallId: msg.toolCallId,
        name: msg.toolName,
        content: toolContent,
      });
      continue;
    }
  }
  if (systemPrompt) {
    result.unshift({
      role: "system",
      content: sanitizeSurrogates(systemPrompt),
    });
  }
  return result;
}

function buildToolResultText(
  text: string,
  hasImages: boolean,
  supportsImages: boolean,
  isError?: boolean,
): string {
  const trimmed = text.trim();
  const errorPrefix = isError ? "[tool error] " : "";
  if (trimmed.length > 0) {
    const imageSuffix =
      hasImages && !supportsImages
        ? "\n[tool image omitted: model does not support images]"
        : "";
    return `${errorPrefix}${trimmed}${imageSuffix}`;
  }
  if (hasImages) {
    if (supportsImages) {
      return isError ? "[tool error] (see attached image)" : "(see attached image)";
    }
    return isError
      ? "[tool error] (image omitted: model does not support images)"
      : "(image omitted: model does not support images)";
  }
  return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

export interface BuildWireRequestInput {
  baseUrl: string; // e.g. https://api.mistral.ai/v1 (as in vibe api_base)
  apiKey: string;
  userAgent: string;
  sessionId?: string;
  model: string;
  messages: MistralChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  toolChoice?: string | { name: string };
  reasoningEffort?: ReasoningEffort;
}

/**
 * Assembles the exact HTTP request vibe sends to Mistral:
 *  - URL: origin from api_base (version suffix stripped, like vibe's
 *    get_server_url_from_api_base) + /v1/chat/completions (the SDK path)
 *  - headers: authorization Bearer, content-type application/json,
 *    accept text/event-stream, user-agent mistral-client-python/Mistral-Vibe/<v>,
 *    x-affinity: <sessionId> (always, like vibe's _get_extra_headers)
 *  - body: stream true, temperature forced to 1.0 when reasoning_effort is set,
 *    NO prompt_cache_key (vibe does not send it)
 */
export function buildWireRequest(input: BuildWireRequestInput): WireRequest {
  const origin = input.baseUrl.replace(/(\/v\d+).*$/, "");
  const url = `${origin}/v1/chat/completions`;

  const headers: Record<string, string> = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": input.userAgent,
  };
  if (input.sessionId) headers["x-affinity"] = input.sessionId;

  const body: Record<string, unknown> = {
    model: input.model,
    stream: true,
    messages: input.messages,
  };
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
  if (input.tools !== undefined && input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    }));
  }
  if (input.toolChoice) body.tool_choice = mapToolChoice(input.toolChoice);
  if (input.reasoningEffort) body.reasoning_effort = input.reasoningEffort;

  return { url, headers, body };
}

export function mapToolChoice(
  choice: string | { name: string },
): unknown {
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
      return choice;
    }
    return { type: "function", function: { name: choice } };
  }
  return { type: "function", function: { name: choice.name } };
}

/* ------------------------------------------------------------------ */
/* SSE parsing (OpenAI-format chat completions chunks)                 */
/* ------------------------------------------------------------------ */

/**
 * Parses the Mistral SSE stream (fetch Response.body). Yields each parsed
 * chunk object (OpenAI chat-completions chunk shape). Ends when the stream
 * finishes or on `data: [DONE]`.
 */
export async function* parseMistralSse(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (!data) continue;
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Skip malformed SSE frames.
          }
        }
      }
    }
    // Flush a trailing event without a final blank line.
    if (buffer.trim().length > 0) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]" || !data) continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
