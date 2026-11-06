#!/usr/bin/env node
/**
 * Differential test runner: same prompts to the vibe harness and to pi + the
 * mistral-vibe extension, through a recording proxy, then compare the shapes of
 * the captured requests.
 *
 *   node tests/differential/run.mjs                 # scripted, free, deterministic
 *   node tests/differential/run.mjs --mode live     # real API (costs credit)
 *   node tests/differential/run.mjs --only tool-call,text
 *
 * The API key is read from $MISTRAL_API_KEY, else from ~/.vibe/.env.
 * Nothing outside a temp dir is written (except pi's own session store).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios, TEST_MODEL } from "./scenarios.mjs";
import { compareScenario } from "./compare.mjs";

const EXT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HERE = join(EXT_ROOT, "tests", "differential");

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
};
const mode = option("mode", "scripted");
const only = option("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const maxTurns = option("max-turns", "3");

function apiKey() {
  if (process.env.MISTRAL_API_KEY) return process.env.MISTRAL_API_KEY;
  const envPath = join(homedir(), ".vibe", ".env");
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(
      /^(?:export\s+)?MISTRAL_API_KEY\s*=\s*(.+)$/m,
    );
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  throw new Error("no MISTRAL_API_KEY in env or ~/.vibe/.env");
}

function writeHome(dir, port) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.toml"),
    `active_model = "${TEST_MODEL}"

[[providers]]
name = "mistral"
api_base = "http://127.0.0.1:${port}/v1"
api_key_env_var = "MISTRAL_API_KEY"
backend = "mistral"

[[models]]
name = "${TEST_MODEL}"
provider = "mistral"
alias = "${TEST_MODEL}"
temperature = 1.0
thinking = "high"
supports_images = true
auto_compact_threshold = 200000
input_price = 0.7
output_price = 2.1
cached_input_price = 0.07
`,
  );
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 180_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startProxy(capturesDir, planDir) {
  const args = [
    join(HERE, "proxy.mjs"),
    "--ports",
    "vibe:8941,pi:8942",
    "--out",
    capturesDir,
    "--mode",
    mode === "live" ? "passthrough" : "scripted",
  ];
  if (mode !== "live") args.push("--plan-dir", planDir);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  child.stdout.on("data", (d) => lines.push(String(d)));
  child.stderr.on("data", (d) => lines.push(String(d)));
  for (let i = 0; i < 50; i += 1) {
    if (lines.join("").includes("proxy pi on")) break;
    await sleep(100);
  }
  return { child, log: () => lines.join("") };
}

const root = mkdtempSync(join(tmpdir(), "vibe-diff-"));
const key = apiKey();
const results = [];

for (const scenario of scenarios) {
  if (only.length && !only.includes(scenario.name)) continue;
  const dir = join(root, scenario.name);
  const workdir = join(dir, "workdir");
  const capturesDir = join(dir, "captures");
  const planDir = join(dir, "plans");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  for (const [name, content] of Object.entries(scenario.files ?? {})) {
    writeFileSync(
      join(workdir, name),
      content.replaceAll("{workdir}", workdir),
    );
  }
  const turns = (client) =>
    JSON.stringify({ turns: scenario.turns[client] }).replaceAll("{workdir}", workdir);
  writeFileSync(join(planDir, "plan-vibe.json"), turns("vibe"));
  writeFileSync(join(planDir, "plan-pi.json"), turns("pi"));

  writeHome(join(dir, "home-vibe"), 8941);
  writeHome(join(dir, "home-pi"), 8942);

  const proxy = await startProxy(capturesDir, planDir);
  const logs = [];

  for (const [index, prompt] of scenario.prompts.entries()) {
    const resolved = prompt.replaceAll("{workdir}", workdir);
    const continuation = index > 0;

    const vibeArgs = ["-p", resolved, "--auto-approve", "--output", "json", "--max-turns", maxTurns];
    if (!continuation) vibeArgs.push("--model", TEST_MODEL);
    else vibeArgs.push("-c");
    const vibeRun = await run("vibe", vibeArgs, {
      cwd: workdir,
      env: {
        ...process.env,
        VIBE_HOME: join(dir, "home-vibe"),
        MISTRAL_API_KEY: key,
      },
    });
    logs.push({ client: "vibe", turn: index + 1, ...vibeRun });

    const piArgs = ["-p", resolved, "--model", `mistral-vibe/${TEST_MODEL}`];
    if (continuation) piArgs.push("-c");
    const piRun = await run("pi", piArgs, {
      cwd: workdir,
      env: {
        ...process.env,
        MISTRAL_VIBE_DIR: join(dir, "home-pi"),
        MISTRAL_API_KEY: key,
        MISTRAL_VIBE_METADATA: "1",
      },
    });
    logs.push({ client: "pi", turn: index + 1, ...piRun });
  }

  proxy.child.kill("SIGTERM");
  await sleep(150);

  const captured = (client) => {
    const dirPath = join(capturesDir, client);
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath)
      .filter((f) => f.startsWith("req-") && f.endsWith(".json"))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((f) => JSON.parse(readFileSync(join(dirPath, f), "utf8")));
  };

  results.push({
    scenario,
    logs,
    vibe: captured("vibe"),
    pi: captured("pi"),
    proxyLog: proxy.log(),
  });
}

const failures = [];
for (const result of results) {
  const report = compareScenario(result);
  console.log(report.text);
  if (report.failed) failures.push(result.scenario.name);
}

const hardFailures = results.filter((r) => r.logs.some((l) => l.code !== 0));
for (const result of hardFailures) {
  console.log(`\n!! ${result.scenario.name}: a client exited non-zero`);
  for (const log of result.logs.filter((l) => l.code !== 0)) {
    console.log(`   ${log.client} (turn ${log.turn}) code=${log.code}`);
    console.log(`   ${(log.stderr || log.stdout).split("\n").slice(-4).join("\n   ")}`);
  }
}

console.log(`\ncaptures: ${root}`);
if (failures.length || hardFailures.length) {
  console.log(`FAIL: ${[...new Set([...failures, ...hardFailures.map((r) => r.scenario.name)])].join(", ")}`);
  process.exit(1);
}
console.log("PASS: all scenarios match");
