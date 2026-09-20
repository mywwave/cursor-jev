import { MODEL, REQUEST_TIMEOUT_MS } from "./roles.mjs";

export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const MODELS_URL = "https://api.typesafe.ai/v1/models";

const RETRY_STATUSES = new Set([429, 529]);
const RETRY_DELAYS_MS = [0, 400, 800];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError";
}

/**
 * @param {{ state: unknown, questions: Record<string, unknown>, key: string, fetcher?: typeof fetch, model?: string }} input
 * @returns {Promise<{ ok: true, data: object } | { ok: false, reason: string, status?: number }>}
 */
export async function systemOne({
  state,
  questions,
  key,
  fetcher = fetch,
  model = MODEL,
}) {
  let lastReason = "TypeSafe request failed or timed out.";

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt]) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      const response = await fetcher(SYSTEM_ONE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ model, state, questions }),
      });

      if (RETRY_STATUSES.has(response.status)) {
        lastReason = `TypeSafe HTTP ${response.status}.`;
        continue;
      }
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          reason: `TypeSafe HTTP ${response.status}.`,
        };
      }
      return { ok: true, data: await response.json() };
    } catch (err) {
      if (isAbort(err)) {
        return { ok: false, reason: "TypeSafe request failed or timed out." };
      }
      lastReason = "TypeSafe request failed or timed out.";
    }
  }

  return { ok: false, reason: lastReason };
}

export async function listModels({ key, fetcher = fetch }) {
  try {
    const response = await fetcher(MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, reason: `TypeSafe HTTP ${response.status}.` };
    }
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, reason: "TypeSafe request failed or timed out." };
  }
}
