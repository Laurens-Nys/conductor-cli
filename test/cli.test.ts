import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { test } from "bun:test"

import packageJson from "../package.json" with { type: "json" }
import { run, type RunOverrides } from "../src/cli.ts"

const ENV = { CONDUCTOR_API_KEY: "test-key" }

interface FakeResponse {
  status?: number
  payload?: unknown
  raw?: string
  throws?: Error
}

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
}

function createFetch(...responses: FakeResponse[]) {
  const calls: RecordedCall[] = []
  const queue = [...responses]
  const fetchImpl = async (url: string, options: { method: string; headers: Record<string, string>; body?: string }) => {
    const next = queue.shift() ?? { payload: {} }
    if (next.throws) throw next.throws
    calls.push({
      url,
      method: options.method || "GET",
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    })
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      text: async () => (next.raw !== undefined ? next.raw : JSON.stringify(next.payload)),
    }
  }
  return { fetchImpl, calls }
}

function createIo() {
  let out = ""
  let err = ""
  return {
    stdout: { write: (text: string) => { out += text } },
    stderr: { write: (text: string) => { err += text } },
    out: () => out,
    err: () => err,
  }
}

interface RunCliOptions {
  responses?: FakeResponse[]
  env?: Record<string, string | undefined>
  readStdin?: RunOverrides["readStdin"]
  sleep?: RunOverrides["sleep"]
}

async function runCli(argv: string[], { responses = [{ payload: {} }], env = ENV, readStdin, sleep }: RunCliOptions = {}) {
  const { fetchImpl, calls } = createFetch(...responses)
  const io = createIo()
  const code = await run(argv, {
    env,
    fetchImpl,
    stdout: io.stdout,
    stderr: io.stderr,
    readStdin: readStdin ?? (async () => ""),
    sleep: sleep ?? (async () => {}),
  })
  return { code, calls, out: io.out(), err: io.err() }
}

test("projects list renders TOON tabular rows", async () => {
  const { code, calls, out } = await runCli(["projects", "list"], {
    responses: [{
      payload: {
        data: [
          { id: "p1", name: "sigma-labs", gitRemote: "https://github.com/GTM-SIGMA/sigma-labs" },
          { id: "p2", name: "conductor-cli", gitRemote: "https://github.com/Laurens-Nys/conductor-cli" },
        ],
        offset: 0,
        hasMore: false,
      },
    }],
  })
  assert.equal(code, 0)
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/projects")
  assert.equal(calls[0]!.headers.authorization, "Bearer test-key")
  assert.match(out, /data\[2\]\{id,name,gitRemote\}/)
  assert.match(out, /hasMore: false/)
})

test("--json prints the raw payload", async () => {
  const { code, out } = await runCli(["me", "--json"], {
    responses: [{ payload: { userId: "u1", authMethod: "api-key" } }],
  })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out), { userId: "u1", authMethod: "api-key" })
})

test("list pagination flags become query parameters", async () => {
  const { calls } = await runCli(["workspaces", "list", "p1", "--limit", "5", "--offset", "10"])
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/projects/p1/workspaces?limit=5&offset=10")
})

test("workspaces create maps flags to the request body", async () => {
  const { code, calls } = await runCli([
    "workspaces", "create",
    "--repo", "https://github.com/Laurens-Nys/conductor-cli",
    "--branch", "main",
    "--name", "smoke",
    "--session-name", "first",
    "--agent", "claude",
    "--model", "fable-5",
    "--effort", "high",
    "--env", "FOO=bar",
    "--env", "BAZ=qux=1",
  ])
  assert.equal(code, 0)
  assert.equal(calls[0]!.method, "POST")
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/workspaces")
  assert.deepEqual(calls[0]!.body, {
    repositoryUrl: "https://github.com/Laurens-Nys/conductor-cli",
    branch: "main",
    name: "smoke",
    sessionName: "first",
    agent: "claude",
    model: "fable-5",
    effort: "high",
    env: { FOO: "bar", BAZ: "qux=1" },
  })
})

test("workspaces create rejects both or neither of --project and --repo", async () => {
  for (const argv of [
    ["workspaces", "create"],
    ["workspaces", "create", "--project", "p1", "--repo", "https://example.com/r.git"],
  ]) {
    const { code, err } = await runCli(argv)
    assert.equal(code, 1)
    assert.match(err, /exactly one of --project or --repo/)
  }
})

test("sessions create requires --workspace and --agent, maps --fast", async () => {
  const missing = await runCli(["sessions", "create", "--agent", "claude"])
  assert.equal(missing.code, 1)
  assert.match(missing.err, /--workspace and --agent/)

  const { calls } = await runCli([
    "sessions", "create", "--workspace", "w1", "--agent", "codex", "--model", "gpt-5.6-sol", "--fast",
  ])
  assert.deepEqual(calls[0]!.body, {
    workspaceId: "w1",
    agent: "codex",
    model: "gpt-5.6-sol",
    fastMode: true,
  })
})

test("messages send posts inline text and optional message id", async () => {
  const { calls } = await runCli(["messages", "send", "s1", "do", "the", "thing", "--id", "m-42"], {
    responses: [{ status: 201, payload: { messageId: "m-42", state: "queued" } }],
  })
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/sessions/s1/messages")
  assert.deepEqual(calls[0]!.body, { message: "do the thing", messageId: "m-42" })
})

test("messages send reads --file and stdin fallbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conductor-cli-"))
  const briefPath = join(directory, "brief.md")
  await writeFile(briefPath, "# Brief\nwork\n")
  const fromFile = await runCli(["messages", "send", "s1", "--file", briefPath])
  assert.deepEqual(fromFile.calls[0]!.body, { message: "# Brief\nwork\n" })

  const fromStdin = await runCli(["messages", "send", "s1"], { readStdin: async () => "piped brief" })
  assert.deepEqual(fromStdin.calls[0]!.body, { message: "piped brief" })

  const empty = await runCli(["messages", "send", "s1"])
  assert.equal(empty.code, 1)
  assert.match(empty.err, /non-empty message/)
})

test("messages list digests live content shapes and paginates with --all", async () => {
  const userMessage = {
    id: "m1",
    sessionId: "s1",
    sessionIndex: 0,
    type: "userMessage",
    receivedAt: "2026-07-31T10:00:00Z",
    content: { type: "userMessage", message: "Please fix the bug\nin the parser" },
  }
  const assistantEvent = {
    id: "m2",
    sessionId: "s1",
    sessionIndex: 1,
    type: "agentEvent",
    receivedAt: "2026-07-31T10:01:00Z",
    content: {
      type: "agentEvent",
      rawPayload: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking at the parser now." },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
    },
  }
  const codexAgentMessage = {
    id: "m3",
    sessionId: "s1",
    sessionIndex: 2,
    type: "agent",
    receivedAt: "2026-07-31T10:02:00Z",
    content: {
      type: "agent",
      rawPayload: {
        event: {
          type: "item.completed",
          item: { type: "agentMessage", id: "msg_1", text: "Parser fixed; tests green." },
        },
      },
    },
  }
  const codexCommand = {
    id: "m4",
    sessionId: "s1",
    sessionIndex: 3,
    type: "agent",
    receivedAt: "2026-07-31T10:03:00Z",
    content: {
      type: "agent",
      rawPayload: {
        event: {
          type: "item.completed",
          item: { type: "commandExecution", id: "exec-1", command: "npm test" },
        },
      },
    },
  }
  const codexLifecycle = {
    id: "m5",
    sessionId: "s1",
    sessionIndex: 4,
    type: "agent",
    receivedAt: "2026-07-31T10:04:00Z",
    content: {
      type: "agent",
      rawPayload: { event: { type: "thread.started", thread_id: "t1" } },
    },
  }
  const claudeLifecycle = {
    id: "m6",
    sessionId: "s1",
    sessionIndex: 5,
    type: "agent",
    receivedAt: "2026-07-31T10:05:00Z",
    content: {
      type: "agent",
      rawPayload: { type: "system", subtype: "session_state_changed", state: "running" },
    },
  }
  const { code, calls, out } = await runCli(["messages", "list", "s1", "--all"], {
    responses: [
      { payload: { data: [userMessage], offset: 0, hasMore: true } },
      { payload: { data: [assistantEvent, codexAgentMessage, codexCommand, codexLifecycle, claudeLifecycle], offset: 1, hasMore: false } },
    ],
  })
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.url, "https://api.conductor.build/v0/sessions/s1/messages?limit=100&after=m1")
  assert.match(out, /Please fix the bug in the parser/)
  assert.match(out, /Looking at the parser now\. \[Bash\]/)
  assert.match(out, /Parser fixed; tests green\./)
  assert.match(out, /\[npm test\]/)
  assert.match(out, /thread\.started/)
  assert.match(out, /system:session_state_changed/)
  assert.match(out, /hasMore: false/)
})

test("messages list --all --after keeps paging by cursor, never offsets", async () => {
  const row = (id: string, index: number) => ({
    id,
    sessionId: "s1",
    sessionIndex: index,
    type: "agent",
    receivedAt: "t",
    content: { type: "agent", message: `event ${index}` },
  })
  const { code, calls, out } = await runCli(["messages", "list", "s1", "--all", "--after", "m0", "--json"], {
    responses: [
      { payload: { data: [row("a", 2), row("b", 3)], offset: 0, hasMore: true } },
      { payload: { data: [row("c", 4)], offset: 0, hasMore: false } },
    ],
  })
  assert.equal(code, 0)
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/sessions/s1/messages?after=m0")
  assert.equal(calls[1]!.url, "https://api.conductor.build/v0/sessions/s1/messages?limit=100&after=b")
  assert.deepEqual(JSON.parse(out).data.map((m: { sessionIndex: number }) => m.sessionIndex), [2, 3, 4])
})

test("messages list --all stops on an empty page instead of looping", async () => {
  const message = {
    id: "m1",
    sessionId: "s1",
    sessionIndex: 0,
    type: "userMessage",
    receivedAt: "t",
    content: { type: "userMessage", message: "hi" },
  }
  const { code, calls } = await runCli(["messages", "list", "s1", "--all"], {
    responses: [
      { payload: { data: [message], offset: 0, hasMore: true } },
      { payload: { data: [], offset: 0, hasMore: true } },
    ],
  })
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
})

test("sessions wait polls until the session leaves working", async () => {
  const working = { payload: { sessionId: "s1", status: "working", updatedAt: "t" } }
  const idle = { payload: { sessionId: "s1", status: "idle", updatedAt: "t" } }
  const { code, calls, out, err } = await runCli(["sessions", "wait", "s1"], {
    responses: [working, working, idle],
  })
  assert.equal(code, 0)
  assert.equal(calls.length, 3)
  assert.match(out, /status: idle/)
  assert.match(err, /session is working/)
  assert.match(err, /session is idle/)
})

test("sessions wait times out with an error", async () => {
  const working = { payload: { sessionId: "s1", status: "working", updatedAt: "t" } }
  const { code, err } = await runCli(["sessions", "wait", "s1", "--timeout", "0.001"], {
    responses: [working, working],
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 5))),
  })
  assert.equal(code, 1)
  assert.match(err, /Timed out/)
})

test("sessions wait caps the sleep to the remaining timeout", async () => {
  const working = { payload: { sessionId: "s1", status: "working", updatedAt: "t" } }
  const idle = { payload: { sessionId: "s1", status: "idle", updatedAt: "t" } }
  const sleeps: number[] = []
  const { code } = await runCli(["sessions", "wait", "s1", "--timeout", "5", "--interval", "10"], {
    responses: [working, idle],
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(code, 0)
  assert.equal(sleeps.length, 1)
  assert.ok(sleeps[0]! <= 5000, `sleep should be capped to the 5s deadline, got ${sleeps[0]}ms`)
})

test("sessions wait --for-message requires agent activity after the message", async () => {
  const idle = { payload: { sessionId: "s1", status: "idle", updatedAt: "t" } }
  const anchorMissing = { status: 404, payload: { userMessage: "Cursor message not found in this session" } }
  const noActivity = { payload: { data: [], offset: 0, hasMore: false } }
  const activity = {
    payload: {
      data: [{ id: "m9", sessionId: "s1", sessionIndex: 9, type: "agent", receivedAt: "t", content: {} }],
      offset: 0,
      hasMore: true,
    },
  }
  const { code, calls, out, err } = await runCli(["sessions", "wait", "s1", "--for-message", "brief-1"], {
    responses: [idle, anchorMissing, idle, noActivity, idle, activity],
  })
  assert.equal(code, 0)
  assert.equal(calls.length, 6)
  assert.equal(calls[1]!.url, "https://api.conductor.build/v0/sessions/s1/messages?after=brief-1&limit=1")
  assert.match(err, /idle \(no agent activity after the message yet\)/)
  assert.match(out, /status: idle/)
})

test("network failures surface as clean CLI errors", async () => {
  const { code, err } = await runCli(["me"], {
    responses: [{ throws: new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:9") }) }],
  })
  assert.equal(code, 1)
  assert.match(err, /conductor-cli: GET https:\/\/api\.conductor\.build\/me failed: connect ECONNREFUSED/)
})

test("sessions create forwards --session-id and --channel", async () => {
  const { calls } = await runCli([
    "sessions", "create", "--workspace", "w1", "--agent", "claude", "--session-id", "sess-42", "--channel", "beta",
  ])
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/sessions?channel=beta")
  assert.deepEqual(calls[0]!.body, { workspaceId: "w1", agent: "claude", sessionId: "sess-42" })
})

test("--channel becomes a query parameter on lists and gets", async () => {
  const list = await runCli(["workspaces", "list", "p1", "--channel", "beta"])
  assert.equal(list.calls[0]!.url, "https://api.conductor.build/v0/projects/p1/workspaces?channel=beta")

  const get = await runCli(["sessions", "get", "s1", "--channel", "beta"])
  assert.equal(get.calls[0]!.url, "https://api.conductor.build/v0/sessions/s1?channel=beta")
})

test("sessions transcript prints raw markdown from the sql endpoint", async () => {
  const { code, calls, out } = await runCli(["sessions", "transcript", "it's-a-session"], {
    responses: [{ payload: { rows: [{ transcript: "# Transcript\n\nhello" }], rowCount: 1, truncated: false } }],
  })
  assert.equal(code, 0)
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/sql")
  assert.match(calls[0]!.body.query, /WHERE session_id = 'it''s-a-session'/)
  assert.equal(out, "# Transcript\n\nhello\n")
})

test("api escape hatch sends a parsed body and rejects invalid JSON", async () => {
  const { calls } = await runCli(["api", "post", "/v0/sql", "--body", '{"query":"SELECT 1"}'])
  assert.equal(calls[0]!.method, "POST")
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/sql")
  assert.deepEqual(calls[0]!.body, { query: "SELECT 1" })

  const invalid = await runCli(["api", "GET", "/v0/projects", "--body", "not json"])
  assert.equal(invalid.code, 1)
  assert.match(invalid.err, /--body must be valid JSON/)
})

test("identifiers are URL-encoded in paths", async () => {
  const { calls } = await runCli(["sessions", "status", "a/b c"])
  assert.equal(calls[0]!.url, "https://api.conductor.build/v0/sessions/a%2Fb%20c/status")
})

test("missing CONDUCTOR_API_KEY fails with guidance", async () => {
  const { code, err, calls } = await runCli(["projects", "list"], { env: {} })
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  assert.match(err, /CONDUCTOR_API_KEY is not set/)
})

test("API errors surface userMessage and exit 1", async () => {
  const { code, err } = await runCli(["sessions", "status", "s1"], {
    responses: [{ status: 404, payload: { userMessage: "Session not found", code: "NOT_FOUND" } }],
  })
  assert.equal(code, 1)
  assert.match(err, /Session not found/)
})

test("CONDUCTOR_SESSION_ID is forwarded as a header when present", async () => {
  const { calls } = await runCli(["me"], {
    env: { ...ENV, CONDUCTOR_SESSION_ID: "sess-1" },
  })
  assert.equal(calls[0]!.headers["x-conductor-session-id"], "sess-1")
})

test("CONDUCTOR_API_URL and --api-url override the base", async () => {
  const fromEnv = await runCli(["me"], { env: { ...ENV, CONDUCTOR_API_URL: "https://example.test/" } })
  assert.equal(fromEnv.calls[0]!.url, "https://example.test/me")

  const fromFlag = await runCli(["me", "--api-url", "http://localhost:3000"])
  assert.equal(fromFlag.calls[0]!.url, "http://localhost:3000/me")
})

test("unknown commands and bare invocation fail with usage guidance", async () => {
  const unknown = await runCli(["frobnicate"])
  assert.equal(unknown.code, 1)
  assert.match(unknown.err, /Unknown command: frobnicate/)

  const bare = await runCli([])
  assert.equal(bare.code, 1)
  assert.match(bare.out, /Usage: conductor-cli/)

  const help = await runCli(["--help"])
  assert.equal(help.code, 0)
  assert.match(help.out, /sessions wait/)
})

// The published artifact must run on stock Node (npx consumers never have
// Bun); this exercises bin -> dist end to end and catches a stale dist version.
test("built dist runs under plain node", () => {
  const result = spawnSync("node", ["bin/conductor-cli.mjs", "--version"], { encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), packageJson.version)
})
