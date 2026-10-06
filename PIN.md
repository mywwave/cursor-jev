# cursor-jev fabric pin

Pinned build for the Jev↔pstack fabric (workflow receipts + pstack orchestration bypass).

| Field | Value |
| --- | --- |
| Branch | `fabric/pstack-bypass-and-pin` |
| SHA | `88cb0bd8d6b1a7ab310730a7665d200d6b5d7fc9` (includes postToolUse PSTACK no-steer; fabric base `b5e53d654d2a`) |
| Doctor | `node scripts/doctor.mjs` |

## Required automated tests

1. `node --test test/pstack-bypass.test.mjs` — explicit pstack/Task bypass
2. `node --test test/ship-stop.test.mjs` — ship fail-closed without key; stop readiness path
3. `node --test test/workflow-receipt.test.mjs` — receipt store + Write deny + PSTACK receipt bypass
4. Full suite: `node --test test/*.mjs`
5. `node scripts/doctor.mjs` — pin + units + manual checklist

## Invariant

Exempt only **pstack-owned orchestration** (Task rewrite / fan-out / model override / postToolUse STOP_CONTEXT panel steer) when `workflow_choice=PSTACK` and `workflow_owner=pstack`, or when `isExplicitOrchestratedTask` matches. Do **not** exempt pstack from scope, shell, ready, or learning.
