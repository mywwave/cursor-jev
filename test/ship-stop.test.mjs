import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleBeforeShellExecution,
  handleStop,
  JEV_REQUIRED_SHELL_MESSAGE,
  NOT_READY_FOLLOWUP,
  READY_STOP_CONTEXT,
} from "../src/hook.mjs";
import { writeWorkflowReceipt } from "../src/store.mjs";

test("ship-critical shell fails closed without TypeSafe key", async () => {
  const result = await handleBeforeShellExecution(
    { command: "git push origin HEAD:main" },
    { key: "" },
  );
  assert.equal(result.permission, "deny");
  assert.equal(result.agent_message, JEV_REQUIRED_SHELL_MESSAGE);
});

test("ship-critical shell with conversation still needs receipt then key", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-ship-"));
  try {
    const denied = await handleBeforeShellExecution(
      {
        conversation_id: "c-ship",
        generation_id: "g-ship",
        command: "git commit -m msg",
      },
      { home, key: "" },
    );
    assert.equal(denied.permission, "deny");
    assert.match(String(denied.agent_message ?? ""), /workflow receipt/i);

    await writeWorkflowReceipt(
      "c-ship",
      "g-ship",
      { workflow_choice: "SHIP", workflow_owner: "jev", reason: "test", confidence: 1 },
      home,
    );
    const still = await handleBeforeShellExecution(
      {
        conversation_id: "c-ship",
        generation_id: "g-ship",
        command: "git commit -m msg",
      },
      { home, key: "" },
    );
    assert.equal(still.permission, "deny");
    assert.equal(still.agent_message, JEV_REQUIRED_SHELL_MESSAGE);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stop readiness followup when incomplete", async () => {
  const result = await handleStop(
    {
      status: "completed",
      conversation_id: "c-stop",
      response: "partial work",
    },
    {
      key: "test-key",
      userAsk: "implement the full fabric",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            ship: { type: "score", score: 0 },
            tests_cover: { type: "noul", noul: 0.2 },
            can_commit: { type: "noul", noul: 0.2 },
          },
        }),
      }),
    },
  );
  assert.equal(result.followup_message, NOT_READY_FOLLOWUP);
});

test("stop readiness allows finish when ready", async () => {
  const result = await handleStop(
    {
      status: "completed",
      conversation_id: "c-stop2",
      response: "done",
    },
    {
      key: "test-key",
      userAsk: "rename a variable",
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            ship: { type: "score", score: 2 },
            tests_cover: { type: "noul", noul: 0.9 },
            can_commit: { type: "noul", noul: 0.9 },
          },
        }),
      }),
    },
  );
  assert.equal(result.additional_context, READY_STOP_CONTEXT);
  assert.equal(result.followup_message, undefined);
});
