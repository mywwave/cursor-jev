import { evaluateGate, GATE_KINDS } from "./gates.mjs";
import { systemOne } from "./client.mjs";
import { CONSOLE_URL, serverInfo, serverIcons, readLogoSvg } from "./identity.mjs";
import { resolveKey, writeStoredKey } from "./key.mjs";
import { routeTask } from "./router.mjs";
import { MAX_TASK_CHARS } from "./roles.mjs";

const PROTOCOL = "2024-11-05";
const MISSING_KEY =
  "TypeSafe is not connected. Open Customize → Plugins → Jev → Configure, or run `node bin/cli.mjs set-key`, or call jev_auth. Get a key at https://console.typesafe.ai";

function toolIcons() {
  try {
    return serverIcons(readLogoSvg());
  } catch {
    return [];
  }
}

export const TOOLS = [
  {
    name: "jev_auth",
    title: "Connect TypeSafe",
    description:
      "Authorize Jev with a TypeSafe API key. Opens a Cursor form (or tells the user how to Configure the Jev plugin). Call this when TypeSafe returns unauthorized or a missing key.",
    icons: toolIcons(),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "jev_route",
    title: "Route subagent",
    description:
      "Ask TypeSafe Jev to select a Cursor subagent type for a bounded task. Returns a role, pace, and whether a subagent hop is worth it. Prefer jev_ask over launching Task when the hop is not worth it. Send a concise task summary, never secrets or a full transcript.",
    icons: toolIcons(),
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1, maxLength: MAX_TASK_CHARS },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_ask",
    title: "Ask Jev",
    description:
      "Evaluate state with TypeSafe Jev typed questions (choice, score, noul). Returns structured answers your code can branch on. Do not send secrets, API keys, or full transcripts.",
    icons: toolIcons(),
    inputSchema: {
      type: "object",
      properties: {
        state: {},
        questions: { type: "object" },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_judge",
    title: "Judge with Jev",
    description:
      "Preset TypeSafe gates: scope (keep the edit in the user ask), pick (choose one of 2–8 options), ready (stop vs keep going), split (compound request). Prefer this over inventing jev_ask questions. Do not send secrets or transcripts.",
    icons: toolIcons(),
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["scope", "pick", "ready", "split"] },
        state: { type: "object" },
      },
      required: ["kind", "state"],
      additionalProperties: false,
    },
  },
];

const PROMPTS = [
  {
    name: "connect-typesafe",
    title: "Connect TypeSafe",
    description: "Walk through authorizing the Jev MCP with a TypeSafe API key.",
    arguments: [],
  },
  {
    name: "route-task",
    title: "Route a task",
    description: "Ask Jev which Cursor subagent should handle a task.",
    arguments: [{ name: "task", description: "Short task summary", required: true }],
  },
];

function okText(id, text) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }] },
  };
}

function errText(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const QUESTION_TYPES = new Set(["choice", "score", "noul"]);

function invalidQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return "questions must be an object of named TypeSafe questions.";
  }
  const keys = Object.keys(questions);
  if (keys.length === 0) return "questions must include at least one question.";
  for (const key of keys) {
    const q = questions[key];
    if (!q || typeof q !== "object" || !QUESTION_TYPES.has(q.type)) {
      return `Question "${key}" must have type choice, score, or noul.`;
    }
    if (q.type === "choice" && (q.criteria == null || typeof q.criteria !== "object" || Array.isArray(q.criteria))) {
      return `Question "${key}" choice criteria must be an object of options.`;
    }
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) {
      return `Question "${key}" score criteria must be an array of at least two levels.`;
    }
  }
  return null;
}

export function authElicitParams() {
  return {
    mode: "form",
    message: `Connect TypeSafe so Jev can route Cursor subagents.\n\nCreate an API key at ${CONSOLE_URL}, then paste it below. Cursor stores it locally in ~/.cursor/cursor-jev.env — not in git.`,
    requestedSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          title: "TypeSafe API key",
          description: "Usually starts with apikey_",
        },
      },
      required: ["apiKey"],
    },
  };
}

async function elicitApiKey(session) {
  if (!session?.elicit) return { ok: false, reason: MISSING_KEY };
  const result = await session.elicit(authElicitParams());
  const action = result?.action;
  const apiKey = String(result?.content?.apiKey ?? "").trim();
  if (action !== "accept" || !apiKey) {
    return { ok: false, reason: "TypeSafe authorization was cancelled." };
  }
  await writeStoredKey(apiKey, { home: session.home });
  if (session.env) session.env.TYPESAFE_API_KEY = apiKey;
  return { ok: true, key: apiKey };
}

async function requireKey(options) {
  const existing = await resolveKey(options);
  if (existing) return { ok: true, key: existing };
  return elicitApiKey(options.session);
}

async function callTool(name, args, options) {
  if (name === "jev_auth") {
    const authed = await elicitApiKey(options.session);
    if (!authed.ok) return { error: authed.reason };
    return { text: "TypeSafe connected. Jev can route subagents and answer typed questions." };
  }

  const authed = await requireKey(options);
  if (!authed.ok) return { error: authed.reason };

  if (name === "jev_route") {
    const task = args?.task;
    if (typeof task !== "string") return { error: "task must be a string." };
    const decision = await routeTask(task, authed.key);
    return { text: JSON.stringify(decision) };
  }
  if (name === "jev_ask") {
    const bad = invalidQuestions(args?.questions);
    if (bad) return { error: bad };
    if (args.state == null) return { error: "state is required." };
    const result = await systemOne({
      state: args.state,
      questions: args.questions,
      key: authed.key,
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
    });
    if (!result.ok) {
      if (result.status === 401) return { error: MISSING_KEY };
      return { error: result.reason };
    }
    return { text: JSON.stringify(result.data) };
  }
  if (name === "jev_judge") {
    const kind = args?.kind;
    if (!GATE_KINDS.includes(kind)) return { error: "kind must be scope, pick, ready, or split." };
    if (args.state == null || typeof args.state !== "object" || Array.isArray(args.state)) {
      return { error: "state must be an object." };
    }
    const verdict = await evaluateGate(kind, args.state, authed.key, options);
    if (verdict.error && verdict.error.startsWith("pick ")) return { error: verdict.error };
    return { text: JSON.stringify(verdict) };
  }
  return { error: `Unknown tool: ${name}` };
}

function promptMessages(name, promptArgs = {}) {
  if (name === "connect-typesafe") {
    return {
      description: "Authorize TypeSafe Jev",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Call MCP jev_auth so I can paste a TypeSafe API key from ${CONSOLE_URL}. Then confirm Jev is connected.`,
          },
        },
      ],
    };
  }
  if (name === "route-task") {
    const task = String(promptArgs.task ?? "").trim() || "(describe the task)";
    return {
      description: "Route a task with Jev",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Call jev_route with this task summary, then launch the returned Cursor subagent_type:\n\n${task}`,
          },
        },
      ],
    };
  }
  return null;
}

export async function handleRpc(message, options = {}) {
  if (!message || message.jsonrpc !== "2.0") return null;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }
  if (isNotification) return null;

  if (method === "initialize") {
    if (options.session) {
      options.session.clientCapabilities = params?.capabilities ?? {};
    }
    const version = params?.protocolVersion || PROTOCOL;
    let svg;
    try {
      svg = readLogoSvg();
    } catch {
      svg = "";
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: version,
        instructions:
          "Jev is TypeSafe System One, not a chat model. Use jev_auth to connect, jev_route to pick a subagent, jev_judge for scope/pick/ready/split gates, and jev_ask for custom Choice/Score/Noul. Prefer jev_judge over extra Task hops. Never send secrets as state.",
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
        serverInfo: serverInfo({ version: options.version ?? "0.1.0", svg: svg || undefined }),
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const result = await callTool(name, args, options);
      if (result.error) return errText(id, result.error);
      return okText(id, result.text);
    } catch {
      return errText(id, "TypeSafe request failed or timed out.");
    }
  }

  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };
  }

  if (method === "prompts/get") {
    const built = promptMessages(params?.name, params?.arguments);
    if (!built) return rpcError(id, -32602, `Unknown prompt: ${params?.name}`);
    return { jsonrpc: "2.0", id, result: built };
  }

  if (method === "resources/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          {
            uri: "jev://status",
            name: "Jev connection status",
            mimeType: "application/json",
          },
        ],
      },
    };
  }

  if (method === "resources/read") {
    const uri = params?.uri;
    if (uri !== "jev://status") return rpcError(id, -32602, `Unknown resource: ${uri}`);
    const key = await resolveKey(options);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ connected: Boolean(key), console: CONSOLE_URL }, null, 2),
          },
        ],
      },
    };
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function encodeMessage(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export function createFramer(onMessage) {
  let buffer = Buffer.alloc(0);
  return function push(chunk) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      let sep = "\r\n\r\n";
      let headerEnd = buffer.indexOf(sep);
      if (headerEnd === -1) {
        sep = "\n\n";
        headerEnd = buffer.indexOf(sep);
      }
      if (headerEnd !== -1) {
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + sep.length);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + sep.length;
        if (buffer.length < start + length) return;
        const body = buffer.subarray(start, start + length).toString("utf8");
        buffer = buffer.subarray(start + length);
        try {
          onMessage(JSON.parse(body));
        } catch {
          /* ignore malformed frames */
        }
        continue;
      }

      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* wait for a complete Content-Length frame */
      }
    }
  };
}

export function createSession({ send, home } = {}) {
  let nextId = 1;
  const pending = new Map();
  return {
    home,
    env: process.env,
    clientCapabilities: {},
    pending,
    elicit(params) {
      if (!send) return Promise.resolve({ action: "cancel" });
      const id = `jev-elicit-${nextId++}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve({ action: "cancel" });
        }, 120000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        send({ jsonrpc: "2.0", id, method: "elicitation/create", params });
      });
    },
  };
}

export async function runMcp(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (typeof stdout._handle?.setBlocking === "function") {
    stdout._handle.setBlocking(true);
  }
  if (typeof stdin.resume === "function") stdin.resume();
  const send = (msg) => {
    if (msg) stdout.write(encodeMessage(msg));
  };
  const session = options.session ?? createSession({ send, home: options.home });
  let queue = Promise.resolve();

  const push = createFramer((message) => {
    queue = queue
      .then(async () => {
        if (message && Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
          const waiter = session.pending?.get(message.id);
          if (waiter) {
            session.pending.delete(message.id);
            waiter(message.result ?? { action: "cancel" });
            return;
          }
        }
        const response = await handleRpc(message, { ...options, session });
        send(response);
      })
      .catch(() => {});
  });

  stdin.on("data", push);
  await new Promise((resolve) => stdin.on("end", resolve));
  await queue;
}

export { PROMPTS };
