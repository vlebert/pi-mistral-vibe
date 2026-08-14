/**
 * streamSimple implementation for the mistral-vibe provider.
 *
 * Replicates the wire behavior of the `mistral-vibe` harness MistralBackend
 * (vibe/core/llm/backend/mistral.py) on top of pi's streaming contract:
 *  - raw fetch (no SDK) with the exact vibe headers, including User-Agent and
 *    x-affinity
 *  - reasoning_effort for every thinking model (none/high), temperature forced
 *    to 1.0 whenever reasoning is active
 *  - SSE parsing of Mistral chat-completions chunks (ThinkChunk content,
 *    tool calls, trailing usage-only chunk, cached tokens)
 */
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
} from "@earendil-works/pi-ai";
import {
  buildWireRequest,
  mapThinkingToReasoningEffort,
  parseMistralSse,
  sanitizeSurrogates,
  toMistralMessages,
  transformMessages,
  type PiContentBlock,
} from "./wire.js";
import {
  resolveApiKey,
  type VibeRuntime,
} from "./vibe-config.js";

const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_ERROR_BODY_CHARS = 4000;

type OutputMessage = AssistantMessage & {
  content: Array<{
    type: "text" | "thinking" | "toolCall";
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    partialArgs?: string;
  }>;
  rawStopReason?: string;
  responseId?: string;
};

export function streamMistralVibe(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  runtime: VibeRuntime,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: OutputMessage = createOutput(model);
    try {
      const apiKey =
        resolveApiKey(process.env as Record<string, string | undefined>, runtime.apiKeyEnvVar, runtime.vibeDir) ??
        options?.apiKey;
      if (!apiKey) {
        throw new Error(
          `No API key for provider mistral-vibe: set ${runtime.apiKeyEnvVar} in the environment or in ${runtime.vibeDir}/.env (as mistral-vibe does)`,
        );
      }

      const reasoningLevel =
        options?.reasoning ?? (model.reasoning ? "high" : "off");
      const reasoningEffort = mapThinkingToReasoningEffort(reasoningLevel);
      // vibe forces temperature=1.0 whenever reasoning is active.
      const temperature =
        reasoningEffort !== undefined
          ? 1.0
          : (options?.temperature ?? 1.0);

      const supportsImages = model.input.includes("image");

      const transformed = transformMessages(context.messages, {
        provider: model.provider,
        api: model.api,
        modelId: model.id,
        supportsImages,
        normalizeToolCallId: deriveMistralToolCallId,
      });
      const messages = toMistralMessages(
        transformed,
        supportsImages,
        context.systemPrompt,
      );

      const maxTokens = Math.min(
        options?.maxTokens ?? model.maxTokens,
        model.maxTokens,
      );

      let payload = buildWireRequest({
        baseUrl: model.baseUrl || runtime.baseUrl,
        apiKey,
        userAgent: runtime.userAgent,
        sessionId: options?.sessionId,
        model: model.id,
        messages,
        temperature,
        maxTokens,
        tools: context.tools,
        toolChoice: options?.toolChoice as
          | string
          | { name: string }
          | undefined,
        reasoningEffort,
      });

      const nextPayload = await (options as any)?.onPayload?.(payload, model);
      if (nextPayload !== undefined) {
        payload = nextPayload;
      }

      const fetcher = options?.fetch ?? fetch;
      const response = await fetcher(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: JSON.stringify(payload.body),
        signal: options?.signal,
      });

      await (options as any)?.onResponse?.(response, model);

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(
          `Mistral Vibe API error (${response.status}): ${truncate(bodyText, MAX_ERROR_BODY_CHARS)}`,
        );
      }
      if (!response.body) {
        throw new Error("Mistral Vibe API returned an empty body");
      }

      stream.push({ type: "start", partial: output });

      for await (const chunk of parseMistralSse(response.body)) {
        handleChunk(model, output, stream, chunk);
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "pending") {
        throw new Error("Mistral Vibe stream ended without a finish reason");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        // partialArgs is a streaming scratch buffer; never persist it.
        delete block.partialArgs;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function createOutput(model: Model<any>): OutputMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function deriveMistralToolCallId(id: string, attempt = 0): string {
  const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
  if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) {
    return normalized;
  }
  const seedBase = normalized || id;
  const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
  return fnv1a(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function getCachedPromptTokens(
  usage: Record<string, unknown>,
  promptTokens: number,
): number {
  const details = (usage.prompt_tokens_details ??
    usage.promptTokensDetails ??
    {}) as Record<string, unknown>;
  const raw =
    details.cached_tokens ??
    details.cachedTokens ??
    usage.num_cached_tokens ??
    usage.numCachedTokens ??
    0;
  const cached = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return Math.min(promptTokens, Math.max(0, cached));
}

function handleChunk(
  model: Model<any>,
  output: OutputMessage,
  stream: AssistantMessageEventStream,
  chunk: Record<string, unknown>,
): void {
  output.responseId ||= typeof chunk.id === "string" ? chunk.id : undefined;

  const usage = chunk.usage as Record<string, unknown> | undefined;
  if (usage) {
    const promptTokens =
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const cachedPromptTokens = getCachedPromptTokens(usage, promptTokens);
    output.usage.input = Math.max(0, promptTokens - cachedPromptTokens);
    output.usage.output =
      typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
    output.usage.cacheRead = cachedPromptTokens;
    output.usage.cacheWrite = 0;
    output.usage.totalTokens =
      (typeof usage.total_tokens === "number" ? usage.total_tokens : 0) ||
      output.usage.input +
        output.usage.output +
        output.usage.cacheRead +
        output.usage.cacheWrite;
    calculateCost(model, output.usage);
  }

  const choices = chunk.choices as
    | Array<Record<string, unknown>>
    | undefined;
  const choice = choices?.[0];
  if (!choice) return;

  if (choice.finish_reason) {
    const reason = String(choice.finish_reason);
    output.rawStopReason = reason;
    const mapped = mapStopReason(reason);
    output.stopReason = mapped.stopReason;
    if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
  }

  const delta = choice.delta as Record<string, unknown> | undefined;
  if (delta?.content !== null && delta?.content !== undefined) {
    const contentItems = Array.isArray(delta.content)
      ? (delta.content as unknown[])
      : [delta.content];
    for (const item of contentItems) {
      if (typeof item === "string") {
        pushTextDelta(output, stream, sanitizeSurrogates(item));
        continue;
      }
      const contentItem = item as { type?: string; text?: string; thinking?: Array<{ text?: string }> };
      if (contentItem.type === "thinking") {
        const thinkingDelta = sanitizeSurrogates(
          (contentItem.thinking ?? [])
            .map((part) => (part.text ? part.text : ""))
            .filter((text) => text.length > 0)
            .join(""),
        );
        if (!thinkingDelta) continue;
        pushThinkingDelta(output, stream, thinkingDelta);
        continue;
      }
      if (contentItem.type === "text") {
        pushTextDelta(output, stream, sanitizeSurrogates(contentItem.text ?? ""));
      }
    }
  }

  const toolCalls = (delta?.tool_calls ?? []) as Array<Record<string, unknown>>;
  for (const toolCall of toolCalls) {
    finishCurrentBlock(output, stream);
    const rawId =
      typeof toolCall.id === "string" && toolCall.id !== "null"
        ? toolCall.id
        : deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`);
    const index = typeof toolCall.index === "number" ? toolCall.index : 0;
    const key = `${rawId}:${index}`;
    const functionPart = (toolCall.function ?? {}) as Record<string, unknown>;

    let block = output.content.find(
      (b) => b.type === "toolCall" && b.id === rawId && b.partialArgs !== undefined,
    );
    if (!block) {
      block = {
        type: "toolCall",
        id: rawId,
        name: typeof functionPart.name === "string" ? functionPart.name : "",
        arguments: {},
        partialArgs: "",
      };
      output.content.push(block);
      stream.push({
        type: "toolcall_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    }

    const argsDelta =
      typeof functionPart.arguments === "string"
        ? functionPart.arguments
        : JSON.stringify(functionPart.arguments ?? {});
    block.partialArgs = (block.partialArgs ?? "") + argsDelta;
    block.arguments = parseStreamingJson(block.partialArgs);
    stream.push({
      type: "toolcall_delta",
      contentIndex: output.content.indexOf(block),
      delta: argsDelta,
      partial: output,
    });
  }
}

function pushTextDelta(
  output: OutputMessage,
  stream: AssistantMessageEventStream,
  delta: string,
): void {
  const blocks = output.content;
  const current = blocks[blocks.length - 1];
  if (!current || current.type !== "text") {
    finishCurrentBlock(output, stream);
    blocks.push({ type: "text", text: "" });
    stream.push({
      type: "text_start",
      contentIndex: blocks.length - 1,
      partial: output,
    });
  }
  const textBlock = blocks[blocks.length - 1];
  if (textBlock.type === "text") {
    textBlock.text = (textBlock.text ?? "") + delta;
    stream.push({
      type: "text_delta",
      contentIndex: blocks.length - 1,
      delta,
      partial: output,
    });
  }
}

function pushThinkingDelta(
  output: OutputMessage,
  stream: AssistantMessageEventStream,
  delta: string,
): void {
  const blocks = output.content;
  const current = blocks[blocks.length - 1];
  if (!current || current.type !== "thinking") {
    finishCurrentBlock(output, stream);
    blocks.push({ type: "thinking", thinking: "" });
    stream.push({
      type: "thinking_start",
      contentIndex: blocks.length - 1,
      partial: output,
    });
  }
  const thinkingBlock = blocks[blocks.length - 1];
  if (thinkingBlock.type === "thinking") {
    thinkingBlock.thinking = (thinkingBlock.thinking ?? "") + delta;
    stream.push({
      type: "thinking_delta",
      contentIndex: blocks.length - 1,
      delta,
      partial: output,
    });
  }
}

function finishCurrentBlock(
  output: OutputMessage,
  stream: AssistantMessageEventStream,
): void {
  const blocks = output.content;
  const block = blocks[blocks.length - 1];
  if (!block) return;
  const contentIndex = blocks.length - 1;
  if (block.type === "text") {
    stream.push({
      type: "text_end",
      contentIndex,
      content: block.text ?? "",
      partial: output,
    });
    return;
  }
  if (block.type === "thinking") {
    stream.push({
      type: "thinking_end",
      contentIndex,
      content: block.thinking ?? "",
      partial: output,
    });
  }
}

function mapStopReason(reason: string): {
  stopReason: string;
  errorMessage?: string;
} {
  switch (reason) {
    case "stop":
      return { stopReason: "stop" };
    case "length":
    case "model_length":
      return { stopReason: "length" };
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "error":
      return { stopReason: "error", errorMessage: "Provider stopped with: error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider stopped with: ${reason}`,
      };
  }
}
