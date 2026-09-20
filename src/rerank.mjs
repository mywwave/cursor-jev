import { systemOne } from "./client.mjs";
import {
  HOOK_MAX_ATTEMPTS,
  HOOK_TIMEOUT_MS,
  RERANK_FOCUS_CONFIDENCE,
  RERANK_KEEP_K,
  RERANK_MAX_CANDIDATES,
  RERANK_SCORE_KEEP,
  RERANK_SNIPPET_MAX,
  USER_ASK_MAX,
} from "./roles.mjs";
import { looksSecret, truncate } from "./session.mjs";
import { sanitizeGateState } from "./gates.mjs";

const SEARCH_TOOLS = new Set(["Grep", "Glob", "SemanticSearch", "codebase_search", "CodebaseSearch"]);
const CODE_EXT =
  /\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|kt|rb|php|cs|cpp|cc|h|hpp|md|mdc|json|yml|yaml|toml|css|scss|html|vue|svelte|sql|sh|ps1)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|coverage|\.next|out)\//;

export const RELEVANT_FILE_QUESTION = {
  type: "score",
  instructions:
    "How necessary is Reading this one file to satisfy the user ask? Use the path and snippet. Prefer the implementation that contains the behavior. README, contributing, logos, and sibling files that merely mention the topic are not enough.",
  criteria: [
    "Do not Read: unrelated, generated, docs, assets, or background",
    "Same area of the repo, but the ask can be done without opening this file",
    "Must Read: this file likely contains the code or config to change",
  ],
};

export function isReadTool(name) {
  const n = String(name ?? "");
  return n === "Read" || n === "read_file";
}

export function isSearchTool(name) {
  const n = String(name ?? "");
  if (SEARCH_TOOLS.has(n)) return true;
  return /codegraph/i.test(n);
}

export function normalizePath(path) {
  return String(path ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/(?<!:)\/+/g, "/");
}

export function skipPath(path) {
  const raw = String(path ?? "").trim();
  if (/^https?:\/\//i.test(raw)) return true;
  const n = normalizePath(path);
  if (!n || n.length > 400) return true;
  if (/^https?:\/\//i.test(n)) return true;
  if (!CODE_EXT.test(n)) return true;
  if (SKIP_DIR.test(n)) return true;
  if (looksSecret(n)) return true;
  return false;
}

export function pathAllowed(path, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const n = normalizePath(path);
  if (!n) return true;
  return allowlist.some((kept) => {
    const k = normalizePath(kept);
    if (!k) return false;
    return n === k || n.endsWith(`/${k}`) || k.endsWith(`/${n}`);
  });
}

function pushCandidate(list, seen, path, snippet) {
  const n = normalizePath(path);
  if (!n || skipPath(n) || seen.has(n)) return;
  seen.add(n);
  list.push({
    path: n,
    snippet: truncate(String(snippet ?? "").replace(/\s+/g, " ").trim(), RERANK_SNIPPET_MAX),
  });
}

function walkForPaths(value, list, seen, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    if (value.includes("/") || value.includes("\\")) pushCandidate(list, seen, value, "");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkForPaths(item, list, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const path = value.path ?? value.file_path ?? value.filePath ?? value.filename ?? value.uri;
  if (typeof path === "string") {
    pushCandidate(list, seen, path, value.snippet ?? value.content ?? value.line ?? "");
  }
  for (const nested of Object.values(value)) walkForPaths(nested, list, seen, depth + 1);
}

export function extractCandidates(raw, max = RERANK_MAX_CANDIDATES) {
  const list = [];
  const seen = new Set();
  if (raw && typeof raw === "object") walkForPaths(raw, list, seen);
  const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
  if (looksSecret(text)) return [];
  if (typeof raw !== "object") {
    try {
      walkForPaths(JSON.parse(text), list, seen);
    } catch {
      /* not JSON */
    }
  }
  const lineRe =
    /(?:^|[\s`"'(])((?:[A-Za-z]:)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][\w.-]*)(?::(\d+):([^\n]*))?/gm;
  let match;
  while ((match = lineRe.exec(text))) {
    pushCandidate(list, seen, match[1], match[3] ?? "");
  }
  const baseRe = /(?:^|[\n\s])([\w.@-]+\.[A-Za-z][\w.-]*)(?::\d+:([^\n]*))/gm;
  while ((match = baseRe.exec(text))) {
    pushCandidate(list, seen, match[1], match[2] ?? "");
  }
  const winRe = /(?:^|[\s`"'(])((?:[A-Za-z]:)?(?:[\w.@-]+\\)+[\w.@-]+\.[A-Za-z][\w.-]*)/gm;
  while ((match = winRe.exec(text))) {
    pushCandidate(list, seen, match[1], "");
  }
  return list.slice(0, max);
}

export function readPathFromInput(toolInput) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  return normalizePath(input.path ?? input.file_path ?? input.filePath ?? input.target_file ?? "");
}

function scoreOf(answer) {
  if (answer?.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score)) {
    return answer.score;
  }
  return 0;
}

export function isDocPath(path) {
  const n = normalizePath(path);
  const base = n.split("/").pop() ?? "";
  return /^(readme|contributing|changelog|license|copying)(\.|$)/i.test(base);
}

export function askWantsDocs(ask) {
  return /\b(readme|docs?|documentation|contributing|changelog|license)\b/i.test(String(ask ?? ""));
}

export function overlapScore(path, snippet, ask) {
  const hay = `${path} ${snippet}`.toLowerCase();
  const tokens = String(ask ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3);
  if (!tokens.length) return 0;
  return tokens.filter((token) => hay.includes(token)).length;
}

export function selectKeep(ranked, options = {}) {
  const ask = options.ask ?? "";
  const keepK = options.keepK ?? RERANK_KEEP_K;
  const minScore = options.minScore ?? RERANK_SCORE_KEEP;
  const docsOk = askWantsDocs(ask);
  const rows = ranked
    .filter((row) => docsOk || !isDocPath(row.path))
    .map((row) => ({
      ...row,
      overlap: overlapScore(row.path, row.snippet ?? "", ask),
    }))
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap);

  const kept = [];
  const push = (path) => {
    const n = normalizePath(path);
    if (!n || kept.includes(n)) return;
    if (!docsOk && isDocPath(n)) return;
    kept.push(n);
  };

  const eligible = rows.filter((row) => row.score >= minScore);
  const bestOverlap = eligible.reduce((max, row) => Math.max(max, row.overlap), 0);
  const sliced = bestOverlap > 0 ? eligible.filter((row) => row.overlap > 0) : eligible;

  const focus = options.focus ? normalizePath(options.focus) : "";
  const focusOk = (options.focusConfidence ?? 0) >= RERANK_FOCUS_CONFIDENCE;
  if (focus && focusOk) push(focus);

  for (const row of sliced) {
    if (kept.length >= keepK) break;
    push(row.path);
  }
  return kept;
}

function focusQuestion(files) {
  const criteria = {};
  for (let i = 0; i < files.length; i++) {
    const snippet = files[i].snippet ? ` — ${files[i].snippet}` : "";
    criteria[`c${i}`] = `${files[i].path}${snippet}`;
  }
  return {
    type: "choice",
    instructions:
      "Pick the single best file to Read first. Prefer the implementation that contains the user-ask behavior. Do not pick README, contributing, or assets unless the ask is documentation.",
    criteria,
  };
}

/**
 * @returns {Promise<{ keep: string[], ranked: { path: string, score: number, snippet: string }[], error?: string }>}
 */
export async function rankCandidates(ask, candidates, key, options = {}) {
  const files = (candidates ?? []).filter((item) => item?.path && !skipPath(item.path)).slice(0, RERANK_MAX_CANDIDATES);
  if (!key?.trim() || files.length === 0) return { keep: [], ranked: [] };

  const questions = {};
  for (let i = 0; i < files.length; i++) questions[`c${i}`] = RELEVANT_FILE_QUESTION;
  if (files.length >= 2 && files.length <= 8) questions.focus = focusQuestion(files);

  const result = await systemOne({
    state: sanitizeGateState({
      ask: truncate(String(ask ?? ""), USER_ASK_MAX),
      rule: "Most search hits are noise. Only files whose snippet shows the behavior to change should score as must-Read. Docs and logos are not implementation.",
      files: files.map((item, i) => ({ id: `c${i}`, path: item.path, snippet: item.snippet ?? "" })),
    }),
    questions,
    key,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs ?? HOOK_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? HOOK_MAX_ATTEMPTS,
  });
  if (!result.ok) return { keep: [], ranked: [], error: result.reason };

  const answers = result.data?.answers && typeof result.data.answers === "object" ? result.data.answers : {};
  const ranked = files.map((item, i) => ({
    path: item.path,
    snippet: item.snippet ?? "",
    score: scoreOf(answers[`c${i}`]),
  }));
  const focusAnswer = answers.focus;
  const focusId = focusAnswer?.type === "choice" && typeof focusAnswer.choice === "string" ? focusAnswer.choice : "";
  const focusIndex = /^c(\d+)$/.exec(focusId);
  const focus = focusIndex ? files[Number(focusIndex[1])]?.path : "";
  const keep = selectKeep(ranked, {
    ask,
    focus,
    focusConfidence: typeof focusAnswer?.confidence === "number" ? focusAnswer.confidence : 0,
  });
  ranked.sort((a, b) => b.score - a.score || overlapScore(b.path, b.snippet, ask) - overlapScore(a.path, a.snippet, ask));
  return { keep, ranked };
}

export function rerankContext(keep) {
  if (!keep?.length) return "";
  const lines = keep.map((path) => `- ${path}`).join("\n");
  return `Jev rerank: Read these first:\n${lines}\nDo not Read other search hits unless the user ask requires them.`;
}

export function trimMcpOutput(raw, keep) {
  if (!keep?.length) return undefined;
  const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw, null, 2);
  if (text.length < 8000) return undefined;
  const needles = keep.map((path) => normalizePath(path)).filter(Boolean);
  const chunks = text.split(/\n(?=\S)/);
  const kept = chunks.filter((chunk) => needles.some((path) => chunk.includes(path) || chunk.includes(path.split("/").pop() ?? "")));
  if (kept.length === 0 || kept.join("\n").length < text.length * 0.15) return undefined;
  const next = kept.join("\n");
  if (next.length >= text.length * 0.95) return undefined;
  return `${rerankContext(keep)}\n\n${truncate(next, 12000)}`;
}
