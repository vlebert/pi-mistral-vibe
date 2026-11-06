/**
 * Differential scenarios: the same prompt is sent to the vibe harness and to
 * pi + the mistral-vibe extension, and the recorded requests are compared.
 *
 * In scripted mode (default) the model replies are canned, so the scenarios are
 * deterministic and cost nothing: what is compared is the request each client
 * builds. In live mode (--mode live) the real API answers — only self-contained
 * scenarios (no scripted tool calls) make sense there.
 */

const MODEL = "mistral-large-4";
const USAGE = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };

function chunk(extra, id = "mock-1") {
  return {
    id,
    model: MODEL,
    object: "chat.completion.chunk",
    created: 1,
    choices: [],
    ...extra,
  };
}

export function textTurn(text, id = "mock-2") {
  return [
    chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, id),
    chunk(
      {
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        usage: USAGE,
      },
      id,
    ),
  ];
}

export function thinkingTurn(thinking, text) {
  return [
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            content: [
              { type: "thinking", thinking: [{ type: "text", text: thinking }] },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    chunk({
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
      usage: USAGE,
    }),
  ];
}

export function toolTurn(calls) {
  return [
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: USAGE,
    }),
  ];
}

/**
 * scenarios[].turns: { vibe: [...turns], pi: [...turns] }
 * scenarios[].files: written inside the per-scenario workdir ({workdir}).
 * scenarios[].prompts: one run per prompt; prompts[0] starts the session, the
 * following ones continue it (-c).
 */
export const scenarios = [
  {
    name: "text",
    prompts: ["Réponds uniquement: OK"],
    turns: { vibe: [textTurn("OK")], pi: [textTurn("OK")] },
  },
  {
    name: "tool-call",
    prompts: ["Lis le fichier {workdir}/input.txt"],
    files: { "input.txt": "contenu test 42\n" },
    maxTurns: 3,
    turns: {
      vibe: [
        toolTurn([{ id: "abc123456", name: "read_file", arguments: { path: "{workdir}/input.txt" } }]),
        textTurn("done"),
      ],
      pi: [
        toolTurn([{ id: "abc123456", name: "read", arguments: { path: "{workdir}/input.txt" } }]),
        textTurn("done"),
      ],
    },
  },
  {
    name: "parallel-tool-calls",
    prompts: ["Lis les deux fichiers {workdir}/a.txt et {workdir}/b.txt"],
    files: { "a.txt": "fichier A\n", "b.txt": "fichier B\n" },
    maxTurns: 3,
    turns: {
      vibe: [
        toolTurn([
          { id: "abc123456", name: "read_file", arguments: { path: "{workdir}/a.txt" } },
          { id: "def654321", name: "read_file", arguments: { path: "{workdir}/b.txt" } },
        ]),
        textTurn("done"),
      ],
      pi: [
        toolTurn([
          { id: "abc123456", name: "read", arguments: { path: "{workdir}/a.txt" } },
          { id: "def654321", name: "read", arguments: { path: "{workdir}/b.txt" } },
        ]),
        textTurn("done"),
      ],
    },
  },
  {
    name: "thinking-replay",
    prompts: ["Question 1", "Question 2"],
    turns: {
      vibe: [thinkingTurn("raisonnement de test 42", "réponse 1"), textTurn("réponse 2")],
      pi: [thinkingTurn("raisonnement de test 42", "réponse 1"), textTurn("réponse 2")],
    },
  },
];

/** vibe tool name -> pi tool name, for the shape comparison. */
export const TOOL_ALIASES = {
  read_file: "read",
  write_file: "write",
};

export const TEST_MODEL = MODEL;
