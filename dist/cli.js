// src/cli.ts
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { encode } from "@toon-format/toon";
// package.json
var package_default = {
  name: "conductor-cli",
  version: "0.2.0",
  description: "Unofficial command-line client for the Conductor beta API, with TOON output for coding agents",
  type: "module",
  license: "MIT",
  repository: "github:Laurens-Nys/conductor-cli",
  bin: {
    "conductor-cli": "bin/conductor-cli.mjs"
  },
  files: [
    "bin",
    "dist",
    "skills"
  ],
  engines: {
    node: ">=22"
  },
  scripts: {
    build: "bun build src/cli.ts --outfile dist/cli.js --target node --format esm --external @toon-format/toon",
    test: "bun run build && bun test",
    typecheck: "tsc --noEmit"
  },
  dependencies: {
    "@toon-format/toon": "^4.1.0"
  },
  devDependencies: {
    "@types/bun": "^1.3.4",
    typescript: "^5.9.3"
  }
};

// src/cli.ts
var DEFAULT_API_URL = "https://api.conductor.build";
var PREVIEW_LENGTH = 160;
var USAGE = `conductor-cli ${package_default.version} — unofficial CLI for the Conductor beta API

Usage: conductor-cli <command> [arguments] [flags]

Commands
  me                                       Show the authenticated identity
  projects list                            List projects
  projects get <projectId>                 Show one project
  workspaces list <projectId>              List a project's workspaces
  workspaces create                        Create a workspace (and its first session)
    --project <id> | --repo <url>          exactly one of the two
    [--branch <name>] [--name <name>] [--session-name <name>]
    [--agent <agent>] [--model <model>] [--effort <effort>] [--env KEY=VALUE]...
  workspaces get <workspaceId>             Show one workspace
  workspaces rename <workspaceId> <name>   Rename a workspace
  workspaces archive <workspaceId>         Archive a workspace
  workspaces status <workspaceId>          Workspace lifecycle status
  sessions list <workspaceId>              List a workspace's sessions
  sessions create --workspace <id> --agent <agent>
    [--name <name>] [--model <model>] [--effort <effort>] [--fast] [--session-id <id>]
  sessions get <sessionId>                 Show one session
  sessions rename <sessionId> <name>       Rename a session
  sessions archive <sessionId>             Archive a session
  sessions status <sessionId>              Session status (idle | working | error)
  sessions cancel <sessionId>              Cancel a running session
  sessions wait <sessionId>                Poll until the session leaves "working"
    [--timeout <seconds>] [--interval <seconds>]   defaults: 480, 10
    [--for-message <id>]                   also require agent activity after that message
  sessions transcript <sessionId>          Print the session transcript (markdown)
  messages list <sessionId>                List session messages as digest rows
    [--limit <n>] [--offset <n>] [--after <messageId>] [--all]
  messages send <sessionId> [text]         Queue a user message
    [--file <path>] [--id <messageId>]     reads stdin when text and --file are absent
  messages get <messageId>                 Show one message with full content
  sql <query>                              Read-only SQL over session transcripts
  api <METHOD> <path> [--body <json>]      Raw request, e.g. api GET /v0/projects

Flags
  --json           Print raw API JSON instead of TOON
  --api-url <url>  Override the API base URL (default ${DEFAULT_API_URL})
  --channel <name> Desktop-app channel that deepLinks in responses should open
                   (forwarded to workspace/session create, get, rename, list)
  --version        Print the CLI version
  --help           Show this help

Environment
  CONDUCTOR_API_KEY      Required. Conductor injects it inside workspaces.
  CONDUCTOR_API_URL      Optional base URL override.
  CONDUCTOR_SESSION_ID   Optional; sent as x-conductor-session-id when present.
`;
var OPTIONS = {
  json: { type: "boolean" },
  "api-url": { type: "string" },
  project: { type: "string" },
  repo: { type: "string" },
  branch: { type: "string" },
  name: { type: "string" },
  "session-name": { type: "string" },
  agent: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  env: { type: "string", multiple: true },
  workspace: { type: "string" },
  fast: { type: "boolean" },
  "session-id": { type: "string" },
  channel: { type: "string" },
  "for-message": { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  after: { type: "string" },
  all: { type: "boolean" },
  file: { type: "string" },
  id: { type: "string" },
  timeout: { type: "string" },
  interval: { type: "string" },
  body: { type: "string" },
  help: { type: "boolean" },
  version: { type: "boolean" }
};

class CliError extends Error {
}
async function run(argv, {
  env = process.env,
  fetchImpl = fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  readStdin = defaultReadStdin,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    stderr.write(`conductor-cli: ${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
  const values = parsed.values;
  const positionals = parsed.positionals;
  if (values.version) {
    stdout.write(`${package_default.version}
`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  try {
    const output = await dispatch(positionals, values, { env, fetchImpl, readStdin, sleep, stderr });
    stdout.write(output.endsWith(`
`) ? output : `${output}
`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      stderr.write(`conductor-cli: ${error.message}
`);
      return 1;
    }
    throw error;
  }
}
async function dispatch(positionals, values, context) {
  const request = createClient(values, context);
  const [noun, verb, ...args] = positionals;
  if (noun === "me" && !verb) {
    return render(await request("GET", "/me"), values);
  }
  if (noun === "sql") {
    return sqlCommand(request, positionals.slice(1), values, context);
  }
  if (noun === "api") {
    return apiCommand(request, positionals.slice(1), values);
  }
  if (noun === "projects") {
    return projectsCommand(request, verb, args, values);
  }
  if (noun === "workspaces") {
    return workspacesCommand(request, verb, args, values);
  }
  if (noun === "sessions") {
    return sessionsCommand(request, verb, args, values, context);
  }
  if (noun === "messages") {
    return messagesCommand(request, verb, args, values, context);
  }
  throw unknownCommand(positionals);
}
function createClient(values, { env, fetchImpl }) {
  const base = (values["api-url"] || env.CONDUCTOR_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const apiKey = env.CONDUCTOR_API_KEY;
  if (!apiKey) {
    throw new CliError("CONDUCTOR_API_KEY is not set. Conductor injects it inside workspaces; elsewhere create an API key in Conductor settings and export it.");
  }
  return async function request(method, path, body) {
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "user-agent": `conductor-cli/${package_default.version}`
    };
    if (env.CONDUCTOR_SESSION_ID) {
      headers["x-conductor-session-id"] = env.CONDUCTOR_SESSION_ID;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    let response;
    let text;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      text = await response.text();
    } catch (error) {
      const cause = error instanceof Error ? error.cause?.message || error.message : String(error);
      throw new CliError(`${method} ${base}${path} failed: ${cause}`);
    }
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      throw new CliError(payload?.userMessage || payload?.message || `Conductor returned HTTP ${response.status}`);
    }
    if (payload === undefined) {
      throw new CliError(`Conductor returned a non-JSON response (HTTP ${response.status})`);
    }
    return payload;
  };
}
async function projectsCommand(request, verb, args, values) {
  if (verb === "list") {
    return render(await request("GET", `/v0/projects${pageQuery(values)}`), values);
  }
  if (verb === "get") {
    return render(await request("GET", `/v0/projects/${requireId(args[0], "projectId")}`), values);
  }
  throw unknownCommand(["projects", verb]);
}
async function workspacesCommand(request, verb, args, values) {
  if (verb === "list") {
    return render(await request("GET", `/v0/projects/${requireId(args[0], "projectId")}/workspaces${pageQuery(values)}`), values);
  }
  if (verb === "create") {
    return render(await request("POST", `/v0/workspaces${channelQuery(values)}`, workspaceCreateBody(values)), values);
  }
  if (verb === "get") {
    return render(await request("GET", `/v0/workspaces/${requireId(args[0], "workspaceId")}${channelQuery(values)}`), values);
  }
  if (verb === "rename") {
    return render(await request("POST", `/v0/workspaces/${requireId(args[0], "workspaceId")}/rename${channelQuery(values)}`, {
      name: requireArg(args[1], "name")
    }), values);
  }
  if (verb === "archive") {
    return render(await request("POST", `/v0/workspaces/${requireId(args[0], "workspaceId")}/archive`), values);
  }
  if (verb === "status") {
    return render(await request("GET", `/v0/workspaces/${requireId(args[0], "workspaceId")}/status`), values);
  }
  throw unknownCommand(["workspaces", verb]);
}
function workspaceCreateBody(values) {
  if (Boolean(values.project) === Boolean(values.repo)) {
    throw new CliError("workspaces create needs exactly one of --project or --repo");
  }
  const body = values.project ? { projectId: values.project } : { repositoryUrl: values.repo };
  if (values.branch)
    body.branch = values.branch;
  if (values.name)
    body.name = values.name;
  if (values["session-name"])
    body.sessionName = values["session-name"];
  if (values.agent)
    body.agent = values.agent;
  if (values.model)
    body.model = values.model;
  if (values.effort)
    body.effort = values.effort;
  let envVars;
  for (const pair of values.env ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 1) {
      throw new CliError(`--env expects KEY=VALUE, got: ${pair}`);
    }
    envVars = envVars ?? {};
    envVars[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  if (envVars)
    body.env = envVars;
  return body;
}
async function sessionsCommand(request, verb, args, values, context) {
  if (verb === "list") {
    return render(await request("GET", `/v0/workspaces/${requireId(args[0], "workspaceId")}/sessions${pageQuery(values)}`), values);
  }
  if (verb === "create") {
    if (!values.workspace || !values.agent) {
      throw new CliError("sessions create requires --workspace and --agent");
    }
    const body = { workspaceId: values.workspace, agent: values.agent };
    if (values["session-id"])
      body.sessionId = values["session-id"];
    if (values.name)
      body.name = values.name;
    if (values.model)
      body.model = values.model;
    if (values.effort)
      body.effort = values.effort;
    if (values.fast)
      body.fastMode = true;
    return render(await request("POST", `/v0/sessions${channelQuery(values)}`, body), values);
  }
  if (verb === "get") {
    return render(await request("GET", `/v0/sessions/${requireId(args[0], "sessionId")}${channelQuery(values)}`), values);
  }
  if (verb === "rename") {
    return render(await request("POST", `/v0/sessions/${requireId(args[0], "sessionId")}/rename${channelQuery(values)}`, {
      name: requireArg(args[1], "name")
    }), values);
  }
  if (verb === "archive") {
    return render(await request("POST", `/v0/sessions/${requireId(args[0], "sessionId")}/archive`), values);
  }
  if (verb === "status") {
    return render(await request("GET", `/v0/sessions/${requireId(args[0], "sessionId")}/status`), values);
  }
  if (verb === "cancel") {
    return render(await request("POST", `/v0/sessions/${requireId(args[0], "sessionId")}/cancel`), values);
  }
  if (verb === "wait") {
    return waitCommand(request, args, values, context);
  }
  if (verb === "transcript") {
    return transcriptCommand(request, args);
  }
  throw unknownCommand(["sessions", verb]);
}
async function waitCommand(request, args, values, { sleep, stderr }) {
  const sessionId = requireId(args[0], "sessionId");
  const timeoutSeconds = numberFlag(values.timeout, 480);
  const intervalSeconds = numberFlag(values.interval, 10);
  const forMessage = values["for-message"];
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastLabel;
  for (;; ) {
    const status = await request("GET", `/v0/sessions/${sessionId}/status`);
    let pending = false;
    if (status.status !== "working" && forMessage !== undefined) {
      pending = !await hasActivityAfter(request, sessionId, forMessage);
    }
    const label = status.status + (pending ? " (no agent activity after the message yet)" : "");
    if (label !== lastLabel) {
      stderr.write(`conductor-cli: session is ${label}
`);
      lastLabel = label;
    }
    if (status.status !== "working" && !pending) {
      return render(status, values);
    }
    if (Date.now() >= deadline) {
      const goal = forMessage === undefined ? 'the session to leave "working"' : `agent activity after message ${forMessage}`;
      throw new CliError(`Timed out after ${timeoutSeconds}s waiting for ${goal}`);
    }
    await sleep(Math.min(intervalSeconds * 1000, deadline - Date.now()));
  }
}
async function hasActivityAfter(request, sessionId, messageId) {
  try {
    const page = await request("GET", `/v0/sessions/${sessionId}/messages?after=${encodeURIComponent(messageId)}&limit=1`);
    return Array.isArray(page.data) && page.data.length > 0;
  } catch (error) {
    if (error instanceof CliError)
      return false;
    throw error;
  }
}
async function transcriptCommand(request, args) {
  const sessionId = requireArg(args[0], "sessionId");
  const escaped = sessionId.replaceAll("'", "''");
  const payload = await request("POST", "/v0/sql", {
    query: `SELECT transcript FROM session_transcripts_view WHERE session_id = '${escaped}' LIMIT 1`
  });
  const transcript = payload?.rows?.[0]?.transcript;
  if (typeof transcript !== "string" || !transcript.trim()) {
    throw new CliError(`No transcript for session ${sessionId}`);
  }
  return transcript;
}
async function messagesCommand(request, verb, args, values, context) {
  if (verb === "list") {
    return messagesListCommand(request, args, values);
  }
  if (verb === "send") {
    return messagesSendCommand(request, args, values, context);
  }
  if (verb === "get") {
    return render(await request("GET", `/v0/messages/${requireId(args[0], "messageId")}`), values);
  }
  throw unknownCommand(["messages", verb]);
}
async function messagesListCommand(request, args, values) {
  const sessionId = requireId(args[0], "sessionId");
  let page = await request("GET", `/v0/sessions/${sessionId}/messages${pageQuery(values)}`);
  if (values.json && !values.all) {
    return JSON.stringify(page, null, 2);
  }
  const messages = Array.isArray(page.data) ? [...page.data] : [];
  if (values.all) {
    while (page.hasMore) {
      const cursor = messages.at(-1)?.id;
      if (cursor === undefined)
        break;
      page = await request("GET", `/v0/sessions/${sessionId}/messages?limit=100&after=${encodeURIComponent(cursor)}`);
      const data = Array.isArray(page.data) ? page.data : [];
      if (!data.length)
        break;
      messages.push(...data);
    }
  }
  if (values.json) {
    return JSON.stringify({ data: messages, hasMore: false }, null, 2);
  }
  return encode({
    messages: messages.map(digestMessage),
    hasMore: values.all ? false : Boolean(page.hasMore)
  });
}
function digestMessage(message) {
  return {
    id: message.id,
    index: message.sessionIndex,
    type: message.type,
    receivedAt: message.receivedAt,
    preview: contentText(message.content).replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH)
  };
}
function contentText(content) {
  if (typeof content === "string")
    return content;
  if (!content || typeof content !== "object")
    return "";
  if (typeof content.message === "string")
    return content.message;
  const parts = [];
  for (const item of content.rawPayload?.message?.content ?? []) {
    if (item.type === "text" && item.text)
      parts.push(item.text);
    if (item.type === "tool_use")
      parts.push(`[${item.name}]`);
  }
  const event = content.rawPayload?.event;
  if (event) {
    const item = event.item ?? {};
    if (typeof item.text === "string" && item.text)
      parts.push(item.text);
    if (typeof item.command === "string" && item.command)
      parts.push(`[${item.command}]`);
    for (const inner of item.content ?? []) {
      if (inner.type === "text" && inner.text)
        parts.push(inner.text);
    }
    if (!parts.length && typeof event.type === "string") {
      parts.push(item.type ? `${event.type}:${item.type}` : event.type);
    }
  }
  const raw = content.rawPayload;
  if (!parts.length && raw && typeof raw.type === "string") {
    parts.push(typeof raw.subtype === "string" ? `${raw.type}:${raw.subtype}` : raw.type);
  }
  return parts.join(" ") || (typeof content.type === "string" ? content.type : "");
}
async function messagesSendCommand(request, args, values, { readStdin }) {
  const sessionId = requireId(args[0], "sessionId");
  let message = args.slice(1).join(" ");
  if (values.file) {
    if (message) {
      throw new CliError("messages send takes inline text or --file, not both");
    }
    message = await readFile(values.file, "utf8");
  }
  if (!message) {
    message = await readStdin();
  }
  if (!message.trim()) {
    throw new CliError("messages send needs a non-empty message (inline text, --file, or stdin)");
  }
  const body = { message };
  if (values.id)
    body.messageId = values.id;
  return render(await request("POST", `/v0/sessions/${sessionId}/messages`, body), values);
}
async function sqlCommand(request, args, values, { readStdin }) {
  const query = args.join(" ") || await readStdin();
  if (!query.trim()) {
    throw new CliError("sql needs a query (inline or stdin)");
  }
  return render(await request("POST", "/v0/sql", { query }), values);
}
async function apiCommand(request, args, values) {
  const [method, path] = args;
  if (!method || !path || !path.startsWith("/")) {
    throw new CliError("Usage: conductor-cli api <METHOD> </path> [--body '<json>']");
  }
  let body;
  if (values.body !== undefined) {
    try {
      body = JSON.parse(values.body);
    } catch {
      throw new CliError("--body must be valid JSON");
    }
  }
  return render(await request(method.toUpperCase(), path, body), values);
}
function render(value, values) {
  return values.json ? JSON.stringify(value, null, 2) : encode(value);
}
function pageQuery(values) {
  const params = new URLSearchParams;
  if (values.limit !== undefined)
    params.set("limit", values.limit);
  if (values.offset !== undefined)
    params.set("offset", values.offset);
  if (values.after !== undefined)
    params.set("after", values.after);
  if (values.channel !== undefined)
    params.set("channel", values.channel);
  const text = params.toString();
  return text ? `?${text}` : "";
}
function channelQuery(values) {
  return values.channel === undefined ? "" : `?channel=${encodeURIComponent(values.channel)}`;
}
function requireArg(value, label) {
  if (!value) {
    throw new CliError(`Missing required argument: ${label}`);
  }
  return value;
}
function requireId(value, label) {
  return encodeURIComponent(requireArg(value, label));
}
function numberFlag(value, fallback) {
  if (value === undefined)
    return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`Expected a positive number of seconds, got: ${value}`);
  }
  return parsed;
}
function unknownCommand(parts) {
  return new CliError(`Unknown command: ${parts.filter(Boolean).join(" ")} — run conductor-cli --help`);
}
async function defaultReadStdin() {
  if (process.stdin.isTTY)
    return "";
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}
export {
  run,
  CliError
};
