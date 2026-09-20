import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractCandidates,
  isDocPath,
  pathAllowed,
  rankCandidates,
  selectKeep,
  skipPath,
  trimMcpOutput,
} from "../src/rerank.mjs";

test("extractCandidates reads grep hits and skips node_modules", () => {
  const found = extractCandidates(
    "src/hook.mjs:12:handlePreToolUse\nnode_modules/foo/index.js:1:skip\nD:\\\\VSProjects\\\\cursor-jev\\\\src\\\\store.mjs:4:sqlite",
  );
  const paths = found.map((item) => item.path);
  assert.equal(paths.includes("src/hook.mjs"), true);
  assert.equal(paths.some((path) => path.includes("node_modules")), false);
});

test("pathAllowed fail-opens on an empty list", () => {
  assert.equal(pathAllowed("README.md", []), true);
  assert.equal(pathAllowed("README.md", ["src/hook.mjs"]), false);
  assert.equal(pathAllowed("src/hook.mjs", ["src/hook.mjs"]), true);
});

test("skipPath drops URLs and binaries", () => {
  assert.equal(skipPath("https://example.com/foo.md"), true);
  assert.equal(skipPath("src/hook.mjs"), false);
  assert.equal(skipPath("logo.png"), true);
});

test("rankCandidates keeps must-Read scores only", async () => {
  const result = await rankCandidates(
    "fix the hook",
    [
      { path: "src/hook.mjs", snippet: "handlePreToolUse" },
      { path: "README.md", snippet: "install" },
    ],
    "key",
    {
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            c0: { type: "score", score: 2 },
            c1: { type: "score", score: 0 },
            focus: { type: "choice", choice: "c0", confidence: 0.88 },
          },
        }),
      }),
    },
  );
  assert.deepEqual(result.keep, ["src/hook.mjs"]);
});

test("selectKeep drops README and breaks ties with ask overlap", () => {
  assert.equal(isDocPath("README.md"), true);
  const keep = selectKeep(
    [
      { path: "src/identity.mjs", snippet: "serverIcons logo", score: 2 },
      { path: "src/hook.mjs", snippet: "handlePreToolUse Task", score: 2 },
      { path: "README.md", snippet: "install", score: 2 },
    ],
    { ask: "fix the Task hook" },
  );
  assert.deepEqual(keep, ["src/hook.mjs"]);
});

test("trimMcpOutput fail-opens when keep paths are missing", () => {
  const huge = `${"x".repeat(9000)}\nno files here`;
  assert.equal(trimMcpOutput(huge, ["src/hook.mjs"]), undefined);
});
