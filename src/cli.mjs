import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHook } from "./hook.mjs";
import { install, repoRootFromHere, uninstall } from "./install.mjs";
import { keyFilePath, maskKey, readStoredKey, resolveKey, writeStoredKey } from "./key.mjs";
import { runMcp } from "./mcp.mjs";

function hasFlag(args, name) {
  return args.includes(name);
}

function positionalKey(args) {
  return args.slice(1).find((arg) => !arg.startsWith("-"));
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
  cursor-jev set-key              Save the TypeSafe key to ~/.cursor/cursor-jev.env
  cursor-jev key                  Show whether a key is saved (does not print the secret)
  cursor-jev install [--no-rule] [--no-skill]
  cursor-jev uninstall
  cursor-jev mcp
  cursor-jev hook

Get a key at https://console.typesafe.ai
Do not put the key in git, mcp.json, or hooks.json.
`;
}

async function promptForKey(stdin, stdout) {
  const input = stdin ?? defaultStdin;
  const output = stdout ?? defaultStdout;
  if (!input.isTTY) {
    const chunks = [];
    for await (const chunk of input) chunks.push(chunk);
    return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))))
      .toString("utf8")
      .trim();
  }
  const rl = createInterface({ input, output });
  try {
    output.write("Get a key at https://console.typesafe.ai\n");
    const value = await rl.question("Paste TypeSafe API key, then Enter: ");
    return String(value ?? "").trim();
  } finally {
    rl.close();
  }
}

function describeKey(result, home) {
  const path = keyFilePath(home);
  if (!result.present) {
    return [
      `No API key yet. Run: node bin/cli.mjs set-key`,
      `File: ${path}`,
    ].join("\n");
  }
  if (result.seeded) return `Saved TypeSafe API key to ${path}`;
  return `TypeSafe API key is ready (${path})`;
}

export async function runCli(args, options = {}) {
  const log = options.log ?? console;
  const command = args[0];
  const root = options.root ?? repoRootFromHere();
  const home = options.home;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    log.log(usage());
    return 0;
  }

  if (command === "set-key") {
    const provided = options.key ?? positionalKey(args);
    const key = provided?.trim() ? provided.trim() : await promptForKey(options.stdin, options.stdout);
    if (!key) {
      log.error("No key provided.");
      return 1;
    }
    const path = await writeStoredKey(key, { home });
    log.log(`Saved TypeSafe API key to ${path}`);
    log.log("Restart Cursor if it is already open.");
    return 0;
  }

  if (command === "key") {
    const stored = await readStoredKey({ home });
    const resolved = await resolveKey({ home });
    if (!resolved) {
      log.log(`No TypeSafe API key. Run: node bin/cli.mjs set-key`);
      log.log(`File: ${keyFilePath(home)}`);
      return 1;
    }
    const source = stored && stored === resolved ? "file" : process.env.TYPESAFE_API_KEY?.trim() === resolved ? "env" : "file";
    log.log(`Key ${maskKey(resolved)} (${source}: ${keyFilePath(home)})`);
    return 0;
  }

  if (command === "install") {
    const result = await install({
      root,
      home,
      noRule: hasFlag(args, "--no-rule"),
      noSkill: hasFlag(args, "--no-skill"),
      key: options.key,
    });
    log.log(`Installed cursor-jev into ${result.home}`);
    log.log(`Plugin (logo + Configure key): ${result.pluginDir}`);
    log.log(describeKey(result.key, home));
    log.log("");
    log.log("Authorize: Customize → Plugins → Jev → Configure");
    log.log("Or run: node bin/cli.mjs set-key");
    log.log("Then restart Cursor.");
    return result.key.present ? 0 : 0;
  }

  if (command === "uninstall") {
    await uninstall({ root, home });
    log.log("Removed cursor-jev MCP, hook, rule, and skill from ~/.cursor");
    log.log(`API key file kept at ${keyFilePath(home)}`);
    return 0;
  }

  if (command === "mcp") {
    await runMcp({
      stdin: options.stdin,
      stdout: options.stdout,
      key: options.key,
      home,
      version: await packageVersion(root),
    });
    return 0;
  }

  if (command === "hook") {
    await runHook({
      stdin: options.stdin,
      stdout: options.stdout,
      key: options.key,
      home,
      fetcher: options.fetcher,
    });
    return 0;
  }

  log.error(`Unknown command: ${command}`);
  log.error(usage());
  return 1;
}
