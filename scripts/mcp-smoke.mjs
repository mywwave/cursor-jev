#!/usr/bin/env node
import { spawn } from "node:child_process";
import { encodeMessage } from "../src/mcp.mjs";

function send(child, msg) {
  child.stdin.write(encodeMessage(msg));
}

function takeMessages(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
    buffer = buffer.subarray(nl + 1);
    if (!line || line.toLowerCase().startsWith("content-length:")) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      /* wait for a complete JSON line */
    }
  }
}

const child = spawn(process.execPath, ["bin/cli.mjs", "mcp"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let buffer = Buffer.alloc(0);
const messages = [];

child.stdout.on("data", takeMessages);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

send(child, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "cursor-jev-smoke", version: "0" },
  },
});

await new Promise((r) => setTimeout(r, 300));
send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
send(child, { jsonrpc: "2.0", id: 3, method: "prompts/list" });
send(child, { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "jev://status" } });
send(child, {
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: {
    name: "jev_route",
    arguments: { task: "Search this repository for the Task hook without changing files" },
  },
});
send(child, {
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: {
    name: "jev_ask",
    arguments: {
      state: "The hook rewrites Task subagent_type using TypeSafe Jev.",
      questions: {
        about_routing: {
          type: "noul",
          instructions: "Does this text describe routing Cursor subagents?",
        },
      },
    },
  },
});

await new Promise((r) => setTimeout(r, 4000));
child.stdin.end();
await new Promise((r) => child.on("close", r));

if (stderr.trim()) console.error(stderr.trim());
for (const msg of messages) {
  console.log(
    JSON.stringify({
      id: msg.id,
      method: msg.method,
      title: msg.result?.serverInfo?.title,
      icons: msg.result?.serverInfo?.icons?.length,
      tools: msg.result?.tools?.map((t) => t.name),
      prompts: msg.result?.prompts?.map((p) => p.name),
      status: msg.result?.contents?.[0]?.text,
      text: msg.result?.content?.[0]?.text?.slice(0, 240),
      isError: msg.result?.isError,
      error: msg.error?.message,
    }),
  );
}
if (messages.length === 0) {
  console.error("no MCP frames received");
  process.exit(1);
}
