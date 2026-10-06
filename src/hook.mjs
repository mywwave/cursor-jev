import { evaluateGate, isRoutineShell, isWriteTool } from "./gates.mjs";
import { noteFanout } from "./fanout.mjs";
import { resolveKey } from "./key.mjs";
import {
  extractCandidates,
  isReadTool,
  isSearchTool,
  pathAllowed,
  rankCandidates,
  readPathFromInput,
  rerankContext,
  trimMcpOutput,
} from "./rerank.mjs";
import { shouldContinue, routeTask } from "./router.mjs";
import {
  DELEGATE_THRESHOLD,
  FALLBACK_AGENT,
  FANOUT_THRESHOLD,
  HOOK_MAX_ATTEMPTS,
  HOOK_TIMEOUT_MS,
  PREVIEW_MAX,
} from "./roles.mjs";
import { looksSecret, truncate } from "./session.mjs";
import {
  mergeAllowlist,
  readAllowlist,
  readUserAsk,
  readWorkflowReceipt,
  writeUserAsk,
  writeWorkflowReceipt,
} from "./store.mjs";
import {
  advisoryMcpDecision,
  classifyWorkflow,
  compactPreserveContext,
  conversationKey,
  generationKey,
  isPstackOwnedReceipt,
  requiresWorkflowReceipt,
  sufficiencyContext,
  workflowContext,
  WORKFLOW_REQUIRED_MESSAGE,
} from "./workflow.mjs";

const ROUTED_PREFIX = "Jev routed:";
const SPEED_PREFIX = "Jev speed:";
export const NESTED_MESSAGE =
  "Jev: nested subagents are blocked. Finish this task yourself with tools. Use jev_ask for closed yes/no or choice decisions.";
export const INLINE_MESSAGE =
  "Jev: do this inline. A subagent hop would be slower than using your current context. Prefer jev_ask over deliberation.";
export const FANOUT_MESSAGE =
  "Jev: another subagent is already running for this turn. Finish with that result instead of launching more Task calls.";
export const STOP_CONTEXT =
  "Jev: the subagent result is enough. Finish the user request now. Do not launch another Task. Use jev_ask only for a remaining closed judgment.";
export const SCOPE_MESSAGE =
  "Jev: this change looks out of scope for the user ask. Do not add extra files, refactors, or tests. Stay on the requested work.";
export const SPLIT_CONTEXT =
  "Jev: this looks like several independent tasks. Do them sequentially in this agent. Do not spawn extra Task subagents or mix unrelated edits.";
export const ASK_SHELL_MESSAGE =
  "Jev: this command looks destructive and is not clearly what the user asked for. Confirm before running it.";
export const READY_STOP_CONTEXT =
  "Jev: the local change meets the user ask. Stop adding files or extra tests. Hand the work back.";
export const NOT_READY_FOLLOWUP =
  "Jev readiness: the user ask is not fully met yet. Continue only the missing work: finish required edits, run the relevant checks the ask implies, and report concrete evidence (files changed, commands run, remaining gaps). Do not start unrelated tasks. Prefer jev_judge kind=ready before finishing again.";
export const READ_DENY_MESSAGE =
  "Jev: this file was not in the reranked shortlist. Read a kept path first, or search again if the ask changed.";
export const HARD_DENY_SHELL_MESSAGE =
  "Jev hard policy: this shell command is blocked (force-push, hard reset, or secret exposure). Use a safer equivalent or ask the user explicitly.";
export const JEV_REQUIRED_SHELL_MESSAGE =
  "Jev required: TypeSafe key missing. Stop and ask the operator before commit/push/PR. Do not fail-open into shipping.";
export const PSTACK_BYPASS_CONTEXT =
  "Jev: explicit pstack/orchestrated Task preserved (no subagent rewrite, no fan-out suppression).";

function isTaskTool(input) {
  const name = String(input?.tool_name ?? "");
  return name === "Task" || name === "task";
}

/**
 * When pstack (or another workflow) already made an explicit Task/model/panel
 * decision, Jev must not reroute, suppress fan-out, or rewrite the specialist.
 * Scope / shell / read / ready gates still apply elsewhere.
 * Also honors a stored PSTACK workflow receipt (workflow_owner=pstack).
 */
export function isExplicitOrchestratedTask(toolInput, receipt = null) {
  if (isPstackOwnedReceipt(receipt)) return true;
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (model && model !== "inherit" && model !== "inherit-parent" && model !== "auto") {
    return true;
  }
  const type = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
  if (/^poteto-agent$/i.test(type)) return true;
  const blob = [input.prompt, input.description, input.task, type]
    .filter((v) => typeof v === "string")
    .join("\n");
  if (
    /\b(pstack|poteto-mode|\/poteto-mode|\/reflect|\/arena|\/swarm|\/interrogate|\/architect|\/how\b|\/why\b)\b/i.test(
      blob,
    )
  ) {
    return true;
  }
  if (/\b(arena runners|architect runners|interrogate reviewers|swarm workers|reflect tooling)\b/i.test(blob)) {
    return true;
  }
  return /\bJev bypass:\s*pstack\b/i.test(blob);
}

async function resolveReceipt(input, options) {
  const read = options.readWorkflowReceipt ?? readWorkflowReceipt;
  return read(conversationKey(input), generationKey(input), options.home);
}

async function enforceWorkflowReceipt(input, toolName, toolInput, options) {
  if (!requiresWorkflowReceipt(toolName, toolInput, eventName(input))) return null;
  // Without a conversation identity we cannot key a receipt — fail open.
  if (!conversationKey(input)) return null;
  const receipt = await resolveReceipt(input, options);
  if (receipt) return { receipt };
  return {
    permission: "deny",
    agent_message: WORKFLOW_REQUIRED_MESSAGE,
    user_message: WORKFLOW_REQUIRED_MESSAGE,
  };
}

export function isShipCriticalShell(command) {
  const c = String(command ?? "");
  return (
    /\bgit\s+push\b/i.test(c) ||
    /\bgit\s+commit\b/i.test(c) ||
    /\bgh\s+pr\s+create\b/i.test(c) ||
    /\bgh\s+pr\s+merge\b/i.test(c)
  );
}

function eventName(input) {
  const named = String(input?.hook_event_name ?? input?.event ?? "").trim();
  if (named) return named;
  if (input?.tool_output != null || (input?.tool_name && input?.result != null)) return "postToolUse";
  if (input?.command && !input?.tool_name) return "beforeShellExecution";
  if (input?.status != null && !input?.tool_name && !input?.command) return "stop";
  if (input?.tool_name) return "preToolUse";
  return "preToolUse";
}

function taskText(toolInput) {
  for (const key of ["prompt", "task", "description"]) {
    const value = toolInput?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function conversationId(input) {
  return String(input?.conversation_id ?? input?.session_id ?? "");
}

function userPromptFromInput(input) {
  for (const key of ["prompt", "user_prompt", "content", "text"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function isBackgroundAgent(input) {
  return input?.is_background_agent === true || input?.agent?.is_subagent === true;
}

function speedContract(pace) {
  if (pace === "thorough") {
    return `${SPEED_PREFIX} thorough. Stay on this task. Do not spawn nested Task subagents. Prefer jev_judge or jev_ask for closed choices.`;
  }
  if (pace === "fast") {
    return `${SPEED_PREFIX} fast. One pass only. Do not call Task. Do not spawn subagents. Do not redo searches. Return as soon as the user ask is met. Prefer jev_judge for yes/no or closed choices.`;
  }
  return `${SPEED_PREFIX} standard. Do not spawn nested Task subagents. Prefer jev_judge over long deliberation for closed choices. Stop when the ask is met.`;
}

function stripJevPreamble(prompt) {
  return String(prompt ?? "")
    .replace(/^(?:Jev routed:[^\n]*\n+)+/g, "")
    .replace(/^(?:Jev speed:[^\n]*\n+)+/g, "")
    .replace(/^\n+/, "");
}

function annotatePrompt(prompt, decision) {
  const conf =
    typeof decision.confidence === "number" ? decision.confidence.toFixed(2) : "n/a";
  const pace = decision.pace ? ` pace=${decision.pace}` : "";
  const line = `${ROUTED_PREFIX} ${decision.agent} status=${decision.status} confidence=${conf}${pace}`;
  const body = stripJevPreamble(prompt);
  return `${line}\n${speedContract(decision.pace)}\n\n${body}`;
}

function gateOptions(options) {
  return {
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs ?? HOOK_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? HOOK_MAX_ATTEMPTS,
  };
}

function writeState(toolInput, userAsk) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  return {
    ask: userAsk,
    path: String(input.path ?? input.file_path ?? ""),
    preview: truncate(String(input.contents ?? input.new_string ?? input.old_string ?? ""), PREVIEW_MAX),
  };
}

async function resolveAsk(input, options) {
  if (typeof options.userAsk === "string" && options.userAsk.trim()) return options.userAsk;
  const read = options.readUserAsk ?? readUserAsk;
  return read(conversationId(input), options.home);
}

/**
 * Cursor preToolUse handler.
 * Fail-open: never crash the agent (except explicit deny paths).
 */
export async function handlePreToolUse(input, options = {}) {
  try {
    const toolName = String(input?.tool_name ?? "");

    if (isReadTool(toolName)) return handleReadGate(input, options);

    if (toolName.startsWith("MCP:")) {
      return handleMcpAdvisory(input, options);
    }

    const toolInput = input.tool_input && typeof input.tool_input === "object" ? { ...input.tool_input } : {};
    const gated = await enforceWorkflowReceipt(input, toolName, toolInput, options);
    if (gated?.permission === "deny") return gated;
    const receipt = gated?.receipt ?? (await resolveReceipt(input, options));

    if (isWriteTool(toolName)) return handleWriteScope(input, options);

    if (toolName === "Shell" || toolName === "Bash") {
      return { permission: "allow" };
    }

    if (!isTaskTool(input)) return { permission: "allow" };

    if (isExplicitOrchestratedTask(toolInput, receipt)) {
      return { permission: "allow", additional_context: PSTACK_BYPASS_CONTEXT };
    }

    if (isBackgroundAgent(input)) {
      return { permission: "deny", agent_message: NESTED_MESSAGE };
    }

    const requested =
      typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : FALLBACK_AGENT;
    const task = taskText(toolInput);
    const key = await resolveKey(options);
    const decision = await routeTask(task, key, {
      requestedType: requested,
      ...gateOptions(options),
    });

    if (decision.status === "unavailable") return { permission: "allow" };

    const generationId = generationKey(input);
    const fanout = await (options.noteFanout ?? noteFanout)(generationId, options.home);
    const delegate = decision.needsDelegate;
    const pace = decision.pace ?? "standard";

    if (
      requested === FALLBACK_AGENT &&
      (decision.status !== "routed" || decision.agent === FALLBACK_AGENT) &&
      typeof delegate === "number" &&
      delegate < DELEGATE_THRESHOLD &&
      pace !== "thorough"
    ) {
      return { permission: "deny", agent_message: INLINE_MESSAGE };
    }

    if (fanout > 1 && (delegate === undefined || delegate < FANOUT_THRESHOLD) && pace !== "thorough") {
      return { permission: "deny", agent_message: FANOUT_MESSAGE };
    }

    const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : task;
    const annotated = annotatePrompt(prompt, decision);
    const sameAgent = decision.status !== "routed" || decision.agent === requested;
    if (sameAgent && annotated === prompt) return { permission: "allow" };

    return {
      permission: "allow",
      updated_input: {
        ...toolInput,
        subagent_type: decision.status === "routed" ? decision.agent : requested,
        prompt: annotated,
      },
    };
  } catch {
    return { permission: "allow" };
  }
}

async function handleWriteScope(input, options) {
  const key = await resolveKey(options);
  const ask = await resolveAsk(input, options);
  const verdict = await evaluateGate("scope", writeState(input.tool_input, ask), key, gateOptions(options));
  if (verdict.action === "skip") {
    return { permission: "deny", agent_message: SCOPE_MESSAGE };
  }
  const written = readPathFromInput(input.tool_input);
  if (written) await (options.mergeAllowlist ?? mergeAllowlist)(conversationId(input), [written], options.home);
  return { permission: "allow" };
}

async function handleMcpAdvisory(input, options = {}) {
  try {
    const toolName = String(input?.tool_name ?? "");
    const ask = await resolveAsk(input, options);
    const decision = advisoryMcpDecision(toolName, ask);
    if (decision.permission === "deny") {
      return { permission: "deny", agent_message: decision.agent_message };
    }
    return { permission: "allow" };
  } catch {
    return { permission: "allow" };
  }
}

async function handleReadGate(input, options) {
  const path = readPathFromInput(input.tool_input);
  const readList = options.readAllowlist ?? readAllowlist;
  const allowlist = await readList(conversationId(input), options.home);
  if (!pathAllowed(path, allowlist)) {
    return { permission: "deny", agent_message: READ_DENY_MESSAGE };
  }
  return { permission: "allow" };
}

export async function handlePostToolUse(input, options = {}) {
  try {
    const toolName = String(input?.tool_name ?? "");
    if (isSearchTool(toolName)) return handleSearchRerank(input, options);
    if (!isTaskTool(input)) return {};
    // pstack owns panel aggregation — do not inject STOP_CONTEXT mid-panel.
    const receipt = await resolveReceipt(input, options);
    if (isPstackOwnedReceipt(receipt)) {
      return { additional_context: sufficiencyContext(receipt) };
    }
    const toolInput =
      input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    if (isExplicitOrchestratedTask(toolInput, receipt)) {
      return { additional_context: PSTACK_BYPASS_CONTEXT };
    }
    const raw = input.tool_output ?? input.result ?? input.content ?? "";
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (!text.trim() || looksSecret(text)) return {};

    const key = await resolveKey(options);
    const verdict = await shouldContinue(
      {
        task: taskText(input.tool_input),
        result: truncate(text, 1500),
      },
      key,
      gateOptions(options),
    );
    if (!verdict.continue) return { additional_context: STOP_CONTEXT };
    return {};
  } catch {
    return {};
  }
}

async function handleSearchRerank(input, options) {
  const raw = input.tool_output ?? input.result ?? input.content ?? "";
  if (looksSecret(typeof raw === "string" ? raw : JSON.stringify(raw ?? ""))) return {};
  const candidates = extractCandidates(raw);
  if (candidates.length < 2) return {};
  const key = await resolveKey(options);
  const ask = await resolveAsk(input, options);
  const ranked = await rankCandidates(ask, candidates, key, gateOptions(options));
  if (!ranked.keep.length) return {};
  const keep = await (options.mergeAllowlist ?? mergeAllowlist)(conversationId(input), ranked.keep, options.home);
  const context = rerankContext(keep);
  const result = { additional_context: context };
  const trimmed = trimMcpOutput(raw, keep);
  if (trimmed && String(input?.tool_name ?? "").startsWith("MCP:")) {
    result.updated_mcp_tool_output = trimmed;
  }
  return result;
}

export async function handleBeforeSubmitPrompt(input, options = {}) {
  try {
    const prompt = userPromptFromInput(input);
    const write = options.writeUserAsk ?? writeUserAsk;
    await write(conversationId(input), prompt, options.home);
    const key = await resolveKey(options);
    const classified = await (options.classifyWorkflow ?? classifyWorkflow)(prompt, key, gateOptions(options));
    const writeReceipt = options.writeWorkflowReceipt ?? writeWorkflowReceipt;
    const receipt = await writeReceipt(
      conversationKey(input),
      generationKey(input) || conversationKey(input),
      classified,
      options.home,
    );
    const parts = [];
    if (receipt) parts.push(workflowContext(receipt));
    const verdict = await evaluateGate("split", { ask: prompt }, key, gateOptions(options));
    if (verdict.action === "split") parts.push(SPLIT_CONTEXT);
    if (!parts.length) return {};
    const ctx = parts.join("\n");
    return { additional_context: ctx, agent_message: ctx };
  } catch {
    return {};
  }
}

function hardShellDecision(command) {
  const c = String(command ?? "");
  if (
    /\bgit\s+push\b[^\n]*--force\b/i.test(c) ||
    /\bgit\s+push\b[^\n]*\s-f\b/i.test(c) ||
    /\bgit\s+reset\s+--hard\b/i.test(c) ||
    /\bgit\s+clean\s+-fdx?\b/i.test(c) ||
    /\b(rm|Remove-Item)\b[^\n]*(-rf|--force|Recurse)\b[^\n]*(\.env|credentials|cursor-jev\.env)/i.test(c)
  ) {
    return "deny";
  }
  return null;
}

export async function handleBeforeShellExecution(input, options = {}) {
  try {
    const command = String(input?.command ?? input?.tool_input?.command ?? "");
    const hard = hardShellDecision(command);
    if (hard === "deny") {
      return {
        permission: "deny",
        user_message: HARD_DENY_SHELL_MESSAGE,
        agent_message: HARD_DENY_SHELL_MESSAGE,
      };
    }
    const gated = await enforceWorkflowReceipt(input, "Shell", { command }, options);
    if (gated?.permission === "deny") return gated;
    const key = await resolveKey(options);
    if (isShipCriticalShell(command) && !String(key ?? "").trim()) {
      return {
        permission: "deny",
        user_message: JEV_REQUIRED_SHELL_MESSAGE,
        agent_message: JEV_REQUIRED_SHELL_MESSAGE,
      };
    }
    if (isRoutineShell(command)) return { permission: "allow" };
    const ask = await resolveAsk(input, options);
    const verdict = await evaluateGate("shell", { ask, command: truncate(command, PREVIEW_MAX) }, key, gateOptions(options));
    if (verdict.action === "ask") {
      return {
        permission: "ask",
        user_message: ASK_SHELL_MESSAGE,
        agent_message: ASK_SHELL_MESSAGE,
      };
    }
    return { permission: "allow" };
  } catch {
    return { permission: "allow" };
  }
}

/** beforeMCPExecution — advisory only; fail-open. */
export async function handleBeforeMcpExecution(input, options = {}) {
  try {
    const name = String(input?.tool_name ?? input?.mcp_tool ?? input?.server ?? "");
    const ask = await resolveAsk(input, options);
    const decision = advisoryMcpDecision(name.startsWith("MCP:") ? name : `MCP:${name}`, ask);
    if (decision.permission === "deny") {
      return { permission: "deny", agent_message: decision.agent_message };
    }
    return { permission: "allow" };
  } catch {
    return { permission: "allow" };
  }
}

/**
 * subagentStop — sufficiency context for ordinary agents.
 * Do not auto-steer pstack aggregation.
 */
export async function handleSubagentStop(input, options = {}) {
  try {
    const receipt = await resolveReceipt(input, options);
    return { additional_context: sufficiencyContext(receipt) };
  } catch {
    return {};
  }
}

/** preCompact — advisory preserve list; fail-open. */
export async function handlePreCompact(input, options = {}) {
  try {
    const receipt = await resolveReceipt(input, options);
    const allow = await (options.readAllowlist ?? readAllowlist)(conversationKey(input), options.home);
    return { additional_context: compactPreserveContext(receipt, allow) };
  } catch {
    return {};
  }
}

/**
 * stop: when incomplete, auto-continue via followup_message.
 * When ready (gate action "stop"), allow the agent to finish.
 */
export async function handleStop(input, options = {}) {
  try {
    const status = String(input?.status ?? "completed");
    if (status && status !== "completed") return {};
    const summary =
      userPromptFromInput(input) ||
      truncate(String(input?.response ?? input?.last_assistant_message ?? ""), PREVIEW_MAX);
    if (!summary || looksSecret(summary)) return {};
    const key = await resolveKey(options);
    const ask = await resolveAsk(input, options);
    const verdict = await evaluateGate(
      "ready",
      {
        ask,
        summary,
        files: Array.isArray(input?.files_changed) ? input.files_changed : undefined,
      },
      key,
      gateOptions(options),
    );
    if (verdict.action === "stop") {
      return { additional_context: READY_STOP_CONTEXT };
    }
    if (verdict.error === "missing key") return {};
    return { followup_message: NOT_READY_FOLLOWUP };
  } catch {
    return {};
  }
}

/** @deprecated observational only — kept for older hook configs */
export async function handleAfterAgentResponse(input, options = {}) {
  try {
    const summary = userPromptFromInput(input) || truncate(String(input?.response ?? ""), PREVIEW_MAX);
    if (!summary || looksSecret(summary)) return {};
    const key = await resolveKey(options);
    const ask = await resolveAsk(input, options);
    const verdict = await evaluateGate("ready", { ask, summary }, key, gateOptions(options));
    if (verdict.action === "stop") return { additional_context: READY_STOP_CONTEXT };
    return {};
  } catch {
    return {};
  }
}

export async function handleHook(input, options = {}) {
  const event = eventName(input);
  if (event === "postToolUse") return handlePostToolUse(input, options);
  if (event === "beforeSubmitPrompt") return handleBeforeSubmitPrompt(input, options);
  if (event === "beforeShellExecution") return handleBeforeShellExecution(input, options);
  if (event === "beforeMCPExecution") return handleBeforeMcpExecution(input, options);
  if (event === "subagentStop") return handleSubagentStop(input, options);
  if (event === "preCompact") return handlePreCompact(input, options);
  if (event === "stop") return handleStop(input, options);
  if (event === "afterAgentResponse") return handleAfterAgentResponse(input, options);
  return handlePreToolUse(input, options);
}

export async function runHook(options = {}) {
  const chunks = [];
  for await (const chunk of options.stdin ?? process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8");
  let parsed = {};
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const result = await handleHook(parsed, options);
  const out = options.stdout ?? process.stdout;
  out.write(JSON.stringify(result ?? {}));
}

export { speedContract };
