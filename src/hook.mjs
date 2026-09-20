import { routeTask } from "./router.mjs";
import { FALLBACK_AGENT } from "./roles.mjs";

const ROUTED_PREFIX = "Jev routed:";

function isTaskTool(input) {
  const name = String(input?.tool_name ?? "");
  return name === "Task" || name === "task";
}

function taskText(toolInput) {
  for (const key of ["prompt", "task", "description"]) {
    const value = toolInput?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function annotatePrompt(prompt, decision) {
  const conf =
    typeof decision.confidence === "number" ? decision.confidence.toFixed(2) : "n/a";
  const line = `${ROUTED_PREFIX} ${decision.agent} status=${decision.status} confidence=${conf}`;
  const body = prompt.startsWith(ROUTED_PREFIX)
    ? prompt.replace(/^Jev routed:[^\n]*(?:\n\n)?/, "")
    : prompt;
  return `${line}\n\n${body}`;
}

/**
 * Cursor preToolUse handler for matcher Task.
 * Fail-open: never deny; rewrite subagent_type only when Jev routes confidently.
 */
export async function handlePreToolUse(input, options = {}) {
  try {
    if (!isTaskTool(input)) return { permission: "allow" };

    const toolInput = input.tool_input && typeof input.tool_input === "object" ? { ...input.tool_input } : {};
    const requested =
      typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : FALLBACK_AGENT;
    const task = taskText(toolInput);
    const key = options.key ?? process.env.TYPESAFE_API_KEY;
    const decision = await routeTask(task, key, {
      requestedType: requested,
      fetcher: options.fetcher,
    });

    if (decision.status !== "routed" || decision.agent === requested) {
      return { permission: "allow" };
    }

    const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : task;
    return {
      permission: "allow",
      updated_input: {
        ...toolInput,
        subagent_type: decision.agent,
        prompt: annotatePrompt(prompt, decision),
      },
    };
  } catch {
    return { permission: "allow" };
  }
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
  const result = await handlePreToolUse(parsed, options);
  const out = options.stdout ?? process.stdout;
  out.write(JSON.stringify(result));
}
