#!/usr/bin/env node
/**
 * Agent-facing evidence pick: reads JSON { ask } from stdin.
 * Choices: GSC|GA4|SERP|repo|orders|authority|none — not page create/delete/pricing.
 */
import { resolveKey } from "../src/key.mjs";
import { pickEvidenceSources } from "../src/workflow.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8");
let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  input = {};
}
const key = await resolveKey({});
const result = await pickEvidenceSources(input.ask ?? "", key);
process.stdout.write(`${JSON.stringify(result)}\n`);
