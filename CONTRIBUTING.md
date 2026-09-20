# Contributing

## Setup

Node 18 or later. No `npm install` is required for development.

```bash
node --test
node scripts/mcp-smoke.mjs
```

Smoke needs a TypeSafe key in the environment or in `~/.cursor/cursor-jev.env`. It never prints the secret.

## Scope

- Keep questions, criteria, and numeric thresholds in `src/roles.mjs`.
- Fail open when TypeSafe is unavailable: never block a Task call.
- Do not add `jev` as a Cursor model ID. Jev is System One, not a chat completion API.
- MCP stdio must speak newline-delimited JSON (`JSON.stringify(msg) + "\n"`). Cursor's client never completes `initialize` on LSP `Content-Length` frames without a trailing newline.
- Plugin identity (title **Jev**, logo, optional Configure variable) lives in `.cursor-plugin/plugin.json`, `assets/logo.svg`, and `src/identity.mjs`. The committed `mcp.json` is a plugin template with placeholders only.

## Secrets

Never commit API keys, `.env` files, or real `mcp.json` contents with credentials. Store the TypeSafe key via the Jev plugin Configure form or `cursor-jev set-key` (`~/.cursor/cursor-jev.env`). Rotate a key if it appeared in a chat log.

## Pull requests

- Cover router fail-open, confidence gating, and explicit-only roles (`bugbot`, `security-review`) with tests.
- Cover MCP initialize, `jev_auth`, and NDJSON framing in `test/hook-mcp-install.test.mjs`.
- Keep the package zero-dependency unless a standard library cannot do the job.
