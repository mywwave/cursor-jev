/**
 * Hook events surveyed against Cursor create-hook skill (2026).
 *
 * Registered in hooks.json / install HOOK_SPECS:
 *   preToolUse, postToolUse, beforeSubmitPrompt, beforeShellExecution,
 *   beforeMCPExecution, subagentStop, preCompact, stop
 *
 * Deferred (none): previously candidate events that are unsupported would be listed here
 * with a doctor skip reason. Keep this module so doctor can print skip reasons if the
 * platform drops an event later.
 */
export const DEFERRED_HOOKS = Object.freeze([
  // Example shape if needed later:
  // { event: "afterAgentThought", reason: "observational only; not used by fabric" },
]);

export function doctorDeferredNotes() {
  if (!DEFERRED_HOOKS.length) return ["No deferred fabric hooks — subagentStop and preCompact are registered."];
  return DEFERRED_HOOKS.map((d) => `SKIP ${d.event}: ${d.reason}`);
}
