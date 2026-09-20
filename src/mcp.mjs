import { systemOne } from "./client.mjs";
import { routeTask } from "./router.mjs";
import { MAX_TASK_CHARS } from "./roles.mjs";

const PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "jev_route",
    description:
      "Ask TypeSafe Jev to select a Cursor subagent type for a bounded task. Returns a role, status, and confidence; does not launch agents. Send a concise task summary, never secrets or a full transcript.",
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
    description:
      "Evaluate state with TypeSafe Jev typed questions (choice, score, noul). Returns structured answers your code can branch on. Do not send secrets, API keys, or full transcripts.",
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

async function callTool(name, args, key) {
  if (name === "jev_route") {
    const task = args?.task;
    if (typeof task !== "string") return { error: "task must be a string." };
    const decision = await routeTask(task, key);
    return { text: JSON.stringify(decision) };
  }
  if (name === "jev_ask") {
    const bad = invalidQuestions(args?.questions);
    if (bad) return { error: bad };
    if (args.state == null) return { error: "state is required." };
    if (!key?.trim()) return { error: "Set TYPESAFE_API_KEY in your environment." };
    const result = await systemOne({
      state: args.state,
      questions: args.questions,
      key,
    });
    if (!result.ok) return { error: result.reason };
    return { text: JSON.stringify(result.data) };
  }
  return { error: `Unknown tool: ${name}` };
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
    const version = params?.protocolVersion || PROTOCOL;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "cursor-jev", version: options.version ?? "0.1.0" },
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
    const key = options.key ?? process.env.TYPESAFE_API_KEY;
    try {
      const result = await callTool(name, args, key);
      if (result.error) return errText(id, result.error);
      return okText(id, result.text);
    } catch {
      return errText(id, "TypeSafe request failed or timed out.");
    }
  }

  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }

  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

export function createFramer(onMessage) {
  let buffer = Buffer.alloc(0);
  return function push(chunk) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
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

export async function runMcp(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const send = (msg) => {
    if (msg) stdout.write(encodeMessage(msg));
  };

  const push = createFramer(async (message) => {
    const response = await handleRpc(message, options);
    send(response);
  });

  stdin.on("data", push);
  await new Promise((resolve) => stdin.on("end", resolve));
}

export { TOOLS };
