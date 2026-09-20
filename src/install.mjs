import { seedKeyFromEnv } from "./key.mjs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "jev";
export const HOOK_MATCHER = "Task";
const RULE_NAME = "jev-typesafe.mdc";
const SKILL_DIR = "jev-subagents";

export function repoRootFromHere(here = import.meta.url) {
  return resolve(fileURLToPath(here), "../..");
}

export function cursorHome(home = homedir()) {
  return join(home, ".cursor");
}

export function hookCommand(root) {
  const cli = join(root, "bin", "cli.mjs").replaceAll("\\", "/");
  return `node "${cli}" hook`;
}

export function isOurHook(entry, root) {
  const command = String(entry?.command ?? "");
  if (!command.includes("hook")) return false;
  const cli = join(root, "bin", "cli.mjs").replaceAll("\\", "/");
  const normalized = command.replaceAll("\\", "/");
  return normalized.includes("cursor-jev") || normalized.includes(cli);
}

const PLUGIN_ENTRIES = [
  ".cursor-plugin",
  "assets",
  "bin",
  "src",
  "hooks",
  "rules",
  "skills",
  "mcp.json",
  "package.json",
];

export function localPluginDir(home = homedir()) {
  return join(cursorHome(home), "plugins", "local", "cursor-jev");
}

export function mcpServerConfig(root) {
  return {
    type: "stdio",
    command: "node",
    args: [join(root, "bin", "cli.mjs"), "mcp"],
    envFile: "${userHome}/.cursor/cursor-jev.env",
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function mergeMcpConfig(existing, root) {
  const next = existing && typeof existing === "object" ? structuredClone(existing) : {};
  if (!next.mcpServers || typeof next.mcpServers !== "object") next.mcpServers = {};
  next.mcpServers[SERVER_NAME] = mcpServerConfig(root);
  return next;
}

export function unmergeMcpConfig(existing) {
  if (!existing || typeof existing !== "object") return existing;
  const next = structuredClone(existing);
  if (next.mcpServers && typeof next.mcpServers === "object") {
    delete next.mcpServers[SERVER_NAME];
  }
  return next;
}

export function mergeHooksConfig(existing, root) {
  const next =
    existing && typeof existing === "object"
      ? structuredClone(existing)
      : { version: 1, hooks: {} };
  if (next.version == null) next.version = 1;
  if (!next.hooks || typeof next.hooks !== "object") next.hooks = {};
  const list = Array.isArray(next.hooks.preToolUse) ? next.hooks.preToolUse : [];
  const kept = list.filter((entry) => !isOurHook(entry, root));
  kept.push({ command: hookCommand(root), matcher: HOOK_MATCHER });
  next.hooks.preToolUse = kept;
  return next;
}

export function unmergeHooksConfig(existing, root) {
  if (!existing || typeof existing !== "object") return existing;
  const next = structuredClone(existing);
  if (!Array.isArray(next.hooks?.preToolUse)) return next;
  next.hooks.preToolUse = next.hooks.preToolUse.filter((entry) => !isOurHook(entry, root));
  return next;
}

async function copyFile(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(from, "utf8"), "utf8");
}

async function copyPlugin(root, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of PLUGIN_ENTRIES) {
    await cp(join(root, entry), join(dest, entry), { recursive: true, force: true });
  }
}

export async function install(options = {}) {
  const root = options.root ?? repoRootFromHere();
  const home = cursorHome(options.home);
  const mcpPath = join(home, "mcp.json");
  const hooksPath = join(home, "hooks.json");
  const pluginDir = localPluginDir(options.home);

  await writeJson(mcpPath, mergeMcpConfig(await readJson(mcpPath, { mcpServers: {} }), root));
  await writeJson(hooksPath, mergeHooksConfig(await readJson(hooksPath, { version: 1, hooks: {} }), root));
  await copyPlugin(root, pluginDir);

  if (!options.noRule) {
    await copyFile(join(root, "rules", RULE_NAME), join(home, "rules", RULE_NAME));
  }

  if (!options.noSkill) {
    await copyFile(
      join(root, "skills", SKILL_DIR, "SKILL.md"),
      join(home, "skills", SKILL_DIR, "SKILL.md"),
    );
  }

  const key = await seedKeyFromEnv({ home: options.home, key: options.key });
  return { mcpPath, hooksPath, home, root, pluginDir, key };
}

export async function uninstall(options = {}) {
  const root = options.root ?? repoRootFromHere();
  const home = cursorHome(options.home);
  const mcpPath = join(home, "mcp.json");
  const hooksPath = join(home, "hooks.json");

  await writeJson(mcpPath, unmergeMcpConfig(await readJson(mcpPath, { mcpServers: {} })));
  await writeJson(hooksPath, unmergeHooksConfig(await readJson(hooksPath, { version: 1, hooks: {} }), root));
  await rm(join(home, "rules", RULE_NAME), { force: true });
  await rm(join(home, "skills", SKILL_DIR), { recursive: true, force: true });
  await rm(localPluginDir(options.home), { recursive: true, force: true });
  return { mcpPath, hooksPath };
}
