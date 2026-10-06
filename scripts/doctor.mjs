#!/usr/bin/env node
/**
 * pstack↔Jev fabric doctor — automated checks + manual live checklist.
 * Exit non-zero if automated checks fail.
 */
import { spawnSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function ok(msg) {
  console.log(`PASS  ${msg}`);
}
function fail(msg) {
  console.error(`FAIL  ${msg}`);
}
function info(msg) {
  console.log(`INFO  ${msg}`);
}

async function readPin() {
  const pinPath = join(root, "build-pin.json");
  try {
    return JSON.parse(await readFile(pinPath, "utf8"));
  } catch {
    return null;
  }
}

async function gitSha() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) return "";
  return String(r.stdout ?? "").trim();
}

async function cliPresent() {
  const cli = join(root, "bin", "cli.mjs");
  try {
    await access(cli);
    return cli;
  } catch {
    return null;
  }
}

function runUnit(pattern) {
  const r = spawnSync(process.execPath, ["--test", ...pattern], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const MANUAL = [
  "1. /poteto-mode Task with pinned model — Jev does not rewrite subagent_type",
  "2. /reflect multi-model panel — fan-out not suppressed by Jev",
  "3. /interrogate reviewers — models preserved",
  "4. /arena runners — panel aggregation owned by pstack, not Jev stop-steer",
  "5. Ordinary Task without markers — Jev may inline/deny/rewrite",
  "6. Ship (commit/push) without TypeSafe key — deny fail-closed",
];

let failures = 0;

const cli = await cliPresent();
if (cli) ok(`Jev CLI reachable: ${cli}`);
else {
  fail("Jev CLI missing at bin/cli.mjs");
  failures++;
}

const pin = await readPin();
const sha = await gitSha();
if (!pin) {
  fail("build-pin.json missing");
  failures++;
} else if (!pin.sha || pin.sha === "PENDING") {
  fail("build-pin.json sha is PENDING — set after fabric commit");
  failures++;
} else if (sha) {
  const exact =
    pin.sha === sha ||
    pin.sha.startsWith(sha.slice(0, 7)) ||
    sha.startsWith(String(pin.sha).slice(0, 7));
  const anc = spawnSync("git", ["merge-base", "--is-ancestor", String(pin.sha), "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (exact || anc.status === 0) {
    ok(`Pin SHA ${String(pin.sha).slice(0, 12)} is HEAD or ancestor of HEAD (${sha.slice(0, 12)})`);
  } else {
    fail(`Pin SHA mismatch: pin=${pin.sha} HEAD=${sha}`);
    failures++;
  }
} else {
  info("git unavailable for SHA compare; pin present");
}

const suites = [
  ["pstack bypass", ["test/pstack-bypass.test.mjs"]],
  ["ship fail-closed + stop readiness", ["test/ship-stop.test.mjs"]],
  ["workflow receipt required", ["test/workflow-receipt.test.mjs"]],
  ["gates (ambiguous routing helpers)", ["test/gates.test.mjs"]],
];

for (const [label, files] of suites) {
  const result = runUnit(files);
  if (result.status === 0) ok(`Unit: ${label}`);
  else {
    fail(`Unit: ${label}`);
    console.error(result.out.slice(-2000));
    failures++;
  }
}

// Ambiguous Task still routed (not bypass) — structural assert without network.
try {
  const { isExplicitOrchestratedTask } = await import(pathToFileURL(join(root, "src", "hook.mjs")).href);
  if (
    isExplicitOrchestratedTask({
      subagent_type: "generalPurpose",
      prompt: "fix the footer link",
    }) === false
  ) {
    ok("Ambiguous Task is not pstack-bypassed");
  } else {
    fail("Ambiguous Task incorrectly bypassed");
    failures++;
  }
} catch (err) {
  fail(`Ambiguous Task check errored: ${err?.message ?? err}`);
  failures++;
}

console.log("");
console.log("Manual live proofs (not required in CI):");
for (const line of MANUAL) console.log(`  ${line}`);

if (failures) {
  console.error(`\nDoctor FAILED (${failures} check(s)).`);
  process.exit(1);
}
console.log("\nDoctor PASSED automated checks.");
process.exit(0);
