import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FANOUT_WINDOW_MS, RERANK_ALLOW_MAX, USER_ASK_MAX } from "./roles.mjs";
import { sanitizeAsk } from "./session.mjs";

export const STORE_FILE_NAME = "cursor-jev.sqlite";

export function storePath(home = homedir()) {
  return join(home ?? homedir(), ".cursor", STORE_FILE_NAME);
}

function openStore(home) {
  const root = home ?? homedir();
  mkdirSync(join(root, ".cursor"), { recursive: true });
  const db = new DatabaseSync(storePath(root));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS asks (
      conversation_id TEXT PRIMARY KEY,
      user_ask TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fanout (
      generation_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reads (
      conversation_id TEXT PRIMARY KEY,
      paths TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      conversation_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      workflow_choice TEXT NOT NULL,
      workflow_owner TEXT NOT NULL,
      reason TEXT,
      confidence REAL,
      at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, generation_id)
    );
  `);
  return db;
}

function withStore(home, fn) {
  const db = openStore(home);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export async function writeUserAsk(conversationId, ask, home) {
  const id = String(conversationId ?? "").trim();
  const value = sanitizeAsk(ask, USER_ASK_MAX);
  if (!id || !value) return "";
  withStore(home, (db) => {
    db.prepare(
      "INSERT INTO asks(conversation_id, user_ask, at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET user_ask = excluded.user_ask, at = excluded.at",
    ).run(id, value, Date.now());
  });
  return value;
}

export async function readUserAsk(conversationId, home) {
  const id = String(conversationId ?? "").trim();
  if (!id) return "";
  const row = withStore(home, (db) =>
    db.prepare("SELECT user_ask FROM asks WHERE conversation_id = ?").get(id),
  );
  return typeof row?.user_ask === "string" ? row.user_ask : "";
}

export async function noteFanout(generationId, home, now = Date.now()) {
  const id = String(generationId ?? "").trim();
  if (!id) return 1;
  return withStore(home, (db) => {
    db.prepare("DELETE FROM fanout WHERE at < ?").run(now - FANOUT_WINDOW_MS);
    db.prepare(
      "INSERT INTO fanout(generation_id, count, at) VALUES (?, 1, ?) ON CONFLICT(generation_id) DO UPDATE SET count = count + 1, at = excluded.at",
    ).run(id, now);
    const row = db.prepare("SELECT count FROM fanout WHERE generation_id = ?").get(id);
    return Number(row?.count) || 1;
  });
}

function parsePaths(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function readAllowlist(conversationId, home) {
  const id = String(conversationId ?? "").trim();
  if (!id) return [];
  const row = withStore(home, (db) => db.prepare("SELECT paths FROM reads WHERE conversation_id = ?").get(id));
  return parsePaths(row?.paths);
}

export async function mergeAllowlist(conversationId, paths, home) {
  const id = String(conversationId ?? "").trim();
  const extra = [...new Set((paths ?? []).map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!id || !extra.length) return readAllowlist(id, home);
  return withStore(home, (db) => {
    const row = db.prepare("SELECT paths FROM reads WHERE conversation_id = ?").get(id);
    const prev = parsePaths(row?.paths);
    const next = [...new Set([...prev, ...extra])].slice(0, RERANK_ALLOW_MAX);
    db.prepare(
      "INSERT INTO reads(conversation_id, paths, at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET paths = excluded.paths, at = excluded.at",
    ).run(id, JSON.stringify(next), Date.now());
    return next;
  });
}

function normalizeReceipt(row) {
  if (!row) return null;
  return {
    conversation_id: String(row.conversation_id ?? ""),
    generation_id: String(row.generation_id ?? ""),
    workflow_choice: String(row.workflow_choice ?? ""),
    workflow_owner: String(row.workflow_owner ?? ""),
    reason: typeof row.reason === "string" ? row.reason : "",
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    at: Number(row.at) || 0,
  };
}

/**
 * Persist a workflow receipt for conversation+generation.
 */
export async function writeWorkflowReceipt(conversationId, generationId, receipt, home) {
  const cid = String(conversationId ?? "").trim();
  const gid = String(generationId ?? cid).trim() || cid;
  if (!cid || !gid || !receipt?.workflow_choice) return null;
  const choice = String(receipt.workflow_choice);
  const owner = String(receipt.workflow_owner ?? "jev");
  const reason = String(receipt.reason ?? "").slice(0, 500);
  const confidence =
    typeof receipt.confidence === "number" && Number.isFinite(receipt.confidence)
      ? receipt.confidence
      : null;
  const at = Date.now();
  withStore(home, (db) => {
    db.prepare(
      `INSERT INTO workflows(conversation_id, generation_id, workflow_choice, workflow_owner, reason, confidence, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, generation_id) DO UPDATE SET
         workflow_choice = excluded.workflow_choice,
         workflow_owner = excluded.workflow_owner,
         reason = excluded.reason,
         confidence = excluded.confidence,
         at = excluded.at`,
    ).run(cid, gid, choice, owner, reason, confidence, at);
  });
  return normalizeReceipt({
    conversation_id: cid,
    generation_id: gid,
    workflow_choice: choice,
    workflow_owner: owner,
    reason,
    confidence,
    at,
  });
}

/**
 * Lookup receipt for conversation+generation; falls back to latest for conversation.
 */
export async function readWorkflowReceipt(conversationId, generationId, home) {
  const cid = String(conversationId ?? "").trim();
  const gid = String(generationId ?? "").trim();
  if (!cid) return null;
  return withStore(home, (db) => {
    if (gid) {
      const exact = db
        .prepare(
          "SELECT conversation_id, generation_id, workflow_choice, workflow_owner, reason, confidence, at FROM workflows WHERE conversation_id = ? AND generation_id = ?",
        )
        .get(cid, gid);
      if (exact) return normalizeReceipt(exact);
    }
    const latest = db
      .prepare(
        "SELECT conversation_id, generation_id, workflow_choice, workflow_owner, reason, confidence, at FROM workflows WHERE conversation_id = ? ORDER BY at DESC LIMIT 1",
      )
      .get(cid);
    return normalizeReceipt(latest);
  });
}
