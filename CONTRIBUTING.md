# Contributing

## Setup

Node 22.13 or later (`node:sqlite` is unflagged). No `npm install` is required for development.

```bash
node --test
node scripts/mcp-smoke.mjs
```

Smoke needs a TypeSafe key in the environment or in `~/.cursor/cursor-jev.env`. It never prints the secret.

## Scope

- Keep questions, criteria, and numeric thresholds in `src/roles.mjs`.
- Fail open when TypeSafe is unavailable: never block a Task, Write, Read, or shell call on a timeout.
- Persist session asks, Task fan-out, and rerank allowlists in `src/store.mjs` (`node:sqlite`, WAL). Add tables with `CREATE TABLE IF NOT EXISTS`; do not drop existing rows or switch back to a JSON session file.
- Do not add `jev` as a Cursor model ID. Jev is System One, not a chat completion API.
- MCP stdio must speak newline-delimited JSON (`JSON.stringify(msg) + "\n"`). Cursor's client never completes `initialize` on LSP `Content-Length` frames without a trailing newline.
- Plugin identity (title **Jev**, logo, optional Configure variable) lives in `.cursor-plugin/plugin.json`, `assets/logo.svg`, and `src/identity.mjs`. The committed `mcp.json` is a plugin template with placeholders only.

## Secrets

Never commit API keys, `.env` files, SQLite databases, or real `mcp.json` contents with credentials. Store the TypeSafe key via the Jev plugin Configure form or `cursor-jev set-key` (`~/.cursor/cursor-jev.env`). Rotate a key if it appeared in a chat log. Strip secrets before writing user asks to SQLite.

## Pull requests

- Cover router fail-open, confidence gating, and explicit-only roles (`bugbot`, `security-review`) with tests.
- Cover MCP initialize, `jev_auth`, `jev_judge`, NDJSON framing, and speed-hook deny/stop/scope/split/shell paths in `test/hook-mcp-install.test.mjs` and `test/gates.test.mjs`.
- Keep the package zero-dependency unless a standard library cannot do the job.
