/**
 * Workflow receipt — classifies each generation into a bounded workflow
 * and records who owns orchestration (jev | pstack | aseo).
 *
 * Domain shape (discriminated choice + owner), not scattered booleans.
 */
import { evaluateGate } from "./gates.mjs";
import { HOOK_MAX_ATTEMPTS, HOOK_TIMEOUT_MS } from "./roles.mjs";
import { truncate } from "./session.mjs";

export const WORKFLOW_CHOICES = Object.freeze([
  "DIRECT",
  "ASEO_ANALYSIS",
  "PSTACK",
  "RESEARCH",
  "VERIFY",
  "SHIP",
]);

export const WORKFLOW_OWNERS = Object.freeze(["jev", "pstack", "aseo"]);

export const WORKFLOW_OPTIONS = Object.freeze({
  DIRECT: "Ordinary inline work; Jev assists with gates only",
  ASEO_ANALYSIS: "ASEO Lead SEO/analysis job without pstack engineering fan-out",
  PSTACK: "Explicit pstack engineering (/poteto-mode, arena, swarm, reflect panels)",
  RESEARCH: "Read-only research; no mutating ship",
  VERIFY: "Verification / review / doctor / tests",
  SHIP: "Commit, push, or open a PR",
});

export const OWNER_BY_CHOICE = Object.freeze({
  DIRECT: "jev",
  ASEO_ANALYSIS: "aseo",
  PSTACK: "pstack",
  RESEARCH: "jev",
  VERIFY: "jev",
  SHIP: "jev",
});

export const WORKFLOW_RECEIPT_CONTEXT_PREFIX = "Jev workflow:";
export const WORKFLOW_REQUIRED_MESSAGE =
  "Jev fabric: no workflow receipt for this conversation/generation. Submit the ask through beforeSubmitPrompt (or include /poteto-mode / ship / research markers) so Jev can classify the workflow before Write/Task/mutating Shell.";

const EVIDENCE_OPTIONS = Object.freeze({
  GSC: "Google Search Console observations",
  GA4: "GA4 traffic observations",
  SERP: "SERP / ranking snapshots",
  repo: "Repository source and content",
  orders: "Order / WhatsApp / tracker evidence",
  authority: "ASEO canon / authority docs",
  none: "No external evidence needed",
});

export function normalizeChoice(value) {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (WORKFLOW_CHOICES.includes(raw)) return raw;
  const aliases = {
    POTETO: "PSTACK",
    POTETO_MODE: "PSTACK",
    ENGINEERING: "PSTACK",
    ANALYSIS: "ASEO_ANALYSIS",
    ASEO: "ASEO_ANALYSIS",
    REVIEW: "VERIFY",
    TEST: "VERIFY",
    COMMIT: "SHIP",
    PUSH: "SHIP",
    PR: "SHIP",
  };
  return aliases[raw] ?? null;
}

export function ownerForChoice(choice) {
  return OWNER_BY_CHOICE[choice] ?? "jev";
}

export function isPstackOwnedReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  return receipt.workflow_choice === "PSTACK" && receipt.workflow_owner === "pstack";
}

/**
 * Heuristic fallback when TypeSafe key is missing.
 */
export function heuristicWorkflow(ask) {
  const text = String(ask ?? "");
  if (!text.trim()) {
    return {
      workflow_choice: "DIRECT",
      workflow_owner: "jev",
      reason: "empty ask → DIRECT",
      confidence: 0.4,
      source: "heuristic",
    };
  }
  if (
    /(?:^|[\s"'`])\/(?:poteto-mode|reflect|arena|swarm|interrogate|architect)\b/i.test(text) ||
    /\bJev bypass:\s*pstack\b/i.test(text) ||
    (/\bpstack\b/i.test(text) && /\b(poteto|arena|swarm|reflect)\b/i.test(text))
  ) {
    return {
      workflow_choice: "PSTACK",
      workflow_owner: "pstack",
      reason: "pstack/orchestration marker in ask",
      confidence: 0.92,
      source: "heuristic",
    };
  }
  if (/\b(commit|push|open (a )?pr|pull request|ship(?:per)?|land (?:this|it|the))\b/i.test(text)) {
    return {
      workflow_choice: "SHIP",
      workflow_owner: "jev",
      reason: "ship language in ask",
      confidence: 0.85,
      source: "heuristic",
    };
  }
  if (/\b(research|investigate|how does|why (?:was|is)|read-only|lookup)\b/i.test(text)) {
    return {
      workflow_choice: "RESEARCH",
      workflow_owner: "jev",
      reason: "research language in ask",
      confidence: 0.75,
      source: "heuristic",
    };
  }
  if (/\b(verify|doctor|test suite|run tests|review (?:the )?(?:diff|pr))\b/i.test(text)) {
    return {
      workflow_choice: "VERIFY",
      workflow_owner: "jev",
      reason: "verify language in ask",
      confidence: 0.75,
      source: "heuristic",
    };
  }
  if (/\b(ASEO|GSC|GA4|SEO Lead|hreflang|sitemap|pricing page)\b/i.test(text)) {
    return {
      workflow_choice: "ASEO_ANALYSIS",
      workflow_owner: "aseo",
      reason: "ASEO/SEO analysis language",
      confidence: 0.7,
      source: "heuristic",
    };
  }
  return {
    workflow_choice: "DIRECT",
    workflow_owner: "jev",
    reason: "default ordinary work",
    confidence: 0.55,
    source: "heuristic",
  };
}

/**
 * Classify via Jev Choice when key present; heuristic otherwise.
 */
export async function classifyWorkflow(ask, key, options = {}) {
  const heuristic = heuristicWorkflow(ask);
  if (!String(key ?? "").trim()) return heuristic;

  const verdict = await evaluateGate(
    "pick",
    { ask: truncate(String(ask ?? ""), 4000), options: { ...WORKFLOW_OPTIONS } },
    key,
    {
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs ?? HOOK_TIMEOUT_MS,
      maxAttempts: options.maxAttempts ?? HOOK_MAX_ATTEMPTS,
    },
  );

  const picked = normalizeChoice(verdict.pick);
  if (!picked || verdict.error) return heuristic;

  const confidence =
    typeof verdict.confidence === "number" && Number.isFinite(verdict.confidence)
      ? verdict.confidence
      : 0.8;

  return {
    workflow_choice: picked,
    workflow_owner: ownerForChoice(picked),
    reason: `jev pick=${picked}`,
    confidence,
    source: "jev",
  };
}

export function workflowContext(receipt) {
  if (!receipt) return "";
  const conf =
    typeof receipt.confidence === "number" ? receipt.confidence.toFixed(2) : "n/a";
  const reason = receipt.reason ? ` reason=${truncate(String(receipt.reason), 120)}` : "";
  return `${WORKFLOW_RECEIPT_CONTEXT_PREFIX} ${receipt.workflow_choice} owner=${receipt.workflow_owner} confidence=${conf}${reason}. pstack owns Task/model/panel only when choice=PSTACK owner=pstack; Jev still gates scope/shell/ready.`;
}

export function generationKey(input) {
  return String(input?.generation_id ?? input?.conversation_id ?? input?.session_id ?? "").trim();
}

export function conversationKey(input) {
  return String(input?.conversation_id ?? input?.session_id ?? "").trim();
}

export function isMutatingShell(command) {
  const c = String(command ?? "").trim();
  if (!c) return false;
  if (/^(git\s+(status|diff|log|show|branch)\b|npm\s+(test|run\s+test)\b|node\s+--test\b|ls\b|dir\b|echo\b|type\b|cat\b)/i.test(c)) {
    return false;
  }
  return (
    /\b(git\s+(commit|push|checkout|merge|rebase|reset|add|mv|rm)\b)/i.test(c) ||
    /\b(gh\s+pr\s+(create|merge)\b)/i.test(c) ||
    /\b(npm\s+(publish|install)\b|pnpm\s+(publish|install)\b)/i.test(c) ||
    /\b(rm\b|Remove-Item\b|del\b|mkdir\b|New-Item\b|Move-Item\b|Copy-Item\b|Set-Content\b|Out-File\b|tee\b)/i.test(
      c,
    ) ||
    />\s*[^|]/.test(c)
  );
}

export function requiresWorkflowReceipt(toolName, toolInput, event) {
  const name = String(toolName ?? "");
  const evt = String(event ?? "");
  if (evt === "beforeShellExecution" || (!name && toolInput?.command != null)) {
    return isMutatingShell(toolInput?.command ?? toolInput);
  }
  if (name === "Write" || name === "StrReplace" || name === "Delete") return true;
  if (name === "Task" || name === "task") return true;
  if (name === "Shell" || name === "Bash") {
    return isMutatingShell(toolInput?.command);
  }
  return false;
}

/**
 * Context catalog pick — metadata only (title, path, freshness, blurb).
 */
export async function pickContextSources(ask, catalog, key, options = {}) {
  const items = Array.isArray(catalog) ? catalog.slice(0, 8) : [];
  if (items.length < 2) {
    return { pick: items[0]?.id ?? null, source: "passthrough", error: "need 2–8 catalog entries" };
  }
  const opts = {};
  for (const item of items) {
    const id = String(item.id ?? item.path ?? "").trim();
    if (!id) continue;
    const title = String(item.title ?? id).trim();
    const path = String(item.path ?? "").trim();
    const freshness = String(item.freshness ?? "").trim();
    const blurb = String(item.blurb ?? item.summary ?? "").trim();
    opts[id] = truncate([title, path && `path=${path}`, freshness && `fresh=${freshness}`, blurb].filter(Boolean).join(" | "), 400);
  }
  if (Object.keys(opts).length < 2) {
    return { pick: null, source: "passthrough", error: "need 2–8 named options" };
  }
  if (!String(key ?? "").trim()) {
    return { pick: Object.keys(opts)[0], source: "heuristic", reason: "no key; first catalog entry" };
  }
  const verdict = await evaluateGate(
    "pick",
    { ask: truncate(String(ask ?? ""), 4000), options: opts },
    key,
    options,
  );
  return {
    pick: verdict.pick ?? null,
    confidence: verdict.confidence,
    source: verdict.error ? "heuristic" : "jev",
    error: verdict.error,
  };
}

/**
 * Evidence/tool pick for SEO observation sources. Does NOT decide create/delete/pricing.
 */
export async function pickEvidenceSources(ask, key, options = {}) {
  if (!String(key ?? "").trim()) {
    const h = heuristicWorkflow(ask);
    if (h.workflow_choice === "ASEO_ANALYSIS") {
      return { pick: "GSC", source: "heuristic", reason: "ASEO ask without key → GSC first" };
    }
    return { pick: "repo", source: "heuristic", reason: "no key → repo" };
  }
  const verdict = await evaluateGate(
    "pick",
    { ask: truncate(String(ask ?? ""), 4000), options: { ...EVIDENCE_OPTIONS } },
    key,
    options,
  );
  const pick = typeof verdict.pick === "string" ? verdict.pick : null;
  return {
    pick: pick && EVIDENCE_OPTIONS[pick] ? pick : "repo",
    confidence: verdict.confidence,
    source: verdict.error ? "heuristic" : "jev",
    error: verdict.error,
  };
}

export { EVIDENCE_OPTIONS };

/**
 * Advisory MCP relevance — fail-open.
 */
export function advisoryMcpDecision(serverTool, ask) {
  const name = String(serverTool ?? "");
  const a = String(ask ?? "");
  if (!name) return { permission: "allow", reason: "empty tool" };
  // Clearly irrelevant: Datadog/Figma/Notion when ask is pure local git/hooks work with no mention.
  if (
    /^MCP:(plugin-datadog|plugin-figma|plugin-notion)/i.test(name) &&
    a &&
    !/\b(datadog|figma|notion|monitor|design|ticket)\b/i.test(a) &&
    /\b(hook|jev|pstack|git|commit|doctor|workflow receipt)\b/i.test(a)
  ) {
    return {
      permission: "deny",
      agent_message: `Jev advisory: ${name} looks irrelevant to this ask. Prefer repo tools; call again if you need it.`,
      reason: "irrelevant_mcp",
    };
  }
  return { permission: "allow", reason: "pass" };
}

export function sufficiencyContext(receipt) {
  if (isPstackOwnedReceipt(receipt)) {
    return "Jev: pstack owns aggregation for this generation. Do not auto-steer panel synthesis; finish the pstack playbook.";
  }
  return "Jev: the subagent result is likely enough. Prefer finishing the user ask over another Task. Use jev_judge for closed gaps.";
}

export function compactPreserveContext(receipt, paths = []) {
  const lines = ["Jev preCompact advisory — prefer keeping:"];
  if (receipt) {
    lines.push(
      `- workflow ${receipt.workflow_choice} owner=${receipt.workflow_owner} (${receipt.reason ?? "receipt"})`,
    );
  }
  for (const p of paths.slice(0, 12)) {
    lines.push(`- ${p}`);
  }
  if (lines.length === 1) lines.push("- the current user ask and workflow receipt");
  return lines.join("\n");
}
