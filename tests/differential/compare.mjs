/**
 * Shape comparison for the differential test.
 *
 * Compares the request *structure* each client produces, never the content:
 * prompt text, tool schemas and tool results legitimately differ between the
 * vibe harness and pi. What must match is everything the extension claims to
 * mirror: headers, body fields and their presence, message roles, content
 * serialization (string vs chunk array), thinking chunks, tool-call replay and
 * image chunks.
 */
import { TOOL_ALIASES } from "./scenarios.mjs";

/** Body fields where a documented divergence is expected. */
const EXPECTED_BODY_DIVERGENCES = {
  max_tokens: "pi always sends max_tokens (documented: protects pi's context window)",
  metadata: "telemetry block is vibes's; pi reproduces it behind a flag",
};

/** Metadata keys that describe the client itself, not the request shape. */
const IGNORED_METADATA_KEYS = new Set([
  "agent_entrypoint",
  "agent_version",
  "client_name",
  "client_version",
  "message_id",
  "user_plan",
  "call_type",
  "session_id",
]);

function argKeys(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Object.keys(parsed ?? {}).sort();
  } catch {
    return ["<unparseable>"];
  }
}

function blockShape(block) {
  const keys = Object.keys(block ?? {}).sort();
  if (block?.type === "text") return { type: "text", keys: keys.filter((k) => k !== "text") };
  if (block?.type === "thinking") {
    return {
      type: "thinking",
      keys: keys.filter((k) => k !== "thinking"),
      parts: (block.thinking ?? []).map((p) => Object.keys(p).sort()),
    };
  }
  if (block?.type === "image_url") {
    return {
      type: "image_url",
      keys,
      imageUrlKeys: Object.keys(block.image_url ?? {}).sort(),
      dataUrl: typeof block.image_url?.url === "string" &&
        block.image_url.url.startsWith("data:"),
    };
  }
  return { type: block?.type ?? null, keys };
}

function messageShape(message) {
  const shape = { role: message.role };
  const content = message.content;
  if (typeof content === "string") shape.content = "string";
  else if (Array.isArray(content)) {
    shape.content = "array";
    shape.blocks = content.map(blockShape);
  } else shape.content = content === null ? "null" : typeof content;

  shape.extras = Object.keys(message)
    .filter((key) => key !== "role" && key !== "content")
    .sort();

  if (Array.isArray(message.tool_calls)) {
    shape.toolCalls = message.tool_calls.map((call) => ({
      index: call.index,
      type: call.type,
      name: TOOL_ALIASES[call.function?.name] ?? call.function?.name,
      functionKeys: Object.keys(call.function ?? {}).sort(),
      argumentKeys: argKeys(call.function?.arguments),
      idLength: typeof call.id === "string" ? call.id.length : null,
    }));
  }
  return shape;
}

function headerShape(headers) {
  const userAgent = String(headers["user-agent"] ?? "");
  const uaMatch = userAgent.match(/^(.*?)\/(\d+\.\d+\.\d+)/);
  return {
    userAgentPrefix: uaMatch ? uaMatch[1] : userAgent,
    accept: headers.accept ?? null,
    contentType: headers["content-type"] ?? null,
    hasAffinity: Boolean(headers["x-affinity"]),
  };
}

function metadataShape(metadata) {
  if (!metadata) return null;
  const keys = Object.keys(metadata).filter((key) => !IGNORED_METADATA_KEYS.has(key)).sort();
  return {
    keys,
    os: metadata.os,
    arch: metadata.arch,
    version: metadata.version,
    callSource: metadata.call_source,
    hostKind: metadata.host_kind,
    terminalEmulator: metadata.terminal_emulator,
    hasSessionId: Boolean(metadata.session_id),
  };
}

function toolsShape(tools) {
  if (!Array.isArray(tools)) return null;
  return tools.map((tool) => ({
    type: tool.type,
    functionKeys: Object.keys(tool.function ?? {}).sort(),
    parameterKeys: Object.keys(tool.function?.parameters ?? {}).sort(),
  }));
}

function requestShape(request) {
  const body = request.body ?? {};
  const bodyKeys = Object.keys(body).sort();
  return {
    url: request.url,
    headers: headerShape(request.headers ?? {}),
    bodyKeys,
    scalars: {
      model: body.model,
      temperature: body.temperature,
      reasoningEffort: body.reasoning_effort,
      parallelToolCalls: body.parallel_tool_calls,
      stream: body.stream,
      topP: body.top_p,
    },
    messages: (body.messages ?? []).map(messageShape),
    tools: toolsShape(body.tools),
    metadata: metadataShape(body.metadata),
    maxTokensPresent: body.max_tokens !== undefined,
  };
}

function diff(left, right, path, out) {
  if (left === right) return;
  const leftIsObject = left && typeof left === "object";
  const rightIsObject = right && typeof right === "object";
  if (!leftIsObject || !rightIsObject) {
    out.push(`${path}: vibe=${JSON.stringify(left)} pi=${JSON.stringify(right)}`);
    return;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    out.push(`${path}: vibe=${Array.isArray(left) ? "array" : "object"} pi=${Array.isArray(right) ? "array" : "object"}`);
    return;
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  for (const key of keys) {
    diff(left[key], right[key], path ? `${path}.${key}` : key, out);
  }
}

export function compareScenario(result) {
  const { scenario, vibe, pi } = result;
  const lines = [`── ${scenario.name}`];
  const problems = [];
  const notes = [];

  if (vibe.length !== pi.length) {
    problems.push(`request count: vibe=${vibe.length} pi=${pi.length}`);
  }
  if (vibe.length === 0) problems.push("no request captured for vibe");

  for (let index = 0; index < Math.min(vibe.length, pi.length); index += 1) {
    const left = requestShape(vibe[index]);
    const right = requestShape(pi[index]);
    const where = `request ${index + 1}`;

    // Documented / expected divergences, reported but not failures.
    delete left.maxTokensPresent;
    delete right.maxTokensPresent;

    if (!left.metadata || !right.metadata) {
      notes.push(`${where}: metadata ${left.metadata ? "vibe" : "pi"} only`);
    }
    if (!left.metadata || !right.metadata) {
      delete left.metadata;
      delete right.metadata;
    }

    if (left.bodyKeys.join() !== right.bodyKeys.join()) {
      const missingRight = left.bodyKeys.filter((k) => !right.bodyKeys.includes(k));
      const missingLeft = right.bodyKeys.filter((k) => !left.bodyKeys.includes(k));
      for (const key of missingRight) {
        if (key in EXPECTED_BODY_DIVERGENCES) notes.push(`${where}: ${key} only in vibe (${EXPECTED_BODY_DIVERGENCES[key]})`);
        else problems.push(`${where}: body field ${key} missing from pi`);
      }
      for (const key of missingLeft) {
        if (key in EXPECTED_BODY_DIVERGENCES) notes.push(`${where}: ${key} only in pi (${EXPECTED_BODY_DIVERGENCES[key]})`);
        else problems.push(`${where}: body field ${key} missing from vibe`);
      }
      delete left.bodyKeys;
      delete right.bodyKeys;
    }

    // Tool *names* and counts differ by design (pi's toolset is not vibe's);
    // only the tool schema envelope is compared.
    for (const side of [left, right]) {
      if (Array.isArray(side.tools)) {
        side.toolEnvelope = side.tools[0] ?? null;
        side.toolCount = side.tools.length;
      }
      delete side.tools;
    }
    if ((left.toolEnvelope === null) !== (right.toolEnvelope === null)) {
      problems.push(`${where}: tools ${left.toolEnvelope ? "vibe" : "pi"} only`);
    }
    if ((left.toolCount > 0) !== (right.toolCount > 0)) {
      problems.push(`${where}: one side sends no tools`);
    }
    delete left.toolEnvelope;
    delete right.toolEnvelope;
    delete left.toolCount;
    delete right.toolCount;

    diff(left, right, where, problems);
  }

  const requests = `requests: vibe=${vibe.length} pi=${pi.length}`;
  lines.push(`   ${requests}`);
  for (const note of notes) lines.push(`   note: ${note}`);
  for (const problem of problems) lines.push(`   DIFF: ${problem}`);
  if (!problems.length) lines.push("   OK");
  lines.push("");
  return { text: lines.join("\n"), failed: problems.length > 0 };
}
