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
  → MCP jev_ask / jev_route
```

## Install

Requires Node 18+.

```bash
git clone https://github.com/mywwave/cursor-jev.git
cd cursor-jev
node bin/cli.mjs install
```

Then:

1. Create an API key at [console.typesafe.ai](https://console.typesafe.ai).
2. Set a **user** environment variable named `TYPESAFE_API_KEY`. Do not put the key in git, `mcp.json`, or `hooks.json`.
3. Restart Cursor.

`install` merges into existing Cursor config and does not wipe other MCP servers or hooks:

- `~/.cursor/mcp.json` — stdio server `jev` (`node <repo>/bin/cli.mjs mcp`)
- `~/.cursor/hooks.json` — `preToolUse` matcher `Task`
- `~/.cursor/rules/jev-typesafe.mdc` — always-on routing reminder (`--no-rule` to skip)
- `~/.cursor/skills/jev-subagents/SKILL.md` (`--no-skill` to skip)

```bash
node bin/cli.mjs uninstall
```

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

## MCP tools

| Tool | Purpose |
| --- | --- |
| `jev_route` | `{ task }` → `{ agent, status, confidence }` |
| `jev_ask` | `{ state, questions }` → TypeSafe answers |

Do not send secrets, `.env` files, credentials, or full transcripts as `state`.

For building TypeSafe features in your own apps, install the official skill separately:

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai
```

Docs: [TypeSafe introduction](https://docs.typesafe.ai/introduction.md), [API](https://docs.typesafe.ai/api.md), [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md).

## Develop

```bash
node --test
```

Zero runtime dependencies. `npm test` runs the same suite.

## License

MIT
