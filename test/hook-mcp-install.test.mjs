import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAfterAgentResponse, handleBeforeShellExecution, handleBeforeSubmitPrompt, handlePostToolUse, handlePreToolUse, INLINE_MESSAGE, NESTED_MESSAGE, FANOUT_MESSAGE, STOP_CONTEXT, SCOPE_MESSAGE, SPLIT_CONTEXT, ASK_SHELL_MESSAGE, READY_STOP_CONTEXT, READ_DENY_MESSAGE } from "../src/hook.mjs";
import { createFramer, encodeMessage, handleRpc } from "../src/mcp.mjs";
import { mergeHooksConfig, mergeMcpConfig, unmergeHooksConfig, unmergeMcpConfig } from "../src/install.mjs";

function fetcherFor(choice, confidence = 0.92, noul = 0.9, extra = {}) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      answers: {
        role: { type: "choice", choice, confidence, probabilities: { [choice]: 1 } },
        needs_specialist: { type: "noul", noul },
        pace: extra.pace ? { type: "choice", choice: extra.pace, confidence: 0.9 } : undefined,
        needs_delegate: extra.needsDelegate != null ? { type: "noul", noul: extra.needsDelegate } : undefined,
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
  assert.match(result.updated_input.prompt, /^Jev routed: explore status=routed confidence=0\.92/);
  assert.match(result.updated_input.prompt, /Jev speed:/);
  assert.match(result.updated_input.prompt, /Find the auth middleware$/);
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

test("hook denies nested Task from a background agent", async () => {
  const result = await handlePreToolUse(
    {
      tool_name: "Task",
      is_background_agent: true,
      tool_input: { subagent_type: "explore", prompt: "search again" },
    },
    { key: "key", fetcher: fetcherFor("explore") },
  );
  assert.equal(result.permission, "deny");
  assert.equal(result.agent_message, NESTED_MESSAGE);
});

test("hook denies a generalPurpose Task that Jev scores as inline", async () => {
  const result = await handlePreToolUse(
    {
      tool_name: "Task",
      tool_input: { subagent_type: "generalPurpose", prompt: "rename one variable" },
    },
    { key: "key", fetcher: fetcherFor("generalPurpose", 0.95, 0.1, { pace: "fast", needsDelegate: 0.12 }) },
  );
  assert.equal(result.permission, "deny");
  assert.equal(result.agent_message, INLINE_MESSAGE);
});

test("hook still routes explore even when delegate noul is low", async () => {
  const result = await handlePreToolUse(
    {
      tool_name: "Task",
      tool_input: { subagent_type: "generalPurpose", prompt: "Find the auth middleware" },
    },
    { key: "key", fetcher: fetcherFor("explore", 0.95, 0.9, { pace: "fast", needsDelegate: 0.2 }) },
  );
  assert.equal(result.permission, "allow");
  assert.equal(result.updated_input.subagent_type, "explore");
});

test("hook denies extra Task fan-out in the same generation", async () => {
  const result = await handlePreToolUse(
    {
      tool_name: "Task",
      generation_id: "gen-1",
      tool_input: { subagent_type: "generalPurpose", prompt: "also do this" },
    },
    {
      key: "key",
      fetcher: fetcherFor("explore", 0.95, 0.9, { pace: "standard", needsDelegate: 0.4 }),
      noteFanout: async () => 2,
    },
  );
  assert.equal(result.permission, "deny");
  assert.equal(result.agent_message, FANOUT_MESSAGE);
});

test("postToolUse tells the parent to stop when Jev says the result is enough", async () => {
  const result = await handlePostToolUse(
    {
      hook_event_name: "postToolUse",
      tool_name: "Task",
      tool_input: { prompt: "find auth" },
      tool_output: "Auth lives in src/auth.mjs",
    },
    {
      key: "key",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { continue_needed: { type: "noul", noul: 0.1 } } }),
      }),
    },
  );
  assert.equal(result.additional_context, STOP_CONTEXT);
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
    ["jev_auth", "jev_route", "jev_ask", "jev_judge"],
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
  assert.equal(hooks.hooks.preToolUse[1].matcher, "Task|Write|StrReplace|Delete|Read");
  assert.equal(hooks.hooks.postToolUse[0].matcher, "Task|Grep|Glob|SemanticSearch|MCP:codegraph_explore");
  assert.equal(hooks.hooks.postToolUse.length, 1);
  assert.equal(hooks.hooks.postToolUse[0].timeout, 5);
  assert.equal(hooks.hooks.beforeSubmitPrompt.length, 1);
  assert.equal(hooks.hooks.beforeShellExecution.length, 1);
  assert.equal(hooks.hooks.afterAgentResponse.length, 1);

  const cleanedMcp = unmergeMcpConfig(mcp);
  assert.equal(cleanedMcp.mcpServers.jev, undefined);
  assert.equal(cleanedMcp.mcpServers.other.command, "echo");

  const cleanedHooks = unmergeHooksConfig(hooks, root);
  assert.equal(cleanedHooks.hooks.preToolUse.length, 1);
  assert.equal(cleanedHooks.hooks.preToolUse[0].matcher, "Shell");
  assert.equal(cleanedHooks.hooks.postToolUse.length, 0);
});

test("hook denies an out-of-scope Write", async () => {
  const result = await handlePreToolUse(
    {
      tool_name: "Write",
      conversation_id: "c1",
      tool_input: { path: "README.md", contents: "unrelated rewrite" },
    },
    {
      key: "key",
      userAsk: "fix the Task hook",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { in_scope: { type: "noul", noul: 0.1 } } }),
      }),
    },
  );
  assert.equal(result.permission, "deny");
  assert.equal(result.agent_message, SCOPE_MESSAGE);
});

test("beforeSubmitPrompt stores the ask and warns on compound requests", async () => {
  let stored;
  const result = await handleBeforeSubmitPrompt(
    { hook_event_name: "beforeSubmitPrompt", conversation_id: "c1", prompt: "fix auth and redesign the site" },
    {
      key: "key",
      writeUserAsk: async (id, ask) => {
        stored = { id, ask };
        return ask;
      },
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { compound: { type: "noul", noul: 0.92 } } }),
      }),
    },
  );
  assert.equal(stored.id, "c1");
  assert.equal(result.additional_context, SPLIT_CONTEXT);
});

test("beforeShellExecution asks on destructive unmatched commands", async () => {
  const result = await handleBeforeShellExecution(
    { hook_event_name: "beforeShellExecution", command: "git reset --hard" },
    {
      key: "key",
      userAsk: "run the unit tests",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            destructive: { type: "noul", noul: 0.97 },
            matches_ask: { type: "noul", noul: 0.05 },
          },
        }),
      }),
    },
  );
  assert.equal(result.permission, "ask");
  assert.equal(result.agent_message, ASK_SHELL_MESSAGE);
});

test("beforeShellExecution allows git status without calling Jev", async () => {
  let called = false;
  const result = await handleBeforeShellExecution(
    { hook_event_name: "beforeShellExecution", command: "git status" },
    {
      key: "key",
      fetcher: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({ answers: {} }) };
      },
    },
  );
  assert.equal(result.permission, "allow");
  assert.equal(called, false);
});

test("afterAgentResponse tells the agent to stop when ready", async () => {
  const result = await handleAfterAgentResponse(
    { hook_event_name: "afterAgentResponse", text: "Renamed the variable in hook.mjs" },
    {
      key: "key",
      userAsk: "rename the variable",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            ship: { type: "score", score: 2 },
            tests_cover: { type: "noul", noul: 0.8 },
            can_commit: { type: "noul", noul: 0.9 },
          },
        }),
      }),
    },
  );
  assert.equal(result.additional_context, READY_STOP_CONTEXT);
});

test("MCP jev_judge pick returns a choice", async () => {
  const result = await handleRpc(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "jev_judge",
        arguments: {
          kind: "pick",
          state: { ask: "where is auth", options: { a: "src/auth.mjs", b: "src/cli.mjs" } },
        },
      },
    },
    {
      key: "key",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { pick: { type: "choice", choice: "a", confidence: 0.9 } } }),
      }),
    },
  );
  assert.equal(result.result.isError, undefined);
  assert.match(result.result.content[0].text, /"pick":"a"/);
});

test("postToolUse Grep reranks hits without dropping Task stop behavior", async () => {
  const merged = [];
  const result = await handlePostToolUse(
    {
      hook_event_name: "postToolUse",
      conversation_id: "c1",
      tool_name: "Grep",
      tool_output: "src/hook.mjs:10:handlePreToolUse\nREADME.md:1:cursor-jev\nsrc/store.mjs:4:sqlite",
    },
    {
      key: "key",
      userAsk: "fix the Task hook",
      mergeAllowlist: async (_id, paths) => {
        merged.push(...paths);
        return paths;
      },
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            c0: { type: "score", score: 2 },
            c1: { type: "score", score: 0 },
            c2: { type: "score", score: 0 },
            focus: { type: "choice", choice: "c0", confidence: 0.9 },
          },
        }),
      }),
    },
  );
  assert.match(result.additional_context, /src\/hook\.mjs/);
  assert.equal(merged.includes("src/hook.mjs"), true);
  assert.equal(merged.includes("README.md"), false);
});

test("Read of a file outside the allowlist is denied", async () => {
  const result = await handlePreToolUse(
    { tool_name: "Read", conversation_id: "c1", tool_input: { path: "README.md" } },
    { readAllowlist: async () => ["src/hook.mjs"] },
  );
  assert.equal(result.permission, "deny");
  assert.equal(result.agent_message, READ_DENY_MESSAGE);
});

test("Read is allowed when no allowlist exists yet", async () => {
  const result = await handlePreToolUse(
    { tool_name: "Read", conversation_id: "c1", tool_input: { path: "README.md" } },
    { readAllowlist: async () => [] },
  );
  assert.equal(result.permission, "allow");
});

