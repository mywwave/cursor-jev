import { systemOne } from "./client.mjs";
import {
  CONFIDENCE_THRESHOLD,
  EXPLICIT_ONLY,
  FALLBACK_AGENT,
  MAX_TASK_CHARS,
  ROLE_QUESTION,
  SPECIALIST_NOUL_THRESHOLD,
  SPECIALIST_QUESTION,
  roles,
} from "./roles.mjs";

/**
 * @typedef {{ agent: string, status: "routed" | "uncertain" | "unavailable", confidence?: number, noul?: number, reason?: string }} Decision
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
    questions: { role: ROLE_QUESTION, needs_specialist: SPECIALIST_QUESTION },
    key,
    fetcher: options.fetcher,
  });

  if (!result.ok) return finish("unavailable", fallback, { reason: result.reason });

  const role = result.data?.answers?.role;
  const specialist = result.data?.answers?.needs_specialist;
  if (
    role?.type !== "choice" ||
    typeof role.choice !== "string" ||
    !Object.hasOwn(roles, role.choice) ||
    typeof role.confidence !== "number" ||
    !Number.isFinite(role.confidence) ||
    role.confidence < 0 ||
    role.confidence > 1
  ) {
    return finish("uncertain", fallback, { reason: "Invalid routing decision." });
  }

  if (role.confidence < CONFIDENCE_THRESHOLD) {
    return finish("uncertain", fallback, { confidence: role.confidence });
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
    return finish("uncertain", fallback, { confidence: role.confidence, noul });
  }

  if (EXPLICIT_ONLY.has(role.choice) && requested !== role.choice) {
    return finish("uncertain", fallback, {
      confidence: role.confidence,
      noul,
      reason: `${role.choice} requires an explicit parent request.`,
    });
  }

  return finish("routed", role.choice, { confidence: role.confidence, noul });
}
