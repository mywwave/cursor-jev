import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHook } from "./hook.mjs";
import { install, repoRootFromHere, uninstall } from "./install.mjs";
import { runMcp } from "./mcp.mjs";

function hasFlag(args, name) {
  return args.includes(name);
}

async function packageVersion(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function usage() {
  return `cursor-jev — TypeSafe Jev routing for Cursor subagents

Usage:
  cursor-jev install [--no-rule] [--no-skill]
  cursor-jev uninstall
  cursor-jev mcp
  cursor-jev hook

Set TYPESAFE_API_KEY before using the MCP server or Task hook.
Do not put the key in git, mcp.json, or hooks.json.
`;
}

export async function runCli(args, options = {}) {
  const log = options.log ?? console;
  const command = args[0];
  const root = options.root ?? repoRootFromHere();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    log.log(usage());
    return 0;
  }

  if (command === "install") {
    const result = await install({
      root,
      home: options.home,
      noRule: hasFlag(args, "--no-rule"),
      noSkill: hasFlag(args, "--no-skill"),
    });
    log.log(`Installed cursor-jev into ${result.home}`);
    log.log("");
    log.log("Next:");
    log.log("  1. Set the user environment variable TYPESAFE_API_KEY (https://console.typesafe.ai)");
    log.log("  2. Restart Cursor so MCP and hooks reload");
    log.log("");
    log.log("MCP server name: jev");
    log.log("Hook: preToolUse matcher Task");
    return 0;
  }

  if (command === "uninstall") {
    await uninstall({ root, home: options.home });
    log.log("Removed cursor-jev MCP, hook, rule, and skill from ~/.cursor");
    return 0;
  }

  if (command === "mcp") {
    await runMcp({
      stdin: options.stdin,
      stdout: options.stdout,
      key: options.key,
      version: await packageVersion(root),
    });
    return 0;
  }

  if (command === "hook") {
    await runHook({
      stdin: options.stdin,
      stdout: options.stdout,
      key: options.key,
      fetcher: options.fetcher,
    });
    return 0;
  }

  log.error(`Unknown command: ${command}`);
  log.error(usage());
  return 1;
}
