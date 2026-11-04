/**
 * Pure wire-format helpers for the mistral-vibe provider.
 *
 * This module is deliberately dependency-free (no pi-ai imports) so the
 * request/header contract can be reasoned about and unit-tested in isolation.
 * The contract mirrors what the `mistral-vibe` harness 3.1.0 sends to
 * https://api.mistral.ai via the official `mistralai` Python SDK 3.5.0:
 *  - User-Agent is the vibe CLI UA (`mistral-client-python/Mistral-Vibe/<v>`)
 *    — vibe 3.1.0 injects it into every provider request via
 *    `extra_headers=with_user_agent(...)` → `request_headers()` → the SDK's
 *    `http_headers`, which override the SDK default UA (basesdk.py applies
 *    per-request http_headers last)
 *  - x-affinity header carries the session affinity id (request_headers())
 *  - reasoning_effort goes out as the level written (off→none, low→low,
 *    medium→medium, high→high, xhigh→xhigh, max→max); "off" is sent as
 *    "none" only to a model whose reasoning levels are curated (known_models),
 *    otherwise the field is omitted
 *  - telemetry `metadata` body block
 *  - unset fields (max_tokens / tools / reasoning_effort) are OMITTED, not
 *    sent as explicit null (the SDK omits UNSET fields; vibe 3.x only passes
 *    kwargs that have a value)
 *  - parallel_tool_calls: true is sent when tools are present
 *  - no prompt_cache_key in the body
 */

import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";

export const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
/** Fallback when the installed vibe version cannot be read. */
export const DEFAULT_VERSION = "3.1.0";

export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * The User-Agent the `mistralai` Python SDK 3.5.0 sends by default (generated
 * by Speakeasy). Reference only: since vibe 3.1.0, agent-turn requests carry
 * the vibe CLI UA instead (see buildUserAgent) because vibe injects it through
 * `http_headers`, which override this SDK default. The value is a constant of
 * the SDK version, independent of the vibe version.
 */
export const MISTRAL_SDK_USER_AGENT =
  "speakeasy-sdk/python 3.5.0 2.935.1 1.0.0 mistralai";

/**
 * vibe utils/http.py get_user_agent(backend="mistral") — THE User-Agent of
 * agent-turn requests since vibe 3.1.0: the host builds the runtime config with
 * `extra_headers=with_user_agent(provider.extra_headers, "mistral")`
 * (vibe/app_server/_runtime.py), the adapter forwards it as the SDK's
 * `http_headers`, and Speakeasy applies per-request headers last, overriding
 * the SDK default UA. Same value on utility completions and telemetry.
 */
export function buildUserAgent(version: string): string {
  return `mistral-client-python/Mistral-Vibe/${version}`;
}

export type TerminalEmulator =
  | "vscode"
  | "vscode_insiders"
  | "cursor"
  | "jetbrains"
  | "apple_terminal"
  | "iterm2"
  | "wezterm"
  | "ghostty"
  | "alacritty"
  | "kitty"
  | "hyper"
  | "windows_terminal"
  | "unknown";

/**
 * Best-effort port of vibe's Rust terminal_detect (vibe-rs). Falls back to
 * "unknown" like vibe's TerminalEmulator.UNKNOWN, which IS serialized in the
 * metadata block (captured on vibe 3.1.0 with an empty environment).
 */
export function detectTerminalEmulator(
  env: Record<string, string | undefined>,
): TerminalEmulator {
  if (env.WT_SESSION || env.WT_PROFILE_ID) return "windows_terminal";
  if (env.WEZTERM_PANE) return "wezterm";
  if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.ALACRITTY_SOCKET || env.ALACRITTY_LOG) return "alacritty";
  if (env.TERMINAL_EMULATOR === "Apple_Terminal") return "apple_terminal";
  switch (env.TERM_PROGRAM) {
    case "vscode":
      return (env.TERM_PROGRAM_VERSION ?? "").toLowerCase().includes("insider")
        ? "vscode_insiders"
        : "vscode";
    case "iTerm.app":
    case "iterm2":
      return "iterm2";
    case "WezTerm":
      return "wezterm";
    case "Hyper":
      return "hyper";
    case "Cursor":
      return "cursor";
    case "ghostty":
      return "ghostty";
    case "alacritty":
      return "alacritty";
    case "kitty":
      return "kitty";
    case "JetBrains-JediTerm":
    case "jetbrains":
      return "jetbrains";
    case "Apple_Terminal":
      return "apple_terminal";
    default:
      return "unknown";
  }
}

export interface VibeMetadataInput {
  /** Installed vibe version (e.g. "3.1.0"). */
  version: string;
  /** Session id (also sent as x-affinity). */
  sessionId?: string;
  /** vibe call_type: "main_call" for agent turns, "secondary_call" for
   *  utility completions (titles, compaction…). */
  callType?: "main_call" | "secondary_call";
  /** Terminal emulator (vibe TerminalEmulator); "unknown" when undetected,
   *  which vibe also serializes. */
  terminalEmulator?: TerminalEmulator;
}

/**
 * Whether the telemetry metadata block should be sent. Wire parity says yes:
 * vibe sends it unconditionally (even with `enable_telemetry = false`, which
 * only gates the separate telemetry-events channel). But the block carries
 * fabricated client identity fields (agent_entrypoint "cli",
 * client_name "vibe_cli") when pi is not the vibe CLI, so it can be turned
 * off in the extension's config.local.json (`sendTelemetryMetadata: false`,
 * re-read on /reload). Precedence: MISTRAL_VIBE_METADATA env var ("0"/"false"/
 * "off"/"no" to disable, "1"/"true"/"on"/"yes" to force-enable) >
 * config.local.json > default true. Turning it off is a documented, deliberate
 * wire divergence: the request then lacks a field every vibe request carries.
 */
export function vibeMetadataEnabled(
  env: Record<string, string | undefined>,
  configValue?: boolean,
): boolean {
  const raw = env.MISTRAL_VIBE_METADATA?.trim().toLowerCase();
  if (raw !== undefined && raw !== "") {
    return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
  }
  return configValue ?? true;
}

/**
 * The telemetry `metadata` block vibe 3.1.0 puts in the chat-completions
 * body (core/telemetry/build_metadata.py build_request_metadata +
 * TelemetryRequestMetadata, CLI launch context: agent_entrypoint "cli",
 * client_name "vibe_cli", call_source "vibe_code", host_kind "local").
 * vibe 3.1.0 also adds `message_id` when a current user message exists;
 * pi has no equivalent, so it is omitted. None-valued fields are omitted,
 * mirroring vibe's `model_dump(exclude_none=True)`.
 */
export function buildVibeMetadata(input: VibeMetadataInput): Record<string, unknown> {
  const osId = platform() === "win32" ? "windows" : platform();
  // vibe uses platform.machine().lower(): x86_64, aarch64 (Linux), arm64 (macOS).
  const archId =
    arch() === "x64"
      ? "x86_64"
      : arch() === "arm64" && platform() === "linux"
        ? "aarch64"
        : arch();
  const metadata: Record<string, unknown> = {
    os: osId,
    arch: archId,
    version: input.version,
    call_type: input.callType ?? "main_call",
    call_source: "vibe_code",
    host_kind: "local",
    agent_entrypoint: "cli",
    agent_version: input.version,
    client_name: "vibe_cli",
    client_version: input.version,
  };
  const osVersion = platformVersion();
  if (osVersion) metadata.os_version = osVersion;
  if (input.sessionId) metadata.session_id = input.sessionId;
  metadata.terminal_emulator = input.terminalEmulator ?? "unknown";
  return metadata;
}

/**
 * vibe get_platform_version(): VERSION_ID (or VERSION) from /etc/os-release on
 * Linux, platform version elsewhere. Node has no portable macOS product
 * version, so release() (the kernel release) is the best-effort fallback.
 */
function platformVersion(): string | undefined {
  if (platform() === "linux") {
    try {
      const osRelease = readFileSync("/etc/os-release", "utf8");
      const versionId = osRelease.match(/^VERSION_ID="?([^"\n]+)"?/m);
      if (versionId) return versionId[1];
      const version = osRelease.match(/^VERSION="?([^"\n]+)"?/m);
      if (version) return version[1];
    } catch {
      // fall through to the kernel release
    }
  }
  return release() || undefined;
}

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * vibe 3.1.0 mapping (mistralai_vibe_local_harness/vibe/completion_profile/
 * reasoning.py REASONING_WIRE_VALUES[WireFormat.MISTRAL] = _EFFORT_WIRE,
 * applied by vibe/adapters/mistral.py): the level goes out AS WRITTEN —
 * low→"low", medium→"medium", high→"high", xhigh→"xhigh", max→"max" (any
 * other word would go out unchanged too). The old 3.0.x reduction to
 * none/high is gone.
 *
 * "off" → "none" only when the model's reasoning levels are curated
 * (known_models.py ReasoningSupport.levels non-empty, e.g. cli-latest has
 * ("high",)); for an uncurated model vibe omits the field entirely
 * (request_reasoning: support None + off → None). `curatedLevels` carries
 * that curation from KNOWN_MODEL_SPECS.
 *
 * pi-specific level: "minimal" has no vibe equivalent; the closest standard
 * level is "low".
 */
export function mapThinkingToReasoningEffort(
  level: string | undefined,
  curatedLevels?: readonly string[],
): ReasoningEffort | undefined {
  switch (level) {
    case "off":
      return curatedLevels && curatedLevels.length > 0 ? "none" : undefined;
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return level;
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
  /** Wire field: Mistral expects snake_case (`tool_call_id` / `tool_calls`). */
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown[];
  /** SDK 3.5.0 serializes AssistantMessage.prefix (default false). */
  prefix?: boolean;
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
      if (hadImages && supportsImages) {
        const parts = content
          .filter((item) => item.type === "text" || item.type === "image")
          .map((item) => {
            if (item.type === "text")
              return {
                type: "text",
                text: sanitizeSurrogates(item.text ?? ""),
              };
            // vibe 3.x format: image_url is an object {"url": "data:..."}
            // (snake_case), matching the SDK's ImageURLChunk serialization.
            return {
              type: "image_url",
              image_url: { url: `data:${item.mimeType};base64,${item.data}` },
            };
          });
        result.push({ role: "user", content: parts });
        continue;
      }
      // vibe's _content() sends text-only messages as one plain string,
      // blocks joined by "\n\n" (not a chunk array); only images force the
      // array form.
      const textContent = content
        .filter((item) => item.type === "text")
        .map((item) => sanitizeSurrogates(item.text ?? ""))
        .join("\n\n");
      if (textContent.length > 0) {
        result.push({ role: "user", content: textContent });
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
      const reasoningChunks: unknown[] = [];
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of (msg.content ?? []) as PiContentBlock[]) {
        if (block.type === "text") {
          textParts.push(sanitizeSurrogates(block.text ?? ""));
          continue;
        }
        if (block.type === "thinking") {
          if ((block.thinking ?? "").trim().length > 0) {
            reasoningChunks.push({
              type: "thinking",
              thinking: [
                { type: "text", text: sanitizeSurrogates(block.thinking ?? "") },
              ],
            });
          }
          continue;
        }
        if (block.type === "toolCall") {
          // SDK 3.5.0's ToolCall model serializes function/id/type/index,
          // with index defaulting to 0 since the adapter never sets it.
          toolCalls.push({
            function: {
              name: block.name,
              arguments: JSON.stringify(block.arguments ?? {}),
            },
            id: block.id,
            type: "function",
            index: 0,
          });
        }
      }
      // vibe's _message_payload: without reasoning, content is the joined
      // text as a plain string (or null); with reasoning, all thinking chunks
      // come first, then ONE text chunk holding every text block joined by
      // "\n\n". The SDK 3.5.0 serializer always adds prefix:false.
      const textContent = textParts.join("\n\n");
      let assistantContent: unknown = null;
      if (reasoningChunks.length > 0) {
        assistantContent = reasoningChunks;
        if (textContent.length > 0) {
          reasoningChunks.push({ type: "text", text: textContent });
        }
      } else if (textContent.length > 0) {
        assistantContent = textContent;
      }
      const assistantMessage: MistralChatMessage = {
        role: "assistant",
        content: assistantContent,
        prefix: false,
      };
      if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
      if (assistantContent !== null || toolCalls.length > 0) {
        result.push(assistantMessage);
      }
      continue;
    }
    if (msg.role === "toolResult") {
      // vibe 3.x (mistralai_vibe_local_harness/vibe/adapters/mistral.py
      // _message_payload) passes tool results with images as chunked content
      // (list of blocks) — the API accepts arrays on tool messages when the
      // image blocks use the correct snake_case `image_url: {"url": ...}`
      // shape. Without images, content is a plain string (like vibe's _text).
      const content = msg.content ?? [];
      const hasImages = supportsImages && content.some((p) => p.type === "image");
      if (hasImages) {
        const parts: unknown[] = [];
        for (const part of content) {
          if (part.type === "text") {
            const text = sanitizeSurrogates(part.text ?? "");
            if (text.trim().length > 0 || parts.length === 0) {
              parts.push({ type: "text", text });
            }
          } else if (part.type === "image") {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${part.mimeType};base64,${part.data}` },
            });
          }
        }
        if (parts.length === 0) parts.push({ type: "text", text: "" });
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          name: msg.toolName,
          content: parts,
        });
        continue;
      }
      // No images (or model doesn't support them): plain string content.
      const textResult = content
        .filter((part) => part.type === "text")
        .map((part) =>
          part.type === "text" ? sanitizeSurrogates(part.text ?? "") : "",
        )
        .join("\n\n"); // vibe's _text() joins blocks with a blank line
      const hadImages = content.some((part) => part.type === "image");
      const toolText = buildToolResultText(
        textResult,
        hadImages,
        supportsImages,
        msg.isError,
      );
      result.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        name: msg.toolName,
        content: toolText,
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
  // Called only when images are NOT sent on the wire (model doesn't support
  // images, or no images present). When the model supports images, tool
  // results with images are sent as chunked content (see toMistralMessages).
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
    return isError
      ? "[tool error] (image omitted: model does not support images)"
      : "(image omitted: model does not support images)";
  }
  return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

export interface BuildWireRequestInput {
  baseUrl: string; // e.g. https://api.mistral.ai/v1 (as in vibe api_base)
  apiKey: string;
  /** User-Agent header value. Since vibe 3.1.0 agent turns carry the vibe
   *  CLI UA: pass buildUserAgent(version). (MISTRAL_SDK_USER_AGENT is only a
   *  reference — the SDK default UA vibe no longer sends on agent turns.) */
  userAgent: string;
  sessionId?: string;
  model: string;
  messages: MistralChatMessage[];
  /** Always sent (vibe passes model.temperature from the config, no forcing). */
  temperature: number;
  /** vibe 3.x computes a dynamic output cap; omitted from the body when null
   *  (the SDK omits UNSET fields — vibe only passes the kwarg when it has a
   *  value). */
  maxTokens?: number | null;
  /** vibe 3.x sends top_p when the model route has one configured. */
  topP?: number | null;
  /** Telemetry block (buildVibeMetadata) — vibe always sends it; omitted when
   *  disabled via MISTRAL_VIBE_METADATA=off (documented divergence). */
  metadata?: Record<string, unknown>;
  tools?: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Assembles the HTTP request vibe 3.1.0 sends to Mistral on agent turns:
 *  - URL: origin from api_base (version suffix stripped, like vibe's
 *    _server_url_from_api_base) + /v1/chat/completions (the SDK path)
 *  - headers: Authorization Bearer, Content-Type application/json,
 *    Accept text/event-stream, User-Agent = the vibe CLI UA
 *    (mistral-client-python/Mistral-Vibe/<version>, injected via http_headers
 *    which override the SDK default), x-affinity: <sessionId>
 *  - body mirrors the SDK's ChatCompletionStreamRequest serialization as
 *    driven by vibe 3.1.x's adapter (mistralai_vibe_local_harness/vibe/adapters/
 *    mistral.py):
 *    - stream: true (always, SDK adds it for stream_async)
 *    - temperature always sent
 *    - max_tokens / tools / reasoning_effort / top_p are OMITTED when unset
 *      (vibe only passes the kwarg when it has a value; the SDK omits UNSET)
 *    - parallel_tool_calls: true when tools are present
 *    - telemetry metadata block (when enabled)
 *    - NO prompt_cache_key (vibe does not send it)
 *    - NO tool_choice (vibe never passes the kwarg on agent turns)
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

  const hasTools = input.tools !== undefined && input.tools.length > 0;
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature,
    stream: true,
  };
  // vibe 3.x omits these fields when unset (the adapter only passes the kwarg
  // when it has a value, and the SDK omits UNSET fields from the JSON body).
  if (input.maxTokens != null) body.max_tokens = input.maxTokens;
  if (input.topP != null) body.top_p = input.topP;
  if (hasTools) {
    body.tools = input.tools!.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        // vibe's _tool_payload always includes description (str, may be "").
        description: tool.description ?? "",
        parameters: tool.parameters,
      },
    }));
    // vibe 3.x always sends parallel_tool_calls: true when tools are present
    // (mistralai_vibe_local_harness/vibe/adapters/mistral.py:149).
    body.parallel_tool_calls = true;
  }
  if (input.reasoningEffort !== undefined) {
    body.reasoning_effort = input.reasoningEffort;
  }
  if (input.metadata) body.metadata = input.metadata;

  return { url, headers, body };
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
