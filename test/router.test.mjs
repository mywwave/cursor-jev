import assert from "node:assert/strict";
import { test } from "node:test";
import { routeTask, shouldContinue } from "../src/router.mjs";
import { CONFIDENCE_THRESHOLD, FALLBACK_AGENT } from "../src/roles.mjs";

function jsonResponse(answers, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ model: "jev-1.13.0", answers }),
  };
}

function answers({ choice = "explore", confidence = 0.9, noul = 0.95 } = {}) {
  return {
    role: {
      type: "choice",
      choice,
      confidence,
      probabilities: { [choice]: 1 },
    },
    needs_specialist: { type: "noul", noul },
  };
}

test("missing key fails open to requested type", async () => {
  const decision = await routeTask("find auth middleware", undefined, {
    requestedType: "explore",
  });
  assert.equal(decision.status, "unavailable");
  assert.equal(decision.agent, "explore");
});

test("empty task fails open", async () => {
  const decision = await routeTask("   ", "key", { requestedType: "explore" });
  assert.equal(decision.status, "unavailable");
  assert.equal(decision.agent, "explore");
});

test("oversized task fails open to generalPurpose when requested is unknown", async () => {
  const decision = await routeTask("x".repeat(12001), "key", { requestedType: "nope" });
  assert.equal(decision.status, "unavailable");
  assert.equal(decision.agent, FALLBACK_AGENT);
});

test("HTTP error fails open", async () => {
  const decision = await routeTask("find auth", "key", {
    requestedType: "explore",
    fetcher: async () => jsonResponse({}, 500),
  });
  assert.equal(decision.status, "unavailable");
  assert.equal(decision.agent, "explore");
  assert.match(decision.reason, /HTTP 500/);
});

test("timeout fails open", async () => {
  const decision = await routeTask("find auth", "key", {
    requestedType: "explore",
    fetcher: async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    },
  });
  assert.equal(decision.status, "unavailable");
  assert.equal(decision.agent, "explore");
});

test("invalid choice is uncertain", async () => {
  const decision = await routeTask("find auth", "key", {
    fetcher: async () =>
      jsonResponse({
        role: { type: "choice", choice: "not-a-role", confidence: 0.99 },
        needs_specialist: { type: "noul", noul: 1 },
      }),
  });
  assert.equal(decision.status, "uncertain");
  assert.equal(decision.agent, FALLBACK_AGENT);
});

test("confidence below threshold keeps original type", async () => {
  const decision = await routeTask("maybe explore?", "key", {
    requestedType: "generalPurpose",
    fetcher: async () => jsonResponse(answers({ confidence: CONFIDENCE_THRESHOLD - 0.01 })),
  });
  assert.equal(decision.status, "uncertain");
  assert.equal(decision.agent, "generalPurpose");
  assert.equal(decision.confidence, CONFIDENCE_THRESHOLD - 0.01);
});

test("confidence at threshold routes when specialist noul is high", async () => {
  const decision = await routeTask("search the repo for the auth middleware", "key", {
    requestedType: "generalPurpose",
    fetcher: async () => jsonResponse(answers({ choice: "explore", confidence: CONFIDENCE_THRESHOLD, noul: 0.9 })),
  });
  assert.equal(decision.status, "routed");
  assert.equal(decision.agent, "explore");
});

test("low specialist noul keeps generalPurpose", async () => {
  const decision = await routeTask("do several unrelated edits", "key", {
    requestedType: "generalPurpose",
    fetcher: async () => jsonResponse(answers({ choice: "explore", confidence: 0.95, noul: 0.2 })),
  });
  assert.equal(decision.status, "uncertain");
  assert.equal(decision.agent, "generalPurpose");
});

test("confident generalPurpose with low noul is routed not blocked", async () => {
  const decision = await routeTask("implement a feature across backend and UI", "key", {
    requestedType: "generalPurpose",
    fetcher: async () =>
      jsonResponse(answers({ choice: "generalPurpose", confidence: 0.99, noul: 0.2 })),
  });
  assert.equal(decision.status, "routed");
  assert.equal(decision.agent, "generalPurpose");
});

test("does not switch to bugbot unless parent requested it", async () => {
  const decision = await routeTask("review this diff", "key", {
    requestedType: "generalPurpose",
    fetcher: async () => jsonResponse(answers({ choice: "bugbot", confidence: 0.99, noul: 0.99 })),
  });
  assert.equal(decision.status, "uncertain");
  assert.equal(decision.agent, "generalPurpose");
  assert.match(decision.reason, /explicit/);
});

test("allows bugbot when parent already requested it", async () => {
  const decision = await routeTask("Bugbot review of local changes", "key", {
    requestedType: "bugbot",
    fetcher: async () => jsonResponse(answers({ choice: "bugbot", confidence: 0.99, noul: 0.99 })),
  });
  assert.equal(decision.status, "routed");
  assert.equal(decision.agent, "bugbot");
});

test("does not switch to security-review unless requested", async () => {
  const decision = await routeTask("look at auth", "key", {
    requestedType: "explore",
    fetcher: async () =>
      jsonResponse(answers({ choice: "security-review", confidence: 0.99, noul: 0.99 })),
  });
  assert.equal(decision.status, "uncertain");
  assert.equal(decision.agent, "explore");
});

test("returns pace and needsDelegate from the same TypeSafe call", async () => {
  const decision = await routeTask("rename a local variable", "key", {
    requestedType: "generalPurpose",
    fetcher: async () =>
      jsonResponse({
        ...answers({ choice: "generalPurpose", confidence: 0.95, noul: 0.1 }),
        pace: { type: "choice", choice: "fast", confidence: 0.9 },
        needs_delegate: { type: "noul", noul: 0.15 },
      }),
  });
  assert.equal(decision.status, "routed");
  assert.equal(decision.pace, "fast");
  assert.equal(decision.needsDelegate, 0.15);
});

test("shouldContinue is false when noul is below the stop threshold", async () => {
  const verdict = await shouldContinue("auth is in src/auth.mjs", "key", {
    fetcher: async () =>
      jsonResponse({ continue_needed: { type: "noul", noul: 0.2 } }),
  });
  assert.equal(verdict.continue, false);
  assert.equal(verdict.noul, 0.2);
});
