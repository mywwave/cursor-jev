# cursor-jev

Route [Cursor](https://cursor.com) subagents with [TypeSafe](https://docs.typesafe.ai/) **Jev**, and ask typed Choice / Score / Noul questions from any agent.

Jev is not a chat model. It cannot write code, call tools, or be used as a Cursor `model` ID (`jev`, `jev-latest`, and `typesafe-ai/jev` are invalid there). Jev classifies and scores; Cursor LLMs execute.

```
Parent agent
  → Task
    → preToolUse hook
    → TypeSafe Jev (choice + noul)
    → rewritten subagent_type
    → Cursor subagent
    → MCP jev_ask / jev_route / jev_auth
```

## Install

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/mywwave/cursor-jev.git
cd cursor-jev
node bin/cli.mjs install
```

On Windows you can use `cursor-jev.cmd install` instead.

Then fully restart Cursor (or Developer: Reload Window).

`install` merges into existing Cursor config and copies a local plugin (logo + Configure form):

| Path | What it is |
| --- | --- |
| `~/.cursor/plugins/local/cursor-jev` | Cursor plugin **Jev** (avatar, MCP, hooks, Configure) |
| `~/.cursor/mcp.json` | User stdio server `jev` (`envFile` → `~/.cursor/cursor-jev.env`) |
| `~/.cursor/hooks.json` | `preToolUse` matcher `Task` |
| `~/.cursor/rules/jev-typesafe.mdc` | Always-on routing reminder (`--no-rule` to skip) |
| `~/.cursor/skills/jev-subagents/SKILL.md` | Agent skill (`--no-skill` to skip) |

```bash
node bin/cli.mjs uninstall
```

Uninstall keeps `~/.cursor/cursor-jev.env`. Enable **local plugins** in Cursor if the Jev plugin does not appear under Customize → Plugins.

### Connect (pick one)

1. **Cursor UI (recommended):** Customize → **Plugins** → **Jev** → **Configure** → paste a TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai).
2. **CLI:** `node bin/cli.mjs set-key` (saves `~/.cursor/cursor-jev.env`, never git).
3. **In chat:** ask the agent to call MCP `jev_auth`.

Do not put the key in git, `mcp.json`, `hooks.json`, or a committed `.env`.

## CLI

```text
cursor-jev set-key                 Save the TypeSafe key to ~/.cursor/cursor-jev.env
cursor-jev key                     Show whether a key is saved (does not print the secret)
cursor-jev install [--no-rule] [--no-skill]
cursor-jev uninstall
cursor-jev mcp                     Stdio MCP server (Cursor launches this)
cursor-jev hook                    preToolUse hook (Cursor launches this)
```

## MCP tools

After Cursor reconnects, the server is named **Jev**. Tools:

| Tool | Purpose |
| --- | --- |
| `jev_auth` | Prompt to connect a TypeSafe API key |
| `jev_route` | `{ task }` → `{ agent, status, confidence, noul }` |
| `jev_ask` | `{ state, questions }` → TypeSafe answers |

Resources: `jev://status`. Prompts: `connect-typesafe`, `route-task`.

Do not send secrets, `.env` files, credentials, or full transcripts as `state`.

`install` registers both a user MCP server (`jev`) and the plugin server (`plugin-cursor-jev-jev`). They are the same process; keep whichever you prefer.

## Routing

On every `Task` call the hook sends the task text to `POST https://api.typesafe.ai/v1/systemone` (`jev-latest`) with:

- **Choice `role`** — Cursor `subagent_type` (`explore`, `generalPurpose`, `cursor-guide`, `docs-researcher`, `ci-investigator`, `ai-architect`, `deployment-expert`, `performance-optimizer`, plus `bugbot` / `security-review` only when the parent already requested them)
- **Noul `needs_specialist`** — whether a specialist beats `generalPurpose`

Code decides:

| Result | Action |
| --- | --- |
| Missing key, HTTP error, or timeout | Fail open; keep the original type |
| Choice confidence `< 0.7` | Keep the original type |
| Specialist noul `< 0.5` and original is `generalPurpose` | Keep `generalPurpose` |
| Otherwise | Set `subagent_type` to the Choice and prefix the prompt with `Jev routed: …` |

The subagent **model** is never changed. Questions and thresholds live in [`src/roles.mjs`](src/roles.mjs).

## Plugin layout

This repo is a Cursor plugin as well as a CLI:

- [`.cursor-plugin/plugin.json`](.cursor-plugin/plugin.json) — name **Jev**, logo, optional `TYPESAFE_API_KEY`
- [`mcp.json`](mcp.json) — plugin stdio MCP (`${CURSOR_PLUGIN_ROOT}`, no secrets)
- [`hooks/hooks.json`](hooks/hooks.json) — Task hook
- [`assets/logo.svg`](assets/logo.svg) — plugin and MCP avatar
- [`rules/jev-typesafe.mdc`](rules/jev-typesafe.mdc) and [`skills/jev-subagents/SKILL.md`](skills/jev-subagents/SKILL.md)

For building TypeSafe features in your own apps, install the official skill separately:

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai
```

Docs: [TypeSafe introduction](https://docs.typesafe.ai/introduction.md), [API](https://docs.typesafe.ai/api.md), [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md).

## Develop

Zero runtime dependencies.

```bash
node --test
node scripts/mcp-smoke.mjs
```

`npm test` runs the same unit suite. The smoke script talks to TypeSafe if `TYPESAFE_API_KEY` or `~/.cursor/cursor-jev.env` is set.

If Cursor shows Jev as loading, reload the window after `install`. Stdio uses newline-delimited JSON (MCP spec), not LSP `Content-Length`.

## License

MIT
