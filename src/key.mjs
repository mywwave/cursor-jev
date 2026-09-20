import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEY_FILE_NAME = "cursor-jev.env";

function cursorDir(home = homedir()) {
  return join(home, ".cursor");
}

export function keyFilePath(home = homedir()) {
  return join(cursorDir(home), KEY_FILE_NAME);
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const matched = trimmed.match(/^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/i);
    if (matched) return stripQuotes(matched[1].trim());
    if (!trimmed.includes("=")) return trimmed;
  }
  return "";
}

export async function readStoredKey(options = {}) {
  try {
    return parseEnvFile(await readFile(keyFilePath(options.home), "utf8")).trim();
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

export async function writeStoredKey(key, options = {}) {
  const value = String(key ?? "").trim();
  if (!value) throw new Error("API key is empty.");
  const path = keyFilePath(options.home);
  await mkdir(cursorDir(options.home), { recursive: true });
  await writeFile(path, `# Local TypeSafe key for cursor-jev. Do not commit.\nTYPESAFE_API_KEY=${value}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await chmod(path, 0o600);
  } catch {
    /* Windows may ignore chmod */
  }
  return path;
}

export async function resolveKey(options = {}) {
  if (options.key !== undefined) return String(options.key ?? "").trim();
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  return readStoredKey(options);
}

export async function seedKeyFromEnv(options = {}) {
  const path = keyFilePath(options.home);
  if (await readStoredKey(options)) return { path, present: true, seeded: false };
  const env = options.key?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  if (!env) return { path, present: false, seeded: false };
  await writeStoredKey(env, options);
  return { path, present: true, seeded: true };
}

export function maskKey(key) {
  const value = String(key ?? "").trim();
  if (value.length < 8) return "set";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
