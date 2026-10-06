---
name: jev-subagents
description: >-
  Speeds Cursor agents with TypeSafe Jev: jev_judge for scope/pick/ready/split,
  jev_ask for custom judgments, jev_route instead of extra Task hops, jev_auth
  to connect. Use when launching Task, choosing between options, or replacing
  prompt-and-parse with a structured judgment.
---

# Jev subagents

Jev is TypeSafe System One: send `state` plus typed questions, get structured answers. It does not generate code or tool calls.

Use it to **cut hops**, not to add them. Prefer `jev_judge` / `jev_ask` over thinking out loud. Prefer doing the work inline over spawning Task. Never nest Task inside a subagent.

## Fabric (workflow + pstack)

On each user submit, hooks store a **workflow receipt** (`DIRECT` | `ASEO_ANALYSIS` | `PSTACK` | `RESEARCH` | `VERIFY` | `SHIP`). Mutating tools require a receipt for that conversation/generation.

When receipt is `PSTACK` with `workflow_owner=pstack` (or the Task is already explicitly orchestrated), Jev does **not** rewrite `subagent_type`, suppress fan-out, or override models. Scope, shell, ready, and learning still apply.

Do **not** invent progressive per-agent pstack manuals. `poteto-mode` / `poteto-agent` own method load when pstack is invoked.

## Auth

If tools fail with a missing key, call `jev_auth` or tell the user to open **Customize → Plugins → Jev → Configure** and paste a TypeSafe API key from https://console.typesafe.ai.

## Tools

- `jev_auth` — connect a TypeSafe API key
- `jev_route({ task })` — pick a Cursor `subagent_type`
- `jev_judge({ kind, state })` — preset gates: `scope`, `pick`, `ready`, `split`
- `jev_ask({ state, questions })` — arbitrary Choice / Score / Noul

## Helpers

- Context sources (catalog metadata only): `pickContextSources` in `src/workflow.mjs`
- Evidence sources `{GSC,GA4,SERP,repo,orders,authority,none}`: `pickEvidenceSources` — does **not** decide create/delete page or pricing

## jev_judge kinds

- `scope` — `{ ask, path, preview }` → `action: skip` means do not write
- `pick` — `{ ask, options: { a: "...", b: "..." } }` (2–8 keys) → use `pick`
- `ready` — `{ ask, summary }` → `action: stop` means hand back
- `split` — `{ ask }` → `action: split` means sequence independent jobs here, no extra Task

## Rules

- Never put secrets in `state`.
- Never set a subagent `model` field to Jev.
- If `pace` is `fast` or `needsDelegate` is low, do not launch Task (unless pstack owns the Task).
- If Choice/Score confidence is low, ask the user instead of guessing.

Live docs: https://docs.typesafe.ai/llms.txt
