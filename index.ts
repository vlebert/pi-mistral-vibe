/**
 * mistral-vibe — a pi provider that talks to the Mistral API exactly like the
 * `mistral-vibe` harness 3.0.2 does (same headers, same reasoning behavior,
 * same models), reading its API key and model config from the local ~/.vibe
 * installation.
 *
 * Wire parity target: vibe 3.0.2 agent turns (mistralai_vibe_local_harness/
 * vibe/adapters/mistral.py + mistralai Python SDK 2.6.0).
 *
 * Auto-discovered from ~/.pi/agent/extensions/mistral-vibe/index.ts.
 * `/reload` re-reads ~/.vibe/config.toml and ~/.vibe/.env.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  loadVibeRuntime,
  resolveApiKey,
  type VibeModelConfig,
  type VibeRuntime,
} from "./vibe-config.js";
import { streamMistralVibe } from "./stream.js";

const PROVIDER_ID = "mistral-vibe";

/**
 * Real model specs (docs.mistral.ai) keyed by the vibe config model name.
 * Fallback: auto_compact_threshold (vibe's compaction trigger, NOT the context
 * window) or a conservative 200k. Override any value via pi models.json.
 */
const KNOWN_MODEL_SPECS: Record<
  string,
  { contextWindow: number; maxTokens: number }
> = {
  "zai-glm-5-2": { contextWindow: 1_000_000, maxTokens: 128_000 }, // GLM 5.2 (Mistral-hosted)
  "zai-glm-5-3": { contextWindow: 1_000_000, maxTokens: 128_000 }, // GLM 5.3 (Mistral-hosted)
  "mistral-large-4-0": { contextWindow: 1_048_576, maxTokens: 262_144 }, // Mistral Large 4
  "mistral-vibe-cli-latest": { contextWindow: 262_144, maxTokens: 16_384 }, // mistral-medium-3.5
};

/** vibe thinking level -> pi thinking levels (informational; wire mapping happens in stream). */
const THINKING_LEVEL_MAP = {
  off: "off",
  minimal: "none",
  low: "none",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;

export default function (pi: ExtensionAPI) {
  const runtime = loadVibeRuntime();
  const models = buildPiModels(runtime);

  // Give pi a concrete key so its auth gate passes; streamSimple still
  // re-resolves fresh from env / ~/.vibe/.env on every request, so key
  // updates in vibe's config are picked up without a restart.
  const loadTimeApiKey = resolveApiKey(
    process.env as Record<string, string | undefined>,
    runtime.apiKeyEnvVar,
    runtime.vibeDir,
  );

  pi.registerProvider(PROVIDER_ID, {
    name: "Mistral Vibe",
    baseUrl: runtime.baseUrl,
    // Literal key when found (falls back to $ENV_VAR, which prompts /login).
    apiKey: loadTimeApiKey ?? `$${runtime.apiKeyEnvVar}`,
    api: PROVIDER_ID,
    headers: { "user-agent": runtime.userAgent },
    models,
    streamSimple: (model, context, options) =>
      streamMistralVibe(model, context, options, runtime),
  });

  pi.registerCommand("mistral-vibe-status", {
    description: "Show mistral-vibe provider config (base URL, User-Agent, models, key source)",
    handler: async (_args, ctx) => {
      const lines = describeRuntime(runtime, models);
      const text = lines.join("\n");
      console.log(text);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });

  // Normalize overflow errors so pi's auto-compaction recovery triggers.
  // Scope strictly to this provider, mirroring the docs' recommended pattern.
  const OVERFLOW_PATTERN =
    /context length|context_length|maximum context|max[.\s-]*context|too many tokens|token limit|prompt.*(too long|too large|exceeds)/i;
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (message.provider !== PROVIDER_ID && ctx.model?.provider !== PROVIDER_ID)
      return;
    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) return;
    if (!OVERFLOW_PATTERN.test(errorMessage)) return;
    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage}`,
      },
    };
  });
}

function buildPiModels(runtime: VibeRuntime): ProviderModelConfig[] {
  const models = [
    ...runtime.models.map((m) => modelToPi(m, runtime)),
    ...runtime.defaultModels.map((m) => modelToPi(m, runtime)),
  ];
  // Deduplicate by wire id (config entries win).
  const seen = new Set<string>();
  const unique: ProviderModelConfig[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    unique.push(model);
  }
  return unique;
}

function modelToPi(
  m: VibeModelConfig,
  runtime: VibeRuntime,
): ProviderModelConfig {
  const thinking = m.thinking ?? "off";
  const supportsImages = m.supports_images ?? false;
  const spec = KNOWN_MODEL_SPECS[m.name];
  const contextWindow = spec?.contextWindow ?? m.auto_compact_threshold ?? 200_000;
  return {
    id: m.name, // wire id: what vibe sends as `model`
    name: m.alias ?? m.name, // display name
    reasoning: thinking !== "off",
    thinkingLevelMap: THINKING_LEVEL_MAP,
    input: supportsImages ? ["text", "image"] : ["text"],
    cost: {
      input: m.input_price ?? 0,
      output: m.output_price ?? 0,
      cacheRead: m.cached_input_price ?? 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens: spec?.maxTokens ?? 16_384,
  };
}

function describeRuntime(
  runtime: VibeRuntime,
  models: ProviderModelConfig[],
): string[] {
  const lines: string[] = [];
  lines.push(`mistral-vibe provider (id: ${PROVIDER_ID})`);
  lines.push(`  vibe dir        : ${runtime.vibeDir}`);
  lines.push(`  base URL        : ${runtime.baseUrl}`);
  lines.push(`  User-Agent      : ${runtime.userAgent}`);
  lines.push(`  api key env var : ${runtime.apiKeyEnvVar} (env, then ~/.vibe/.env)`);
  lines.push(
    `  telemetry block : ${
      runtime.options.sendTelemetryMetadata ?? true ? "on" : "off"
    } (config.local.json sendTelemetryMetadata; env MISTRAL_VIBE_METADATA overrides)`,
  );
  for (const warning of runtime.warnings) {
    lines.push(`  warning         : ${warning}`);
  }
  lines.push(`  models:`);
  for (const model of models) {
    lines.push(
      `    - ${PROVIDER_ID}/${model.id} (${model.name}) reasoning=${model.reasoning} input=[${model.input.join(",")}] ctx=${model.contextWindow}`,
    );
  }
  return lines;
}
