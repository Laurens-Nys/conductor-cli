// src/cli.ts
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { encode } from "@toon-format/toon";
// package.json
var package_default = {
  name: "conductor-cli",
  version: "0.3.0",
  description: "Unofficial Conductor API companion with agent-oriented waiting, transcripts, and TOON output",
  type: "module",
  license: "MIT",
  repository: "github:Laurens-Nys/conductor-cli",
  bin: {
    "conductor-cli": "bin/conductor-cli.mjs",
    duct: "bin/conductor-cli.mjs"
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
  models                                   List accepted models and efforts (live OpenAPI)
  projects list                            List projects
    [--limit <n>] [--offset <n>] [--all]
  projects get <projectId>                 Show one project
  workspaces list [projectId]              List project or organization workspaces
    [--mine] [--creator <id>] [--since <date>] [--state <state>]...
    [--repo <url-or-id>] [--name <substring>] [--include-archived]
    [--limit <n>] [--offset <n>] [--all]
  workspaces create                        Create a workspace (and its first session)
    --project <id> | --repo <url>          required outside a Conductor workspace
    --project-id and --repo-url are aliases
    [--branch <name>] [--name <name>] [--session-name <name>]
    [--agent <agent>] [--model <model>] [--effort <effort>] [--fast]
    [--message <text> | --message-file <path>] [--env KEY=VALUE]... [--restricted]
  workspaces get [workspaceId]             Show one workspace
  workspaces rename [workspaceId] --name <name>  Rename a workspace
    Positional <workspaceId> <name> remains supported
  workspaces archive [workspaceId]         Archive a workspace
  workspaces unarchive [workspaceId]       Restore an archived workspace
  workspaces sleep [workspaceId]           Put a workspace to sleep
  workspaces status [workspaceId]          Workspace lifecycle status
  sessions list [workspaceId]              List a workspace's sessions
    [--include-archived] [--limit <n>] [--offset <n>] [--all]
  sessions create [--workspace <id>] --agent <agent>
    [--name <name>] [--model <model>] [--effort <effort>] [--fast]
    [--session-id <id>] [--message-id <id>]
    [--message <text> | --message-file <path>]
  sessions get <sessionId>                 Show one session
  sessions rename <sessionId> --name <name>  Rename a session
    Positional <sessionId> <name> remains supported
  sessions archive <sessionId>             Archive a session
  sessions status <sessionId>              Session status (idle | working | error)
  sessions cancel <sessionId>              Cancel a running session
  sessions wait <sessionId>                Poll until the session leaves "working"
    [--timeout <seconds>] [--interval <seconds>]   defaults: 480, 10
    [--for-message <id>]                   also require an agent event for that message
  sessions transcript <sessionId>          Print the session transcript (markdown)
  messages list <sessionId>                List session messages as digest rows
    [--limit <n>] [--offset <n>] [--after <messageId>] [--all]
  messages send <sessionId> [text]         Queue a user message
    [--message <text>] [--message-file <path>] [--message-id <id>]
    --file and --id remain as aliases; reads stdin when message input is absent
  messages get <messageId>                 Show one message with full content
  sql <query>                              Read-only SQL over session transcripts
  api <METHOD> <path> [--body <json>]      Raw request, e.g. api GET /v0/projects

Flags
  --json           Print raw API JSON instead of TOON
  --token <token>  API token (overrides environment variables)
  --api-url <url>  Override the API base URL (default ${DEFAULT_API_URL})
  --channel <name> Desktop-app channel that deepLinks in responses should open
                   (forwarded wherever the API supports it)
  --version        Print the CLI version
  --help           Show this help

Environment
  CONDUCTOR_API_KEY      Personal API key; takes precedence over workspace token.
  CONDUCTOR_API_TOKEN    Workspace-scoped token in supported cloud workspaces.
  CONDUCTOR_API_URL      Optional base URL override.
  CONDUCTOR_SESSION_ID   Optional; sent as x-conductor-session-id when present.
`;
var OPTIONS = {
  json: { type: "boolean" },
  token: { type: "string" },
  "api-url": { type: "string" },
  project: { type: "string" },
  "project-id": { type: "string" },
  repo: { type: "string" },
  "repo-url": { type: "string" },
  branch: { type: "string" },
  name: { type: "string" },
  "session-name": { type: "string" },
  agent: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  env: { type: "string", multiple: true },
  workspace: { type: "string" },
  fast: { type: "boolean" },
  "fast-mode": { type: "boolean" },
  "session-id": { type: "string" },
  message: { type: "string" },
  "message-file": { type: "string" },
  "message-id": { type: "string" },
  channel: { type: "string" },
  creator: { type: "string" },
  mine: { type: "boolean" },
  since: { type: "string" },
  state: { type: "string", multiple: true },
  "include-archived": { type: "boolean" },
  restricted: { type: "boolean" },
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
  const [noun, verb, ...args] = positionals;
  if ((noun === "models" || noun === "model") && !verb) {
    return modelsCommand(createClient(values, context, false), values);
  }
  const request = createClient(values, context);
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
    return workspacesCommand(request, verb, args, values, context);
  }
  if (noun === "sessions") {
    return sessionsCommand(request, verb, args, values, context);
  }
  if (noun === "messages") {
    return messagesCommand(request, verb, args, values, context);
  }
  throw unknownCommand(positionals);
}
function createClient(values, { env, fetchImpl }, requireAuthentication = true) {
  const base = (values["api-url"] || env.CONDUCTOR_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const token = values.token || env.CONDUCTOR_API_KEY || env.CONDUCTOR_API_TOKEN;
  if (requireAuthentication && !token) {
    throw new CliError("No API token found. Pass --token, set CONDUCTOR_API_KEY, or use CONDUCTOR_API_TOKEN in an enabled cloud workspace.");
  }
  return async function request(method, path, body) {
    const headers = {
      "user-agent": `conductor-cli/${package_default.version}`
    };
    if (token)
      headers.authorization = `Bearer ${token}`;
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
async function modelsCommand(request, values) {
  const spec = await request("GET", "/v0/openapi.json");
  const description = spec?.paths?.["/v0/workspaces"]?.post?.description;
  if (typeof description !== "string") {
    throw new CliError("The live OpenAPI document does not describe workspace models");
  }
  const models = parseAgentSection(description, "Accepted model ids by agent — ", ". Accepted effort levels by agent");
  const efforts = parseAgentSection(description, "Accepted effort levels by agent — ", "; codex max requires");
  const fastModeModels = parseAgentSection(description, "Models accepting fastMode by agent — ", ". Omit fastMode");
  const agents = ["claude", "codex", "cursor"].map((agent) => ({
    agent,
    models: models[agent] ?? [],
    efforts: efforts[agent] ?? [],
    fastModeModels: fastModeModels[agent] ?? []
  }));
  if (agents.some((agent) => agent.models.length === 0)) {
    throw new CliError("Could not parse the current model catalog from the live OpenAPI document");
  }
  return render({ agents }, values);
}
function parseAgentSection(description, startMarker, endMarker) {
  const start = description.indexOf(startMarker);
  const end = start < 0 ? -1 : description.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0)
    return {};
  const section = description.slice(start + startMarker.length, end);
  const values = {};
  for (const match of section.matchAll(/(?:^|;\s*)(claude|codex|cursor):\s*([^;]+)/g)) {
    values[match[1]] = match[2].split(",").map((value) => value.trim()).filter(Boolean);
  }
  return values;
}
async function projectsCommand(request, verb, args, values) {
  if (verb === "list") {
    return render(await offsetList(request, "/v0/projects", values), values);
  }
  if (verb === "get") {
    return render(await request("GET", `/v0/projects/${requireId(args[0], "projectId")}`), values);
  }
  throw unknownCommand(["projects", verb]);
}
async function workspacesCommand(request, verb, args, values, context) {
  if (verb === "list") {
    const projectId = args[0];
    if (projectId) {
      if (values.mine || values.creator || values.since || values.state || values.repo || values.name || values["include-archived"]) {
        throw new CliError("Workspace filters require an organization-wide list; omit projectId");
      }
      const params2 = new URLSearchParams;
      addChannelParam(params2, values);
      return render(await offsetList(request, `/v0/projects/${requireId(projectId, "projectId")}/workspaces`, values, params2), values);
    }
    if (values.mine && values.creator) {
      throw new CliError("workspaces list takes --mine or --creator, not both");
    }
    const params = new URLSearchParams;
    let creator = values.creator;
    if (values.mine) {
      const identity = await request("GET", "/me");
      if (typeof identity?.userId !== "string" || !identity.userId) {
        throw new CliError("Conductor did not return a user id for --mine");
      }
      creator = identity.userId;
    }
    if (creator)
      params.set("creator", creator);
    if (values.since)
      params.set("since", values.since);
    for (const state of values.state ?? [])
      params.append("state", state);
    if (values.repo)
      params.set("repo", values.repo);
    if (values.name)
      params.set("name", values.name);
    if (values["include-archived"])
      params.set("includeArchived", "true");
    addChannelParam(params, values);
    return render(await offsetList(request, "/v0/workspaces", values, params), values);
  }
  if (verb === "create") {
    const body = await workspaceCreateBody(request, values, context);
    return render(await request("POST", `/v0/workspaces${channelQuery(values)}`, body), values);
  }
  if (verb === "get") {
    return render(await request("GET", `/v0/workspaces/${currentWorkspaceId(args[0], context)}${channelQuery(values)}`), values);
  }
  if (verb === "rename") {
    return render(await request("POST", `/v0/workspaces/${currentWorkspaceId(args[0], context)}/rename${channelQuery(values)}`, {
      name: values.name || requireArg(args[1], "name")
    }), values);
  }
  if (verb === "archive") {
    return render(await request("POST", `/v0/workspaces/${currentWorkspaceId(args[0], context)}/archive`), values);
  }
  if (verb === "unarchive") {
    return render(await request("POST", `/v0/workspaces/${currentWorkspaceId(args[0], context)}/unarchive`), values);
  }
  if (verb === "sleep") {
    return render(await request("POST", `/v0/workspaces/${currentWorkspaceId(args[0], context)}/sleep`), values);
  }
  if (verb === "status") {
    return render(await request("GET", `/v0/workspaces/${currentWorkspaceId(args[0], context)}/status`), values);
  }
  throw unknownCommand(["workspaces", verb]);
}
async function workspaceCreateBody(request, values, context) {
  const project = oneAlias(values.project, values["project-id"], "--project", "--project-id");
  const repo = oneAlias(values.repo, values["repo-url"], "--repo", "--repo-url");
  if (project && repo) {
    throw new CliError("workspaces create takes --project or --repo, not both");
  }
  let resolvedProject = project;
  if (!resolvedProject && !repo) {
    const workspaceId = rawCurrentWorkspaceId(context.env);
    if (!workspaceId) {
      throw new CliError("workspaces create needs --project or --repo outside a Conductor workspace");
    }
    const workspace = await request("GET", `/v0/workspaces/${encodeURIComponent(workspaceId)}`);
    if (typeof workspace?.projectId !== "string" || !workspace.projectId) {
      throw new CliError("The current workspace is not attached to a reusable project; pass --project or --repo");
    }
    resolvedProject = workspace.projectId;
  }
  const body = resolvedProject ? { projectId: resolvedProject } : { repositoryUrl: repo };
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
  if (values.fast || values["fast-mode"])
    body.fastMode = true;
  if (values.restricted)
    body.access = { restricted: true };
  const message = await optionalMessage(values, context);
  if (message !== undefined)
    body.message = message;
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
    const params = new URLSearchParams;
    addChannelParam(params, values);
    if (values["include-archived"])
      params.set("includeArchived", "true");
    return render(await offsetList(request, `/v0/workspaces/${currentWorkspaceId(args[0], context)}/sessions`, values, params), values);
  }
  if (verb === "create") {
    if (!values.agent) {
      throw new CliError("sessions create requires --agent");
    }
    const workspaceId = values.workspace || rawCurrentWorkspaceId(context.env);
    if (!workspaceId) {
      throw new CliError("sessions create requires --workspace outside a Conductor workspace");
    }
    const body = { workspaceId, agent: values.agent };
    if (values["session-id"])
      body.sessionId = values["session-id"];
    if (values.name)
      body.name = values.name;
    if (values.model)
      body.model = values.model;
    if (values.effort)
      body.effort = values.effort;
    if (values.fast || values["fast-mode"])
      body.fastMode = true;
    if (values["message-id"])
      body.messageId = values["message-id"];
    const message = await optionalMessage(values, context);
    if (message !== undefined)
      body.message = message;
    return render(await request("POST", `/v0/sessions${channelQuery(values)}`, body), values);
  }
  if (verb === "get") {
    return render(await request("GET", `/v0/sessions/${requireId(args[0], "sessionId")}${channelQuery(values)}`), values);
  }
  if (verb === "rename") {
    return render(await request("POST", `/v0/sessions/${requireId(args[0], "sessionId")}/rename${channelQuery(values)}`, {
      name: values.name || requireArg(args[1], "name")
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
  const sawAgentActivity = forMessage === undefined ? undefined : createActivityWatcher(request, sessionId, forMessage);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastLabel;
  for (;; ) {
    const status = await request("GET", `/v0/sessions/${sessionId}/status`);
    let pending = false;
    if (status.status !== "working" && sawAgentActivity !== undefined) {
      pending = !await sawAgentActivity();
    }
    const label = status.status + (pending ? " (no agent activity for the message yet)" : "");
    if (label !== lastLabel) {
      stderr.write(`conductor-cli: session is ${label}
`);
      lastLabel = label;
    }
    if (status.status !== "working" && !pending) {
      return render(status, values);
    }
    if (Date.now() >= deadline) {
      const goal = forMessage === undefined ? 'the session to leave "working"' : `agent activity for message ${forMessage}`;
      throw new CliError(`Timed out after ${timeoutSeconds}s waiting for ${goal}`);
    }
    await sleep(Math.min(intervalSeconds * 1000, deadline - Date.now()));
  }
}
function createActivityWatcher(request, sessionId, messageId) {
  let cursor;
  return async function sawAgentActivity() {
    for (;; ) {
      const anchor = cursor === undefined ? "" : `&after=${encodeURIComponent(cursor)}`;
      const page = await request("GET", `/v0/sessions/${sessionId}/messages?limit=100${anchor}`);
      const data = Array.isArray(page.data) ? page.data : [];
      if (!data.length)
        return false;
      cursor = data.at(-1)?.id ?? cursor;
      if (data.some((message) => isAgentActivityFor(message, messageId)))
        return true;
      if (!page.hasMore)
        return false;
    }
  };
}
function isAgentActivityFor(message, messageId) {
  if (message?.type !== "agent")
    return false;
  const content = message.content;
  if (!content || typeof content !== "object")
    return false;
  return content.userMessageId === messageId || content.turnId === messageId;
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
async function messagesSendCommand(request, args, values, context) {
  const sessionId = requireId(args[0], "sessionId");
  let message = await optionalMessage(values, context, args.slice(1).join(" "), true);
  if (message === undefined)
    message = await context.readStdin();
  if (!message.trim()) {
    throw new CliError("messages send needs a non-empty message (inline text, a message flag, or stdin)");
  }
  const body = { message };
  const messageId = oneAlias(values["message-id"], values.id, "--message-id", "--id");
  if (messageId)
    body.messageId = messageId;
  return render(await request("POST", `/v0/sessions/${sessionId}/messages${channelQuery(values)}`, body), values);
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
async function offsetList(request, path, values, baseParams = new URLSearchParams) {
  if (!values.all) {
    const params = new URLSearchParams(baseParams);
    if (values.limit !== undefined)
      params.set("limit", String(integerFlag(values.limit, "limit", 1)));
    if (values.offset !== undefined)
      params.set("offset", String(integerFlag(values.offset, "offset", 0)));
    return request("GET", appendQuery(path, params));
  }
  const limit = values.limit === undefined ? 100 : integerFlag(values.limit, "limit", 1);
  const initialOffset = values.offset === undefined ? 0 : integerFlag(values.offset, "offset", 0);
  let offset = initialOffset;
  const data = [];
  for (;; ) {
    const params = new URLSearchParams(baseParams);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const page = await request("GET", appendQuery(path, params));
    const rows = Array.isArray(page?.data) ? page.data : [];
    data.push(...rows);
    if (!page?.hasMore || rows.length === 0)
      break;
    offset += rows.length;
  }
  return { data, offset: initialOffset, hasMore: false };
}
function pageQuery(values) {
  const params = new URLSearchParams;
  if (values.limit !== undefined)
    params.set("limit", String(integerFlag(values.limit, "limit", 1)));
  if (values.offset !== undefined)
    params.set("offset", String(integerFlag(values.offset, "offset", 0)));
  if (values.after !== undefined)
    params.set("after", values.after);
  return queryString(params);
}
function channelQuery(values) {
  const params = new URLSearchParams;
  addChannelParam(params, values);
  return queryString(params);
}
function addChannelParam(params, values) {
  if (values.channel !== undefined)
    params.set("channel", values.channel);
}
function appendQuery(path, params) {
  return `${path}${queryString(params)}`;
}
function queryString(params) {
  const text = params.toString();
  return text ? `?${text}` : "";
}
function integerFlag(value, label, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CliError(`--${label} expects an integer of at least ${minimum}, got: ${value}`);
  }
  return parsed;
}
function oneAlias(preferred, alias, preferredLabel, aliasLabel) {
  if (preferred !== undefined && alias !== undefined) {
    throw new CliError(`Use ${preferredLabel} or ${aliasLabel}, not both`);
  }
  return preferred ?? alias;
}
async function optionalMessage(values, { readStdin }, positional = "", allowLegacyFile = false) {
  const inline = oneAlias(values.message, positional || undefined, "--message", "positional text");
  const file = oneAlias(values["message-file"], allowLegacyFile ? values.file : undefined, "--message-file", "--file");
  if (inline !== undefined && file !== undefined) {
    throw new CliError("Use inline message text or a message file, not both");
  }
  let message = inline;
  if (file !== undefined) {
    try {
      message = file === "-" ? await readStdin() : await readFile(file, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(`Could not read message file ${file}: ${detail}`);
    }
  }
  if (message !== undefined && !message.trim()) {
    throw new CliError("Message text must not be empty");
  }
  return message;
}
function rawCurrentWorkspaceId(env) {
  return env.CONDUCTOR_WORKSPACE_ID || env.CONDUCTOR_INTERNAL_WORKSPACE_ID;
}
function currentWorkspaceId(value, { env }) {
  const workspaceId = value || rawCurrentWorkspaceId(env);
  if (!workspaceId) {
    throw new CliError("Missing required argument: workspaceId (or set CONDUCTOR_WORKSPACE_ID)");
  }
  return encodeURIComponent(workspaceId);
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
