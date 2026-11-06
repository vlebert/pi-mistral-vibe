#!/usr/bin/env node
/**
 * Recording proxy for the differential test (vibe harness vs pi + mistral-vibe
 * extension). One port per client, so captures are never mixed up even though
 * both send the same User-Agent.
 *
 * Records every chat-completions request under <out>/<client>/req-<n>.json
 * (headers minus authorization + body).
 *
 * Modes:
 *   --mode passthrough  forward to https://api.mistral.ai (real cost)
 *   --mode scripted     answer with the SSE chunks of <plan-dir>/plan-<client>.json
 *                       ({"turns": [[chunk, ...], ...]}, one entry per turn)
 *
 * Usage:
 *   node proxy.mjs --ports vibe:8941,pi:8942 --out <dir> --mode scripted \
 *     --plan-dir <dir>
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .matchAll(/--([\w-]+)(?:[= ]("[^"]*"|\S+))?/g)
    .map(([, k, v]) => [k, v === undefined ? true : String(v).replace(/^"|"$/g, "")]),
);

const out = String(args.out ?? "captures");
const mode = String(args.mode ?? "passthrough");
const planDir = args["plan-dir"] ? String(args["plan-dir"]) : undefined;
const ports = String(args.ports ?? "vibe:8941,pi:8942")
  .split(",")
  .map((entry) => {
    const [client, port] = entry.split(":");
    return { client, port: Number(port) };
  });

function chunksFor(client, turn) {
  if (!planDir) return [];
  const plan = JSON.parse(readFileSync(join(planDir, `plan-${client}.json`), "utf8"));
  return plan.turns[turn] ?? [];
}

for (const { client, port } of ports) {
  const dir = join(out, client);
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  let turn = 0;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        const isChat = String(req.url).includes("chat/completions");
        const headers = { ...req.headers };
        delete headers.authorization;
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          // ignore non-JSON bodies
        }

        if (isChat) {
          seq += 1;
          writeFileSync(
            join(dir, `req-${seq}.json`),
            JSON.stringify({ seq, method: req.method, url: req.url, headers, body }, null, 2),
          );
        } else {
          writeFileSync(
            join(dir, `other-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.json`),
            JSON.stringify({ method: req.method, url: req.url, headers, body }, null, 2),
          );
        }

        if (mode === "scripted") {
          if (!isChat) {
            res.writeHead(404).end();
            return;
          }
          const chunks = chunksFor(client, turn);
          turn += 1;
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // passthrough: same path on the real API, streamed back verbatim.
        const noBody = req.method === "GET" || req.method === "HEAD";
        const upstream = await fetch(`https://api.mistral.ai${req.url}`, {
          method: req.method,
          headers: {
            "content-type": req.headers["content-type"] ?? "application/json",
            accept: req.headers.accept ?? "application/json",
            authorization: req.headers.authorization ?? "",
            "user-agent": req.headers["user-agent"] ?? "",
          },
          body: noBody ? undefined : raw,
        });
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } catch (error) {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy error: ${error?.message ?? error}`);
      }
    });
  });

  server.listen(port, "127.0.0.1", () =>
    console.log(`proxy ${client} on ${port} (${mode})`),
  );
}
