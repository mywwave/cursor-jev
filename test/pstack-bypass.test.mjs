import test from "node:test";
import assert from "node:assert/strict";
import {
  handlePostToolUse,
  handlePreToolUse,
  isExplicitOrchestratedTask,
  isShipCriticalShell,
  PSTACK_BYPASS_CONTEXT,
  STOP_CONTEXT,
} from "../src/hook.mjs";

test("explicit model bypasses Jev Task routing", () => {
  assert.equal(
    isExplicitOrchestratedTask({ model: "composer-2.5-fast", subagent_type: "generalPurpose", prompt: "review" }),
    true,
  );
});

test("poteto-mode marker bypasses Jev Task routing", () => {
  assert.equal(
    isExplicitOrchestratedTask({
      subagent_type: "generalPurpose",
      prompt: "Jev bypass: pstack\n/reflect capture lessons from this session",
    }),
    true,
  );
  assert.equal(
    isExplicitOrchestratedTask({
      subagent_type: "poteto-agent",
      prompt: "implement the feature",
    }),
    true,
  );
});

test("ambiguous Task is not bypassed", () => {
  assert.equal(
    isExplicitOrchestratedTask({
      subagent_type: "generalPurpose",
      prompt: "fix the footer link",
    }),
    false,
  );
});

test("ship shells are critical", () => {
  assert.equal(isShipCriticalShell("git push origin HEAD:main"), true);
  assert.equal(isShipCriticalShell("git commit -m msg"), true);
  assert.equal(isShipCriticalShell("git status"), false);
});

test("preToolUse preserves explicit pstack Task without rewrite", async () => {
  const result = await handlePreToolUse({
    // no conversation_id → receipt gate fail-open; model pin still bypasses routing
    tool_name: "Task",
    tool_input: {
      subagent_type: "generalPurpose",
      model: "composer-2.5-fast",
      prompt: "/reflect panel reviewer A",
    },
  });
  assert.equal(result.permission, "allow");
  assert.equal(result.updated_input, undefined);
  assert.match(String(result.additional_context ?? ""), /preserved/i);
});

test("PSTACK receipt alone preserves Task without model pin", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeWorkflowReceipt } = await import("../src/store.mjs");
  const home = await mkdtemp(join(tmpdir(), "jev-ps-"));
  try {
    await writeWorkflowReceipt(
      "conv",
      "gen",
      { workflow_choice: "PSTACK", workflow_owner: "pstack", reason: "unit", confidence: 1 },
      home,
    );
    const result = await handlePreToolUse(
      {
        conversation_id: "conv",
        generation_id: "gen",
        tool_name: "Task",
        tool_input: {
          subagent_type: "generalPurpose",
          prompt: "run arena panel",
        },
      },
      { home, key: "" },
    );
    assert.equal(result.permission, "allow");
    assert.equal(result.updated_input, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("postToolUse does not STOP_CONTEXT-steer under PSTACK receipt", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeWorkflowReceipt } = await import("../src/store.mjs");
  const home = await mkdtemp(join(tmpdir(), "jev-ps-post-"));
  try {
    await writeWorkflowReceipt(
      "conv-post",
      "gen-post",
      { workflow_choice: "PSTACK", workflow_owner: "pstack", reason: "unit", confidence: 1 },
      home,
    );
    const result = await handlePostToolUse(
      {
        conversation_id: "conv-post",
        generation_id: "gen-post",
        tool_name: "Task",
        tool_input: { subagent_type: "generalPurpose", prompt: "arena runner A" },
        tool_output: "panel partial result — enough for ordinary stop steer",
      },
      {
        home,
        key: "fake",
        fetcher: async () => ({
          ok: true,
          json: async () => ({
            answers: {
              continue: { type: "noul", noul: false, confidence: 0.9 },
            },
          }),
        }),
      },
    );
    assert.notEqual(result.additional_context, STOP_CONTEXT);
    assert.match(String(result.additional_context ?? ""), /pstack owns aggregation/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("postToolUse preserves explicit orchestrated Task without STOP_CONTEXT", async () => {
  const result = await handlePostToolUse(
    {
      tool_name: "Task",
      tool_input: {
        subagent_type: "generalPurpose",
        model: "composer-2.5-fast",
        prompt: "/reflect panel reviewer",
      },
      tool_output: "enough text that ordinary continue would stop",
    },
    {
      key: "fake",
      fetcher: async () => ({
        ok: true,
        json: async () => ({
          answers: {
            continue: { type: "noul", noul: false, confidence: 0.9 },
          },
        }),
      }),
    },
  );
  assert.equal(result.additional_context, PSTACK_BYPASS_CONTEXT);
});
