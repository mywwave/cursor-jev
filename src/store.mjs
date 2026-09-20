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
