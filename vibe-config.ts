/**
 * Reads the local Mistral Vibe installation and configuration so the provider
 * mirrors it exactly:
 *  - API key: env var (MISTRAL_API_KEY) then ~/.vibe/.env (where vibe persists
 *    the key it stores in its own config)
 *  - api_base: ~/.vibe/config.toml [[providers]] entry (default: the vibe
 *    harness default https://api.mistral.ai/v1)
 *  - models: [[models]] entries whose provider runs the Mistral backend, plus
 *    the harness's DEFAULT_MODELS (vibe/core/config/vibe_schema.py)
 *  - User-Agent version: read from the installed vibe package (fallback
 *    constant)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_VERSION,
  buildUserAgent,
  parseEnvFile,
  parseTomlSubset,
  type TomlDoc,
} from "./wire.js";

export interface VibeProviderConfig {
  name: string;
  api_base: string;
  api_key_env_var: string;
  backend?: string;
}

export interface VibeModelConfig {
  name: string;
  provider: string;
  alias?: string;
  temperature?: number;
  thinking?: string;
  input_price?: number;
  output_price?: number;
  cached_input_price?: number;
  supports_images?: boolean;
  auto_compact_threshold?: number;
}

export interface VibeRuntime {
  vibeDir: string;
  baseUrl: string; // api_base from config, default https://api.mistral.ai/v1
  apiKeyEnvVar: string; // e.g. MISTRAL_API_KEY
  userAgent: string; // mistral-client-python/Mistral-Vibe/<version>
  version: string;
  providers: VibeProviderConfig[];
  models: VibeModelConfig[]; // config.toml [[models]] on the mistral backend
  defaultModels: VibeModelConfig[]; // harness DEFAULT_MODELS
  warnings: string[];
}

export function vibeDir(): string {
  return process.env.MISTRAL_VIBE_DIR ?? join(homedir(), ".vibe");
}

function readVibeDotEnv(dir: string): Record<string, string> {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

function readVibeConfigToml(dir: string): TomlDoc | null {
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) return null;
  try {
    return parseTomlSubset(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/** Locate the installed vibe package version (uv tool layout). */
export function findInstalledVibeVersion(): string | undefined {
  const candidates = [
    join(
      homedir(),
      ".local/share/uv/tools/mistral-vibe/lib",
    ),
  ];
  for (const libDir of candidates) {
    if (!existsSync(libDir)) continue;
    let pythonDirs: string[];
    try {
      pythonDirs = readdirSync(libDir).filter((name) =>
        name.startsWith("python"),
      );
    } catch {
      continue;
    }
    for (const pyDir of pythonDirs) {
      const initPath = join(
        libDir,
        pyDir,
        "site-packages",
        "vibe",
        "__init__.py",
      );
      if (!existsSync(initPath)) continue;
      try {
        const source = readFileSync(initPath, "utf8");
        const match = source.match(/__version__\s*=\s*"([^"]+)"/);
        if (match) return match[1];
      } catch {
        // try next candidate
      }
    }
  }
  return undefined;
}

/** The harness DEFAULT_MODELS on the mistral provider (vibe_schema.py).
 *  Kept minimal: only the vibe default `mistral-vibe-cli-latest`
 *  (alias mistral-medium-3.5). Official USD pricing (mistral.ai/pricing):
 *  input $1.5 / cached $0.15 / output $7.5 per Mtok. */
export function harnessDefaultModels(): VibeModelConfig[] {
  return [
    {
      name: "mistral-vibe-cli-latest",
      provider: "mistral",
      alias: "mistral-medium-3.5",
      temperature: 1.0,
      thinking: "high",
      input_price: 1.5,
      output_price: 7.5,
      cached_input_price: 0.15,
      supports_images: true,
    },
  ];
}

/**
 * Resolve the API key the way vibe does: env var first, then the key vibe
 * persisted in ~/.vibe/.env. Returns undefined when nothing is found.
 */
export function resolveApiKey(
  env: Record<string, string | undefined>,
  envVarName: string,
  dir: string,
): string | undefined {
  const fromEnv = env[envVarName];
  if (fromEnv) return fromEnv;
  const dotEnv = readVibeDotEnv(dir);
  return dotEnv[envVarName];
}

/** Build the runtime snapshot read at extension load. */
export function loadVibeRuntime(): VibeRuntime {
  const warnings: string[] = [];
  const dir = vibeDir();
  const doc = readVibeConfigToml(dir);
  const version = findInstalledVibeVersion() ?? DEFAULT_VERSION;
  const userAgent = buildUserAgent(version);

  const providers: VibeProviderConfig[] = [];
  const configModels: VibeModelConfig[] = [];
  const mistralProviderDefaults: VibeProviderConfig = {
    name: "mistral",
    api_base: DEFAULT_BASE_URL,
    api_key_env_var: "MISTRAL_API_KEY",
    backend: "mistral",
  };

  if (doc) {
    for (const entry of doc.arrays.get("providers") ?? []) {
      providers.push({
        name: String(entry.name ?? ""),
        api_base: String(entry.api_base ?? DEFAULT_BASE_URL),
        api_key_env_var: String(entry.api_key_env_var ?? "MISTRAL_API_KEY"),
        backend: entry.backend ? String(entry.backend) : undefined,
      });
    }
    for (const entry of doc.arrays.get("models") ?? []) {
      configModels.push({
        name: String(entry.name ?? ""),
        provider: String(entry.provider ?? ""),
        alias: entry.alias ? String(entry.alias) : undefined,
        temperature:
          typeof entry.temperature === "number" ? entry.temperature : undefined,
        thinking: entry.thinking ? String(entry.thinking) : undefined,
        input_price:
          typeof entry.input_price === "number" ? entry.input_price : undefined,
        output_price:
          typeof entry.output_price === "number" ? entry.output_price : undefined,
        cached_input_price:
          typeof entry.cached_input_price === "number"
            ? entry.cached_input_price
            : undefined,
        supports_images:
          typeof entry.supports_images === "boolean"
            ? entry.supports_images
            : undefined,
        auto_compact_threshold:
          typeof entry.auto_compact_threshold === "number"
            ? entry.auto_compact_threshold
            : undefined,
      });
    }
  } else {
    warnings.push(
      `~/.vibe/config.toml not found (${dir}); using mistral-vibe defaults`,
    );
  }

  // Provider used by each config model: explicit [[providers]] entry, or the
  // "mistral" default provider (backend mistral).
  const providerFor = (name: string): VibeProviderConfig => {
    const found = providers.find((p) => p.name === name);
    return found ?? (name === "mistral" ? mistralProviderDefaults : found);
  };

  const mistralProvider = providerFor("mistral") ?? mistralProviderDefaults;

  // Keep only models that run on the Mistral backend (like vibe's MistralBackend).
  const mistralBackendModels = configModels.filter((m) => {
    const p = providerFor(m.provider);
    return p && (p.backend === "mistral" || p.name === "mistral");
  });

  const defaults = harnessDefaultModels();
  const seen = new Set(mistralBackendModels.map((m) => m.name));
  const defaultModels = defaults.filter((m) => !seen.has(m.name));

  if (mistralBackendModels.length === 0 && defaults.length === 0) {
    warnings.push("No models registered: no mistral-backend models found");
  }

  return {
    vibeDir: dir,
    baseUrl: mistralProvider.api_base || DEFAULT_BASE_URL,
    apiKeyEnvVar: mistralProvider.api_key_env_var || "MISTRAL_API_KEY",
    userAgent,
    version,
    providers,
    models: mistralBackendModels,
    defaultModels,
    warnings,
  };
}
