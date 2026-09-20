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
import { mergeAllowlist, readAllowlist, readUserAsk, writeUserAsk } from "./store.mjs";

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
export const READ_DENY_MESSAGE =
  "Jev: this file was not in the reranked shortlist. Read a kept path first, or search again if the ask changed.";

function isTaskTool(input) {
  const name = String(input?.tool_name ?? "");
  return name === "Task" || name === "task";
}

function eventName(input) {
  const named = String(input?.hook_event_name ?? input?.event ?? "").trim();
  if (named) return named;
  if (input?.tool_output != null || (input?.tool_name && input?.result != null)) return "postToolUse";
  if (input?.command && !input?.tool_name) return "beforeShellExecution";
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
 * Fail-open: never crash the agent.
 */
export async function handlePreToolUse(input, options = {}) {
  try {
    const toolName = String(input?.tool_name ?? "");
    if (isWriteTool(toolName)) return handleWriteScope(input, options);
    if (isReadTool(toolName)) return handleReadGate(input, options);
    if (!isTaskTool(input)) return { permission: "allow" };

    if (isBackgroundAgent(input)) {
      return { permission: "deny", agent_message: NESTED_MESSAGE };
    }

    const toolInput = input.tool_input && typeof input.tool_input === "object" ? { ...input.tool_input } : {};
    const requested =
      typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : FALLBACK_AGENT;
    const task = taskText(toolInput);
    const key = await resolveKey(options);
    const decision = await routeTask(task, key, {
      requestedType: requested,
      ...gateOptions(options),
    });

    if (decision.status === "unavailable") return { permission: "allow" };

    const generationId = String(input.generation_id ?? input.conversation_id ?? "");
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
    const verdict = await evaluateGate("split", { ask: prompt }, key, gateOptions(options));
    if (verdict.action === "split") {
      return { additional_context: SPLIT_CONTEXT, agent_message: SPLIT_CONTEXT };
    }
    return {};
  } catch {
    return {};
  }
}

export async function handleBeforeShellExecution(input, options = {}) {
  try {
    const command = String(input?.command ?? input?.tool_input?.command ?? "");
    if (isRoutineShell(command)) return { permission: "allow" };
    const key = await resolveKey(options);
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
