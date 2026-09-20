import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateGate, isRoutineShell, sanitizeGateState, validatePickOptions } from "../src/gates.mjs";
import { looksSecret, sanitizeAsk } from "../src/session.mjs";
import { noteFanout, readAllowlist, readUserAsk, mergeAllowlist, writeUserAsk } from "../src/store.mjs";

function answers(payload) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ answers: payload }),
  });
}

test("scope below threshold is skip", async () => {
  const verdict = await evaluateGate(
    "scope",
    { ask: "fix the hook", path: "README.md" },
    "key",
    { fetcher: answers({ in_scope: { type: "noul", noul: 0.12 } }) },
  );
  assert.equal(verdict.action, "skip");
});

test("scope at or above threshold is allow", async () => {
  const verdict = await evaluateGate(
    "scope",
    { ask: "fix the hook", path: "src/hook.mjs" },
    "key",
    { fetcher: answers({ in_scope: { type: "noul", noul: 0.8 } }) },
  );
  assert.equal(verdict.action, "allow");
});

test("split is split when compound is high", async () => {
  const verdict = await evaluateGate(
    "split",
    { ask: "fix auth and also redesign the landing page" },
    "key",
    { fetcher: answers({ compound: { type: "noul", noul: 0.9 } }) },
  );
  assert.equal(verdict.action, "split");
});

test("ready stop when ship is local and can_commit is high", async () => {
  const verdict = await evaluateGate(
    "ready",
    { ask: "rename a variable", summary: "renamed in hook.mjs" },
    "key",
    {
      fetcher: answers({
        ship: { type: "score", score: 2 },
        tests_cover: { type: "noul", noul: 0.8 },
        can_commit: { type: "noul", noul: 0.85 },
      }),
    },
  );
  assert.equal(verdict.action, "stop");
});

test("shell asks when destructive and not clearly requested", async () => {
  const verdict = await evaluateGate(
    "shell",
    { ask: "run tests", command: "git reset --hard" },
    "key",
    {
      fetcher: answers({
        destructive: { type: "noul", noul: 0.95 },
        matches_ask: { type: "noul", noul: 0.1 },
      }),
    },
  );
  assert.equal(verdict.action, "ask");
});

test("missing key fail-opens", async () => {
  const verdict = await evaluateGate("scope", { ask: "x" }, "");
  assert.equal(verdict.action, "allow");
});

test("pick requires 2-8 string options", () => {
  assert.match(validatePickOptions({ a: "one" }), /2–8/);
  assert.equal(validatePickOptions({ a: "one", b: "two" }), null);
});

test("sanitizeGateState keeps a files array", () => {
  const clean = sanitizeGateState({
    ask: "fix hook",
    files: [{ id: "c0", path: "src/hook.mjs", snippet: "handlePreToolUse" }],
  });
  assert.equal(Array.isArray(clean.files), true);
  assert.equal(clean.files[0].path, "src/hook.mjs");
});

test("sanitizeGateState drops secret strings", () => {
  const clean = sanitizeGateState({ ask: "fix hook", preview: "TYPESAFE_API_KEY=apikey_secret" });
  assert.equal(clean.ask, "fix hook");
  assert.equal(clean.preview, undefined);
});

test("routine shell commands skip the model", () => {
  assert.equal(isRoutineShell("git status"), true);
  assert.equal(isRoutineShell("git reset --hard"), false);
  assert.equal(isRoutineShell("rm -rf /"), false);
});

test("sqlite store keeps asks and fanout", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-jev-store-"));
  try {
    await writeUserAsk("conv-1", "Fix the Task hook only", home);
    assert.equal(await readUserAsk("conv-1", home), "Fix the Task hook only");
    assert.equal(await noteFanout("gen-1", home, 1_000), 1);
    assert.equal(await noteFanout("gen-1", home, 1_100), 2);
    await mergeAllowlist("conv-1", ["src/hook.mjs"], home);
    assert.deepEqual(await readAllowlist("conv-1", home), ["src/hook.mjs"]);
    assert.equal(await readUserAsk("conv-1", home), "Fix the Task hook only");
    assert.equal(await writeUserAsk("conv-1", "Bearer abc.def", home), "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("sanitizeAsk drops secrets", () => {
  assert.equal(sanitizeAsk("Bearer abc.def"), "");
  assert.equal(looksSecret("apikey_abc"), true);
});
