/**
 * streamSimple implementation for the mistral-vibe provider.
 *
 * Replicates the wire behavior of the `mistral-vibe` harness MistralBackend
 * (vibe 2.26.0, vibe/core/llm/backend/mistral.py) on top of pi's streaming
 * contract:
 *  - raw fetch (no SDK) with the exact vibe headers, including User-Agent and
 *    x-affinity
 *  - reasoning_effort for every thinking model (none/high), temperature sent
 *    as-is from the vibe config (vibe 2.26 no longer forces 1.0)
 *  - telemetry metadata block + explicit null max_tokens/tools/reasoning_effort
 *    (SDK OptionalNullable serialization)
 *  - SSE parsing of Mistral chat-completions chunks (ThinkChunk content,
 *    tool calls, trailing usage-only chunk, cached tokens)
 */
import { appendFileSync } from "node:fs";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  parseStreamingJson,
} from "@earendil-works/pi-ai";
import {
  buildVibeMetadata,
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

/**
 * Opt-in debug logging: MISTRAL_VIBE_DEBUG=1 appends one JSON line per
 * request to $MISTRAL_VIBE_DEBUG_LOG (default /tmp/mistral-vibe-debug.log)
 * with the wire request (auth excluded), first thinking delta, usage/cost and
 * stop reason. Lets you verify reasoning_effort, cache hits and session
 * pricing without touching the code.
 */
const DEBUG_ENABLED = process.env.MISTRAL_VIBE_DEBUG === "1";
const DEBUG_LOG_PATH =
  process.env.MISTRAL_VIBE_DEBUG_LOG ?? "/tmp/mistral-vibe-debug.log";
function debugLog(entry: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  try {
    appendFileSync(
      DEBUG_LOG_PATH,
      `${JSON.stringify({ ts: Date.now(), ...entry })}\n`,
    );
  } catch {
    // Logging must never break a request.
  }
}

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
  debugLoggedThinking?: boolean;
  toolCallBlocksByIndex?: Map<number, (typeof content)[number]>;
};

export function streamMistralVibe(
  model: Model<any>,
  context: TranscriptContext,
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

      // pi only sets options.reasoning when the effective thinking level is
      // not "off" (compaction.js: `if (model.reasoning && thinkingLevel &&
      // thinkingLevel !== "off") options.reasoning = thinkingLevel`). So
      // undefined means the user chose off — never fall back to a default.
      const reasoningLevel = options?.reasoning ?? "off";
      const reasoningEffort = mapThinkingToReasoningEffort(reasoningLevel);
      // vibe 2.26.0 sends the model's config temperature as-is (no more
      // forcing to 1.0 when reasoning is active). pi's explicit
      // options.temperature wins when set, then the vibe config entry, then
      // vibe's ModelConfig default (0.2).
      const configTemperature = [...runtime.models, ...runtime.defaultModels]
        .find((m) => m.name === model.id)?.temperature;
      const temperature = options?.temperature ?? configTemperature ?? 0.2;

      const supportsImages = model.input.includes("image");

      // pi 0.86+ passes a normalized TranscriptContext: the system prompt and
      // tool declarations live in the transcript's system messages, not in
      // context.systemPrompt / context.tools. Mistral chat completions carry
      // the prompt in a leading system message and don't accept
      // mid-conversation system messages, so collapse the transcript first,
      // then resolve the current prompt and tool set from the replayed system
      // message. (Without this, pi >= 0.86 sends no system prompt and no tools.)
      const transcript = collapseSystemMessages(context);
      const systemPrompt = getCurrentSystemPrompt(transcript.messages);
      const tools = getCurrentTools(transcript.messages);

      const transformed = transformMessages(transcript.messages, {
        provider: model.provider,
        api: model.api,
        modelId: model.id,
        supportsImages,
        normalizeToolCallId: deriveMistralToolCallId,
      });
      const messages = toMistralMessages(
        transformed,
        supportsImages,
        systemPrompt,
      );

      const maxTokens = Math.min(
        options?.maxTokens ?? model.maxTokens,
        model.maxTokens,
      );

      // vibe 2.26.0 always sends a telemetry metadata block in the body
      // (build_request_metadata; CLI launch context), with the session id
      // also used for x-affinity.
      const metadata = buildVibeMetadata({
        version: runtime.version,
        sessionId: options?.sessionId,
      });

      let payload = buildWireRequest({
        baseUrl: model.baseUrl || runtime.baseUrl,
        apiKey,
        userAgent: runtime.userAgent,
        sessionId: options?.sessionId,
        model: model.id,
        messages,
        temperature,
        maxTokens,
        metadata,
        tools,
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

      debugLog({
        event: "request",
        model: model.id,
        url: payload.url,
        headers: { ...payload.headers, authorization: undefined },
        reasoning_effort: payload.body.reasoning_effort,
        options_reasoning: options?.reasoning ?? null,
        reasoningLevel,
        temperature: payload.body.temperature,
        max_tokens: payload.body.max_tokens,
        metadata_call_type: (payload.body.metadata as Record<string, unknown>)?.call_type ?? null,
        x_affinity: payload.headers["x-affinity"] ?? null,
        prompt_cache_key: payload.body.prompt_cache_key ?? null,
        messageCount: (payload.body.messages as unknown[])?.length,
        toolCount: (payload.body.tools as unknown[] | undefined)?.length ?? 0,
        systemPromptChars: systemPrompt.length,
      });

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

      // Finalize streamed blocks: close the last text/thinking block and emit
      // toolcall_end for every accumulated tool call.
      finishCurrentBlock(output, stream);
      if (output.toolCallBlocksByIndex) {
        for (const block of output.toolCallBlocksByIndex.values()) {
          if (block.type !== "toolCall") continue;
          // Strip the scratch buffer so replay only carries parsed arguments.
          delete block.partialArgs;
          stream.push({
            type: "toolcall_end",
            contentIndex: output.content.indexOf(block),
            toolCall: block,
            partial: output,
          });
        }
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

      debugLog({
        event: "done",
        model: model.id,
        stopReason: output.stopReason,
        usage: output.usage,
        cost: output.usage.cost,
        responseId: output.responseId,
        contentTypes: output.content.map((b) => b.type),
      });

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
      debugLog({
        event: "error",
        model: model.id,
        message: output.errorMessage,
      });
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
        if (!output.debugLoggedThinking) {
          output.debugLoggedThinking = true;
          debugLog({
            event: "thinking_delta",
            model: output.model,
            preview: thinkingDelta.slice(0, 200),
            deltaLength: thinkingDelta.length,
          });
        }
        pushThinkingDelta(output, stream, thinkingDelta);
        continue;
      }
      if (contentItem.type === "text") {
        pushTextDelta(output, stream, sanitizeSurrogates(contentItem.text ?? ""));
      }
    }
  }

  const toolCalls = (delta?.tool_calls ?? []) as Array<Record<string, unknown>>;
  let toolBlocksByIndex = output.toolCallBlocksByIndex;
  if (!toolBlocksByIndex) {
    toolBlocksByIndex = new Map<number, (typeof output.content)[number]>();
    output.toolCallBlocksByIndex = toolBlocksByIndex;
  }
  for (const toolCall of toolCalls) {
    finishCurrentBlock(output, stream);
    // Mistral streams the tool-call id on some chunks only; accumulate by
    // index and adopt the real id/name whenever they arrive, instead of
    // creating a phantom block for every id-less chunk.
    const index =
      typeof toolCall.index === "number" ? toolCall.index : toolBlocksByIndex.size;
    const chunkId =
      typeof toolCall.id === "string" && toolCall.id !== "null"
        ? toolCall.id
        : undefined;
    const functionPart = (toolCall.function ?? {}) as Record<string, unknown>;
    const chunkName =
      typeof functionPart.name === "string" ? functionPart.name : undefined;

    let block = toolBlocksByIndex.get(index);
    if (!block) {
      block = {
        type: "toolCall",
        id: chunkId ?? deriveMistralToolCallId(`toolcall:${index}`),
        name: chunkName ?? "",
        arguments: {},
        partialArgs: "",
      };
      output.content.push(block);
      toolBlocksByIndex.set(index, block);
      stream.push({
        type: "toolcall_start",
        contentIndex: output.content.length - 1,
        partial: output,
      });
    } else {
      if (chunkId && block.id !== chunkId) block.id = chunkId;
      if (chunkName && !block.name) block.name = chunkName;
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
