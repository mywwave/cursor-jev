#!/usr/bin/env node
/**
 * Agent-facing context pick: reads JSON { ask, catalog:[{id,title,path,freshness,blurb}] } from stdin.
 */
import { resolveKey } from "../src/key.mjs";
import { pickContextSources } from "../src/workflow.mjs";

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
const result = await pickContextSources(input.ask ?? "", input.catalog ?? [], key);
process.stdout.write(`${JSON.stringify(result)}\n`);
