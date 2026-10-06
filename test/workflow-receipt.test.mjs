import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleBeforeSubmitPrompt,
  handlePreToolUse,
  isExplicitOrchestratedTask,
} from "../src/hook.mjs";
import { readWorkflowReceipt, writeWorkflowReceipt } from "../src/store.mjs";
import {
  heuristicWorkflow,
  isPstackOwnedReceipt,
  requiresWorkflowReceipt,
  WORKFLOW_REQUIRED_MESSAGE,
} from "../src/workflow.mjs";

test("heuristic detects pstack and ship", () => {
  assert.equal(heuristicWorkflow("Jev bypass: pstack\n/poteto-mode").workflow_choice, "PSTACK");
  assert.equal(heuristicWorkflow("please commit and push").workflow_choice, "SHIP");
  assert.equal(heuristicWorkflow("research how hooks work").workflow_choice, "RESEARCH");
});

test("beforeSubmitPrompt stores workflow receipt", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-wf-"));
  try {
    const result = await handleBeforeSubmitPrompt(
      {
        conversation_id: "c1",
        generation_id: "g1",
        prompt: "/poteto-mode implement fabric",
      },
      { home, key: "" },
    );
    const receipt = await readWorkflowReceipt("c1", "g1", home);
    assert.equal(receipt.workflow_choice, "PSTACK");
    assert.equal(receipt.workflow_owner, "pstack");
    assert.match(String(result.additional_context ?? ""), /Jev workflow:\s*PSTACK/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Write without receipt is denied when conversation known", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-wf-"));
  try {
    const result = await handlePreToolUse(
      {
        conversation_id: "c-deny",
        generation_id: "g-deny",
        tool_name: "Write",
        tool_input: { path: "x.mjs", contents: "hi" },
      },
      { home, key: "" },
    );
    assert.equal(result.permission, "deny");
    assert.match(String(result.agent_message ?? ""), /workflow receipt/i);
    assert.equal(result.agent_message, WORKFLOW_REQUIRED_MESSAGE);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Read without receipt is soft-allowed (allowlist may still deny)", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-wf-"));
  try {
    const result = await handlePreToolUse(
      {
        conversation_id: "c-read",
        tool_name: "Read",
        tool_input: { path: "README.md" },
      },
      { home, key: "", readAllowlist: async () => ["README.md"] },
    );
    assert.equal(result.permission, "allow");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("PSTACK receipt bypasses Task rewrite like explicit orchestration", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-wf-"));
  try {
    await writeWorkflowReceipt(
      "c-ps",
      "g-ps",
      {
        workflow_choice: "PSTACK",
        workflow_owner: "pstack",
        reason: "test",
        confidence: 0.9,
      },
      home,
    );
    const receipt = await readWorkflowReceipt("c-ps", "g-ps", home);
    assert.equal(isPstackOwnedReceipt(receipt), true);
    assert.equal(
      isExplicitOrchestratedTask(
        { subagent_type: "generalPurpose", prompt: "fix footer" },
        receipt,
      ),
      true,
    );
    const result = await handlePreToolUse(
      {
        conversation_id: "c-ps",
        generation_id: "g-ps",
        tool_name: "Task",
        tool_input: {
          subagent_type: "generalPurpose",
          prompt: "fix footer",
        },
      },
      { home, key: "" },
    );
    assert.equal(result.permission, "allow");
    assert.equal(result.updated_input, undefined);
    assert.match(String(result.additional_context ?? ""), /preserved/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ambiguous Task still not bypassed without receipt markers", () => {
  assert.equal(
    isExplicitOrchestratedTask({
      subagent_type: "generalPurpose",
      prompt: "fix the footer link",
    }),
    false,
  );
  assert.equal(requiresWorkflowReceipt("Write", { path: "a" }), true);
  assert.equal(requiresWorkflowReceipt("Read", { path: "a" }), false);
});
