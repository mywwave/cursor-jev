import { systemOne } from "./client.mjs";
import {
  COMPOUND_THRESHOLD,
  DESTRUCTIVE_ASK_THRESHOLD,
  DESTRUCTIVE_THRESHOLD,
  HOOK_MAX_ATTEMPTS,
  HOOK_TIMEOUT_MS,
  PREVIEW_MAX,
  READY_STOP_THRESHOLD,
  SCOPE_DENY_THRESHOLD,
} from "./roles.mjs";
import { looksSecret, truncate } from "./session.mjs";

export function isWriteTool(name) {
  const n = String(name ?? "");
  return n === "Write" || n === "StrReplace" || n === "Delete";
}

export function isRoutineShell(command) {
  const c = String(command ?? "").trim();
  if (!c) return true;
  if (/\b(reset\s+--hard|push\s+--force|-rf\b|drop\s+|format-volume)\b/i.test(c)) return false;
  return /^(git\s+(status|diff|log|show|branch)\b|npm\s+(test|run\s+test)\b|node\s+--test\b|pytest\b|ls\b|dir\b|echo\b|type\b|cat\b)/i.test(
    c,
  );
}

export const GATE_KINDS = ["scope", "pick", "ready", "split"];

export const SCOPE_QUESTION = {
  type: "noul",
  instructions: "Does this planned change belong in the user's current request?",
  criteria: {
    true: "The path and change are required to satisfy the user ask",
    false: "Extra refactor, new files, extra tests, or work the user did not ask for",
  },
};

export const READY_SHIP_QUESTION = {
  type: "score",
  instructions: "How complete is the work relative to the user ask?",
  criteria: [
    "Not ready: missing required changes",
    "Several files still in progress",
    "Local edit that satisfies the ask; stop adding files",
  ],
};

export const TESTS_COVER_QUESTION = {
  type: "noul",
  instructions: "Do the current tests cover this change well enough to stop?",
  criteria: {
    true: "Existing or added tests cover the behavior that changed",
    false: "Required tests are missing or the change is untested",
  },
};

export const CAN_COMMIT_QUESTION = {
  type: "noul",
  instructions: "Is it appropriate to commit or hand the work back now?",
  criteria: {
    true: "The user ask is met; do not add extra files or refactors",
    false: "Required work is still missing",
  },
};

export const COMPOUND_QUESTION = {
  type: "noul",
  instructions:
    "Does this user request contain several independent tasks that should be sequenced rather than mixed in one pass?",
  criteria: {
    true: "Two or more separable jobs (unrelated files, unrelated goals)",
    false: "One coherent job that should stay in a single pass",
  },
};

export const DESTRUCTIVE_QUESTION = {
  type: "noul",
  instructions: "Would this shell command destroy, overwrite, force-push, or leak secrets?",
  criteria: {
    true: "rm, reset --hard, push --force, drop, format, or similar",
    false: "Read-only or a routine test/build command",
  },
};

export const MATCHES_ASK_QUESTION = {
  type: "noul",
  instructions: "Is this command clearly what the user asked for?",
  criteria: {
    true: "The user explicitly asked for this command or its obvious equivalent",
    false: "The command is extra, guessed, or broader than the ask",
  },
};

export function pickQuestion(options) {
  return {
    type: "choice",
    instructions: "Pick the single best option for the user ask. Do not invent options.",
    criteria: options,
  };
}

export function sanitizeGateState(state) {
  if (state == null) return {};
  if (typeof state === "string") {
    if (looksSecret(state)) return { omitted: true };
    return { text: truncate(state, PREVIEW_MAX) };
  }
  if (typeof state !== "object" || Array.isArray(state)) return { value: truncate(JSON.stringify(state), PREVIEW_MAX) };
  const next = {};
  for (const [key, value] of Object.entries(state)) {
    if (value == null) continue;
    if (typeof value === "string") {
      if (looksSecret(value)) continue;
      next[key] = truncate(value, key === "preview" || key === "summary" ? PREVIEW_MAX : 4000);
    } else if (typeof value === "number" || typeof value === "boolean") {
      next[key] = value;
    } else if (key === "options" && value && typeof value === "object" && !Array.isArray(value)) {
      next.options = value;
    } else if (key === "files" && Array.isArray(value)) {
      next.files = value.slice(0, 16).map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const path = typeof item.path === "string" && !looksSecret(item.path) ? truncate(item.path, 400) : "";
        if (!path) return null;
        const snippet =
          typeof item.snippet === "string" && !looksSecret(item.snippet) ? truncate(item.snippet, PREVIEW_MAX) : "";
        const id = typeof item.id === "string" ? truncate(item.id, 16) : "";
        return { id, path, snippet };
      }).filter(Boolean);
    } else {
      const encoded = JSON.stringify(value);
      if (!looksSecret(encoded)) next[key] = truncate(encoded, PREVIEW_MAX);
    }
  }
  return next;
}

export function validatePickOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return "pick requires options as an object of 2–8 named choices.";
  }
  const keys = Object.keys(options);
  if (keys.length < 2 || keys.length > 8) return "pick requires 2–8 options.";
  for (const key of keys) {
    if (typeof options[key] !== "string" || !options[key].trim()) {
      return `pick option "${key}" must be a non-empty string.`;
    }
  }
  return null;
}

function noulOf(answer) {
  if (answer?.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul)) {
    return answer.noul;
  }
  return undefined;
}

function scoreOf(answer) {
  if (answer?.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score)) {
    return answer.score;
  }
  return undefined;
}

function choiceOf(answer) {
  if (answer?.type === "choice" && typeof answer.choice === "string") return answer.choice;
  return undefined;
}

function questionsFor(kind, state) {
  if (kind === "scope") return { in_scope: SCOPE_QUESTION };
  if (kind === "ready") {
    return {
      ship: READY_SHIP_QUESTION,
      tests_cover: TESTS_COVER_QUESTION,
      can_commit: CAN_COMMIT_QUESTION,
    };
  }
  if (kind === "split") return { compound: COMPOUND_QUESTION };
  if (kind === "shell") {
    return { destructive: DESTRUCTIVE_QUESTION, matches_ask: MATCHES_ASK_QUESTION };
  }
  if (kind === "pick") return { pick: pickQuestion(state.options) };
  return null;
}

function decide(kind, answers) {
  if (kind === "scope") {
    const inScope = noulOf(answers.in_scope);
    if (typeof inScope === "number" && inScope < SCOPE_DENY_THRESHOLD) {
      return { action: "skip", inScope };
    }
    return { action: "allow", inScope };
  }
  if (kind === "pick") {
    const pick = choiceOf(answers.pick);
    return { action: "allow", pick, confidence: answers.pick?.confidence };
  }
  if (kind === "ready") {
    const ship = scoreOf(answers.ship);
    const testsCover = noulOf(answers.tests_cover);
    const canCommit = noulOf(answers.can_commit);
    if (
      typeof ship === "number" &&
      ship >= READY_STOP_THRESHOLD &&
      typeof canCommit === "number" &&
      canCommit >= 0.7
    ) {
      return { action: "stop", ship, testsCover, canCommit };
    }
    return { action: "allow", ship, testsCover, canCommit };
  }
  if (kind === "split") {
    const compound = noulOf(answers.compound);
    if (typeof compound === "number" && compound >= COMPOUND_THRESHOLD) {
      return { action: "split", compound };
    }
    return { action: "allow", compound };
  }
  if (kind === "shell") {
    const destructive = noulOf(answers.destructive);
    const matchesAsk = noulOf(answers.matches_ask);
    if (
      typeof destructive === "number" &&
      destructive >= DESTRUCTIVE_THRESHOLD &&
      (matchesAsk === undefined || matchesAsk < DESTRUCTIVE_ASK_THRESHOLD)
    ) {
      return { action: "ask", destructive, matchesAsk };
    }
    return { action: "allow", destructive, matchesAsk };
  }
  return { action: "allow" };
}

/**
 * @returns {Promise<{ kind: string, answers: object, action: string, error?: string }>}
 */
export async function evaluateGate(kind, state, key, options = {}) {
  if (!GATE_KINDS.includes(kind) && kind !== "shell") {
    return { kind, answers: {}, action: "allow", error: `Unknown gate kind: ${kind}` };
  }
  if (kind === "pick") {
    const bad = validatePickOptions(state?.options);
    if (bad) return { kind, answers: {}, action: "allow", error: bad };
  }
  if (!key?.trim()) return { kind, answers: {}, action: "allow", error: "missing key" };

  const clean = sanitizeGateState(state);
  const questions = questionsFor(kind, clean);
  const result = await systemOne({
    state: clean,
    questions,
    key,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs ?? HOOK_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? HOOK_MAX_ATTEMPTS,
  });
  if (!result.ok) return { kind, answers: {}, action: "allow", error: result.reason };

  const answers = result.data?.answers && typeof result.data.answers === "object" ? result.data.answers : {};
  return { kind, answers, ...decide(kind, answers) };
}
