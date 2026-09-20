# cursor-jev

Route [Cursor](https://cursor.com) subagents with [TypeSafe](https://docs.typesafe.ai/) **Jev**, and ask typed Choice / Score / Noul questions from any agent.

Jev is not a chat model. It cannot write code, call tools, or be used as a Cursor `model` ID (`jev`, `jev-latest`, and `typesafe-ai/jev` are invalid there). Jev classifies and scores; Cursor LLMs execute.

The value is not “another AI”. Expensive Cursor hops become cheaper and rarer. Jev answers yes / no / which option in about 100ms. It does not write the patch.

```
Parent agent
  → Task / Write / shell
    → hook
    → TypeSafe Jev (~100ms)
    → allow / deny / ask / rewrite
    → MCP jev_judge / jev_ask / jev_route / jev_auth
```

## Why this helps

It saves three things.

1. **Extra subagents.** `Task` is a costly hop: new context, a second search, sometimes nesting. The plugin cuts that itself. A local edit stays on the current agent. A second `Task` in the same turn is blocked. A nested subagent is denied. That matters when the model likes to spawn `explore` / `generalPurpose` “just in case”.

2. **Extra repo reads.** After `Grep` / `Glob`, Jev keeps about three relevant files and denies `Read` of README, sibling modules, and other noise. On a large monorepo that is where an agent burns a turn on fifteen files instead of two.

3. **Scope creep.** “Fix the bug” should not become a neighbor refactor plus extra tests. The scope gate denies writes the user did not ask for. Destructive shell (`reset --hard`, `push --force`) asks you instead of running silently.

The agent can also call Jev instead of a long thinking pass: which of four files, done or not, one job or three. That is faster than another reasoning loop.

**Almost useless** on a one-file tweak, with no TypeSafe key (hooks fail open), or when a hook blocks a `Read` / `Write` you actually needed — then it is friction, not speed.

Cursor still writes the code. Jev only decides whether that hop is worth taking.

## Install

Requires [Node.js](https://nodejs.org/) 22.13+ (`node:sqlite` is unflagged there). Zero runtime npm dependencies.

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
| `~/.cursor/hooks.json` | Task / Write / Read / prompt / shell / ready hooks |
| `~/.cursor/cursor-jev.sqlite` | WAL store for sanitized user asks, Task fan-out, and rerank allowlists |
| `~/.cursor/rules/jev-typesafe.mdc` | Always-on routing reminder (`--no-rule` to skip) |
| `~/.cursor/skills/jev-subagents/SKILL.md` | Agent skill (`--no-skill` to skip) |

```bash
node bin/cli.mjs uninstall
```

Uninstall keeps `~/.cursor/cursor-jev.env` and the SQLite file. Enable **local plugins** in Cursor if the Jev plugin does not appear under Customize → Plugins.

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
cursor-jev hook                    Cursor hooks (Cursor launches this)
```

## MCP tools

After Cursor reconnects, the server is named **Jev**. Tools:

| Tool | Purpose |
| --- | --- |
| `jev_auth` | Prompt to connect a TypeSafe API key |
| `jev_route` | `{ task }` → `{ agent, status, confidence, noul }` |
| `jev_judge` | `{ kind, state }` → preset `scope` / `pick` / `ready` / `split` |
| `jev_ask` | `{ state, questions }` → TypeSafe answers |

Resources: `jev://status`. Prompts: `connect-typesafe`, `route-task`.

Do not send secrets, `.env` files, credentials, or full transcripts as `state`.

`install` registers both a user MCP server (`jev`) and the plugin server (`plugin-cursor-jev-jev`). They are the same process; keep whichever you prefer.

## Speed

Jev is ~100ms per judgment. A Cursor Task subagent is seconds to minutes. The plugin speeds agents by **cutting hops**, not by replacing the coding model. Missing key, HTTP error, or timeout **fail open**.

| Waste | What Jev does |
| --- | --- |
| `Task` for a local edit | Deny the hop; parent continues inline |
| Nested `Task` from a subagent | Blocked |
| Second `Task` in the same turn | Blocked unless Jev says the extra hop is worth it |
| Extra investigation after a good result | `postToolUse` / `ready` tell the parent to stop |
| Write outside the user ask | `scope` denies the tool |
| Compound prompt | `split` tells the agent to sequence jobs here |
| Destructive shell | User is asked unless the command clearly matches the ask |
| Grep / search dump | Rerank: Read only the top-k paths Jev scores as relevant |
| Long yes/no / classification | `jev_judge` or `jev_ask` (~100ms) instead of another LLM pass |
| Hook stall | TypeSafe timeout on the hook path is 1.8s, one attempt, fail-open |

The Task prompt also gets a one-pass contract (`Jev speed: fast|standard|thorough`).

This is the same pattern as TypeSafe's cookbooks: Choice/Noul is ~7–100× faster than asking a chat model the same closed question. Wall-clock for a whole coding session still depends on the Cursor LLM; Jev removes the extra loops around it.

## Gates

Hooks call the same questions as MCP `jev_judge`. Thresholds live in [`src/roles.mjs`](src/roles.mjs). Missing key, HTTP error, or timeout **fail open**.

| Kind | When | Action |
| --- | --- | --- |
| `scope` | `Write` / `StrReplace` / `Delete` | Deny if `in_scope < 0.3` |
| `pick` | MCP only | Return one of 2–8 named options |
| `ready` | After the agent replies | Stop if ship score `>= 1.5` and `can_commit >= 0.7` |
| `split` | User prompt submit | Sequence jobs if `compound >= 0.55` |
| `shell` | Before shell (internal) | Ask the user if destructive `>= 0.5` and `matches_ask < 0.9` |
| rerank | After `Grep` / `Glob` / `SemanticSearch` / codegraph | Score 0–2 per hit plus a focus Choice; keep up to 3 files with score `>= 1.5` (docs dropped unless the ask is about docs) |

Routine shells (`git status`, `git diff`, `node --test`, …) skip the model.

Rerank is **additive**. Existing Task / scope / split / ready / shell gates stay. SQLite adds a `reads` table next to `asks` and `fanout`; those tables are not dropped. No allowlist yet (or a TypeSafe miss) **fail-opens** and every `Read` is allowed. File bodies are never sent to TypeSafe — only path + short snippet.

Prefers `jev_judge` over inventing `jev_ask` questions. `jev_ask` stays for custom Choice / Score / Noul.

Session state is a SQLite file at `~/.cursor/cursor-jev.sqlite` (`node:sqlite`, WAL, 2s busy timeout). Concurrent hook processes share it without an extra npm dependency. Secrets are stripped before write.

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
- [`hooks/hooks.json`](hooks/hooks.json) — Task, Write, prompt, shell, and ready hooks
- [`assets/logo.svg`](assets/logo.svg) — plugin and MCP avatar
- [`rules/jev-typesafe.mdc`](rules/jev-typesafe.mdc) and [`skills/jev-subagents/SKILL.md`](skills/jev-subagents/SKILL.md)

For building TypeSafe features in your own apps, install the official skill separately:

```bash
npx skills add typesafe-ai/skills --skill typesafe-ai
```

Docs: [TypeSafe introduction](https://docs.typesafe.ai/introduction.md), [API](https://docs.typesafe.ai/api.md), [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md).

## Outside Cursor

The plugin is Cursor-only. The same TypeSafe call (`POST /v1/systemone`, then branch in your code) is how you use Jev in tickets, moderation, matching, or dates. This repo does not ship a second service.

| Job | What to ask Jev | Then in code | Write-up |
| --- | --- | --- | --- |
| Tickets / intent | Choice: deterministic vs specialist LLM vs human; Noul: is this in-scope? | Route the ticket; do not let the LLM invent the queue | [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md) |
| Moderation | Choice with an **uncertain** outcome; Noul for each hazard | Auto-act only above a confidence floor; otherwise human review | [Self-consistency: choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md), [LLM guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails.md) |
| Entity matching | Score whose levels are the actions (merge / leave unlinked / curator) | No extra threshold to invent — the score *is* the action | [Entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment.md) |
| Dates | Ask for the named parts (absolute vs relative); keep numbers in code | Resolve and validate in code; review low-confidence spans | [Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook.md) |

Keep questions atomic. Combine answers in code. Never send secrets or full transcripts as `state`.

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
