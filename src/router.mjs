import { systemOne } from "./client.mjs";
import {
  CONFIDENCE_THRESHOLD,
  CONTINUE_QUESTION,
  CONTINUE_THRESHOLD,
  DELEGATE_QUESTION,
  EXPLICIT_ONLY,
  FALLBACK_AGENT,
  MAX_TASK_CHARS,
  PACE_QUESTION,
  ROLE_QUESTION,
  SPECIALIST_NOUL_THRESHOLD,
  SPECIALIST_QUESTION,
  roles,
} from "./roles.mjs";

/**
 * @typedef {{ agent: string, status: "routed" | "uncertain" | "unavailable", confidence?: number, noul?: number, pace?: "fast" | "standard" | "thorough", needsDelegate?: number, reason?: string }} Decision
 */

function fallbackAgent(requested) {
  return requested && requested in roles ? requested : FALLBACK_AGENT;
}

function finish(status, agent, extra = {}) {
  return { agent, status, ...extra };
}

/**
 * @param {string} task
 * @param {string | undefined} key
 * @param {{ requestedType?: string, fetcher?: typeof fetch }} [options]
 * @returns {Promise<Decision>}
 */
export async function routeTask(task, key, options = {}) {
  const requested = typeof options.requestedType === "string" ? options.requestedType : undefined;
  const fallback = fallbackAgent(requested);

  if (!key?.trim()) {
    return finish("unavailable", fallback, {
      reason: "Set TYPESAFE_API_KEY in your environment.",
    });
  }
  if (typeof task !== "string" || !task.trim() || task.length > MAX_TASK_CHARS) {
    return finish("unavailable", fallback, {
      reason: `Supply a task summary of 1–${MAX_TASK_CHARS} characters.`,
    });
  }

  const result = await systemOne({
    state: task,
    questions: {
      role: ROLE_QUESTION,
      needs_specialist: SPECIALIST_QUESTION,
      pace: PACE_QUESTION,
      needs_delegate: DELEGATE_QUESTION,
    },
    key,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
    maxAttempts: options.maxAttempts,
  });

  if (!result.ok) return finish("unavailable", fallback, { reason: result.reason });

  const role = result.data?.answers?.role;
  const specialist = result.data?.answers?.needs_specialist;
  const paceAnswer = result.data?.answers?.pace;
  const delegateAnswer = result.data?.answers?.needs_delegate;
  const pace =
    paceAnswer?.type === "choice" &&
    (paceAnswer.choice === "fast" || paceAnswer.choice === "standard" || paceAnswer.choice === "thorough")
      ? paceAnswer.choice
      : undefined;
  const needsDelegate =
    delegateAnswer?.type === "noul" && typeof delegateAnswer.noul === "number" && Number.isFinite(delegateAnswer.noul)
      ? delegateAnswer.noul
      : undefined;
  const scored = { pace, needsDelegate };

  if (
    role?.type !== "choice" ||
    typeof role.choice !== "string" ||
    !Object.hasOwn(roles, role.choice) ||
    typeof role.confidence !== "number" ||
    !Number.isFinite(role.confidence) ||
    role.confidence < 0 ||
    role.confidence > 1
  ) {
    return finish("uncertain", fallback, { reason: "Invalid routing decision.", ...scored });
  }

  if (role.confidence < CONFIDENCE_THRESHOLD) {
    return finish("uncertain", fallback, { confidence: role.confidence, ...scored });
  }

  const noul =
    specialist?.type === "noul" && typeof specialist.noul === "number" && Number.isFinite(specialist.noul)
      ? specialist.noul
      : undefined;

  if (
    noul !== undefined &&
    noul < SPECIALIST_NOUL_THRESHOLD &&
    fallback === FALLBACK_AGENT &&
    role.choice !== FALLBACK_AGENT
  ) {
    return finish("uncertain", fallback, { confidence: role.confidence, noul, ...scored });
  }

  if (EXPLICIT_ONLY.has(role.choice) && requested !== role.choice) {
    return finish("uncertain", fallback, {
      confidence: role.confidence,
      noul,
      reason: `${role.choice} requires an explicit parent request.`,
      ...scored,
    });
  }

  return finish("routed", role.choice, { confidence: role.confidence, noul, ...scored });
}

export async function shouldContinue(state, key, options = {}) {
  if (!key?.trim()) return { continue: true };
  const result = await systemOne({
    state,
    questions: { continue_needed: CONTINUE_QUESTION },
    key,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
    maxAttempts: options.maxAttempts,
  });
  if (!result.ok) return { continue: true, reason: result.reason };
  const answer = result.data?.answers?.continue_needed;
  const noul =
    answer?.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul)
      ? answer.noul
      : undefined;
  if (typeof noul === "number" && noul < CONTINUE_THRESHOLD) {
    return { continue: false, noul };
  }
  return { continue: true, noul };
}
