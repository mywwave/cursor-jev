---
name: jev-subagents
description: >-
  Routes Cursor subagents with TypeSafe Jev and asks typed Choice, Score, and
  Noul questions via MCP tools jev_route and jev_ask. Use when launching Task
  subagents, classifying a request, or replacing prompt-and-parse with a
  structured TypeSafe judgment.
---

# Jev subagents

Jev (`jev-latest`) is TypeSafe System One: send `state` plus typed questions, get structured answers. It does not generate code or tool calls.

## Tools

- `jev_route({ task })` — pick a Cursor `subagent_type`. JSON `{ agent, status, confidence }`.
- `jev_ask({ state, questions })` — arbitrary Choice / Score / Noul questions. Same contract as `POST https://api.typesafe.ai/v1/systemone`.

A Cursor `preToolUse` hook already routes `Task` calls when `TYPESAFE_API_KEY` is set. Still use `jev_ask` inside a subagent for judgments.

## Question shapes

```json
{
  "department": {
    "type": "choice",
    "instructions": "Which specialist should handle this?",
    "criteria": { "explore": "Find code", "generalPurpose": "Implement across areas" }
  },
  "urgency": {
    "type": "noul",
    "instructions": "Is this time-sensitive?"
  },
  "complexity": {
    "type": "score",
    "instructions": "How complex is the change?",
    "criteria": ["Small local edit", "Several files", "Cross-cutting redesign"]
  }
}
```

## Rules

- One coherent judgment per question; mix types in one request.
- If Choice/Score `confidence` is low, do not treat the label as certain.
- Never put secrets in `state`.
- Never set a subagent `model` field to Jev.

Live docs: https://docs.typesafe.ai/llms.txt
