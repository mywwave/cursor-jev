# Contributing

## Setup

Node 18 or later. No `npm install` is required for development.

```bash
node --test
```

## Scope

- Keep questions, criteria, and numeric thresholds in `src/roles.mjs`.
- Fail open when TypeSafe is unavailable: never block a Task call.
- Do not add `jev` as a Cursor model ID. Jev is System One, not a chat completion API.

## Secrets

Never commit API keys, `.env` files, or real `mcp.json` contents with credentials. Use `TYPESAFE_API_KEY` in the user environment only. Rotate a key if it appeared in a chat log.

## Pull requests

- Cover router fail-open, confidence gating, and explicit-only roles (`bugbot`, `security-review`) with tests.
- Keep the package zero-dependency unless a standard library cannot do the job.
