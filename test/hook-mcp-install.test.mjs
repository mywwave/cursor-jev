import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePreToolUse } from "../src/hook.mjs";
import { createFramer, encodeMessage, handleRpc } from "../src/mcp.mjs";
import { mergeHooksConfig, mergeMcpConfig, unmergeHooksConfig, unmergeMcpConfig } from "../src/install.mjs";

function fetcherFor(choice, confidence = 0.92, noul = 0.9) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      answers: {
        role: { type: "choice", choice, confidence, probabilities: { [choice]: 1 } },
        needs_specialist: { type: "noul", noul },
      },
    }),
  });
}

test("hook rewrites Task subagent_type and annotates prompt", async () => {
  const result = await handlePreToolUse(
    {
      tool_name: "Task",
      tool_input: {
        subagent_type: "generalPurpose",
        description: "Find auth",
        prompt: "Find the auth middleware",
        model: "inherit",
      },
    },
    { key: "key", fetcher: fetcherFor("explore") },
  );
  assert.equal(result.permission, "allow");
  assert.equal(result.updated_input.subagent_type, "explore");
  assert.equal(result.updated_input.model, "inherit");
  assert.match(result.updated_input.prompt, /^Jev routed: explore status=routed confidence=0\.92\n\nFind the auth middleware$/);
});

test("hook fail-open leaves the call unchanged when Jev is unavailable", async () => {
  const result = await handlePreToolUse(
    {
      tool_name: "Task",
      tool_input: { subagent_type: "explore", prompt: "search" },
    },
    { key: "", fetcher: fetcherFor("generalPurpose") },
  );
  assert.deepEqual(result, { permission: "allow" });
});

test("hook ignores non-Task tools", async () => {
  const result = await handlePreToolUse(
    { tool_name: "Shell", tool_input: { command: "ls" } },
    { key: "key", fetcher: fetcherFor("explore") },
  );
  assert.deepEqual(result, { permission: "allow" });
});

test("stdio frames are newline-delimited JSON", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
  const frame = encodeMessage(init).toString("utf8");
  assert.equal(frame.endsWith("\n"), true);
  assert.equal(frame.includes("Content-Length"), false);
  assert.deepEqual(JSON.parse(frame), init);

  const received = [];
  const push = createFramer((msg) => received.push(msg));
  push(Buffer.from(`${JSON.stringify(init)}\n`));
  push(encodeMessage({ jsonrpc: "2.0", id: 2, method: "ping" }));
  assert.equal(received.length, 2);
  assert.equal(received[1].method, "ping");
});

test("MCP initialize and tools/list", async () => {
  const init = await handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "cursor-jev");
  assert.equal(init.result.serverInfo.title, "Jev");
  assert.ok(init.result.serverInfo.icons?.length >= 1);
  assert.match(init.result.serverInfo.icons[0].src, /^data:image\/svg\+xml/);
  assert.ok(init.result.capabilities.tools);

  const list = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["jev_auth", "jev_route", "jev_ask"],
  );
});

test("MCP jev_auth without a session explains how to connect", async () => {
  const result = await handleRpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "jev_auth", arguments: {} },
  });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Configure|set-key|jev_auth/i);
});

test("MCP jev_auth elicitation saves the key", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cursor-jev-"));
  const session = {
    home: tmp,
    elicit: async () => ({ action: "accept", content: { apiKey: "apikey_test_not_real" } }),
  };
  const result = await handleRpc(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "jev_auth", arguments: {} },
    },
    { session },
  );
  assert.equal(result.result.isError, undefined);
  assert.match(result.result.content[0].text, /connected/i);
});

test("MCP jev_ask rejects unknown question types", async () => {
  const result = await handleRpc(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jev_ask",
        arguments: { state: "hello", questions: { x: { type: "essay" } } },
      },
    },
    { key: "key" },
  );
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /choice, score, or noul/);
});

test("install merge keeps unrelated MCP servers and hooks", () => {
  const root = "/tmp/cursor-jev";
  const mcp = mergeMcpConfig(
    { mcpServers: { other: { command: "echo" } } },
    root,
  );
  assert.equal(mcp.mcpServers.other.command, "echo");
  assert.equal(mcp.mcpServers.jev.command, "node");
  assert.equal(mcp.mcpServers.jev.type, "stdio");
  assert.ok(mcp.mcpServers.jev.envFile.includes("cursor-jev.env"));
  assert.ok(mcp.mcpServers.jev.args[0].includes("cli.mjs"));

  const hooks = mergeHooksConfig(
    { version: 1, hooks: { preToolUse: [{ command: "node other.js", matcher: "Shell" }] } },
    root,
  );
  assert.equal(hooks.hooks.preToolUse.length, 2);
  assert.equal(hooks.hooks.preToolUse[0].matcher, "Shell");
  assert.equal(hooks.hooks.preToolUse[1].matcher, "Task");

  const cleanedMcp = unmergeMcpConfig(mcp);
  assert.equal(cleanedMcp.mcpServers.jev, undefined);
  assert.equal(cleanedMcp.mcpServers.other.command, "echo");

  const cleanedHooks = unmergeHooksConfig(hooks, root);
  assert.equal(cleanedHooks.hooks.preToolUse.length, 1);
  assert.equal(cleanedHooks.hooks.preToolUse[0].matcher, "Shell");
});
