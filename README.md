# conductor-cli

An unofficial command-line client for the [Conductor](https://conductor.build) beta API, built for coding agents: every endpoint as a command, plus composites for driving sibling agent sessions, with token-efficient [TOON](https://github.com/toon-format/toon) output by default.

## Disclaimer

This is a personal tool, not affiliated with or endorsed by Conductor. It is built against Conductor's beta OpenAPI document (`Roundhouse public API`, document version `0.0.1`, fetched from `https://api.conductor.build/v0/openapi.json` on 2026-07-31). The API is in beta: endpoints, fields, and the agent/model/effort vocabularies can change or disappear without notice, and this CLI will lag behind when they do. The `api` escape-hatch command exists precisely so new endpoints stay reachable before the CLI catches up.

Conductor's macOS app bundles its own official `conductor` CLI (on PATH inside local workspaces). This tool intentionally uses the binary name `conductor-cli` so it never shadows that. Installing also adds `duct` (con-**duct**-or) as a short alias for the same binary — documentation sticks to the full name. Reach for this one where the app is not installed: CI, Linux hosts, cloud sandboxes, or servers orchestrating Conductor over the API.

## Install

```bash
npm install -g github:Laurens-Nys/conductor-cli
```

Or run without installing:

```bash
npx --yes github:Laurens-Nys/conductor-cli --help
```

Requires Node 22 or newer (or Bun) at runtime.

## Authentication

| Variable | Purpose |
|---|---|
| `CONDUCTOR_API_KEY` | Required. Inside a Conductor workspace it is already injected; elsewhere create an API key in Conductor settings. |
| `CONDUCTOR_API_URL` | Optional base URL override (default `https://api.conductor.build`). |
| `CONDUCTOR_SESSION_ID` | Optional. Sent as the `x-conductor-session-id` header when present; Conductor injects it inside workspaces. |

Note the API addresses Cloud workspaces and API-created sessions. A local Mac workspace's own session is not visible through it (`Session not found` is expected there).

## Quickstart

```bash
conductor-cli me
conductor-cli projects list
conductor-cli workspaces list <projectId>

# Create a workspace with a first session and send it work
conductor-cli workspaces create --project <projectId> --name fix-parser --agent claude --model fable-5
conductor-cli messages send <sessionId> "Fix the parser bug in src/parse.mjs" --id <myMessageId>
conductor-cli sessions wait <sessionId> --for-message <myMessageId> --timeout 3600
conductor-cli sessions transcript <sessionId>
```

## Commands

| Command | Purpose |
|---|---|
| `me` | Show the authenticated identity |
| `projects list` / `projects get <id>` | Inspect projects |
| `workspaces list <projectId>` | List a project's workspaces |
| `workspaces create --project <id>\|--repo <url> [--branch] [--name] [--session-name] [--agent] [--model] [--effort] [--env K=V]...` | Create a workspace and its first session |
| `workspaces get\|rename\|archive\|status <id>` | Inspect and manage one workspace |
| `sessions list <workspaceId>` | List a workspace's sessions |
| `sessions create --workspace <id> --agent <agent> [--name] [--model] [--effort] [--fast] [--session-id <id>]` | Start a new session |
| `sessions get\|rename\|archive\|status\|cancel <id>` | Inspect and manage one session |
| `sessions wait <id> [--timeout <s>] [--interval <s>] [--for-message <messageId>]` | Poll until the session leaves `working`; `--for-message` also requires agent activity after that message (defaults 480s / 10s — sized to fit agent-harness command timeouts; rerun to keep waiting) |
| `sessions transcript <id>` | Print the session's concise transcript as markdown |
| `messages list <sessionId> [--limit] [--offset] [--after] [--all]` | List messages as digest rows; `--json` for full content |
| `messages send <sessionId> [text] [--file <path>] [--id <messageId>]` | Queue a user message (stdin when text and `--file` are absent) |
| `messages get <messageId>` | Show one message with full content |
| `sql <query>` | Read-only SQL over `session_transcripts_view` |
| `api <METHOD> <path> [--body <json>]` | Raw request against any endpoint, e.g. `api GET /v0/projects` |

Agent values as of the pinned API document: `claude`, `codex`, `cursor`, `acp`. Effort: `none`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Models are a moving list (`fable-5`, `opus`, `sonnet`, `gpt-5.6-sol`, `grok-4.5`, ...) — trust the API's validation error over any list written down here.

Workspace and session create, get, rename, and list commands also accept `--channel <name>`: the desktop-app channel that `deepLink` fields in responses should open (defaults to the deployment's primary channel).

## Output

Human- and agent-readable TOON by default. TOON renders uniform arrays as one header plus one row per item, which keeps list output small in an LLM context window:

```
data[2]{id,name,gitRemote}:
  5c5f75d4-...,website,"https://github.com/acme/website"
  f592b310-...,platform,"https://github.com/acme/platform"
offset: 0
hasMore: false
```

`--json` prints the raw API payload instead. `sessions transcript` always prints plain markdown.

`messages list` is deliberately lossy by default: each message becomes one digest row (`id`, `index`, `type`, `receivedAt`, and a 160-character `preview` extracted from user text, assistant text, and tool-call names). Use `--json` when you need full message content.

## Driving a sibling agent session

The pattern this CLI is built around: an orchestrating agent creates or reuses a session, queues a brief, blocks until the worker goes idle, then reads the transcript instead of raw events.

```bash
SESSION=$(conductor-cli sessions create --workspace "$WORKSPACE" --agent cursor --model grok-4.5 --json | jq -r .id)
MESSAGE=$(conductor-cli messages send "$SESSION" --file brief.md --json | jq -r .messageId)
until conductor-cli sessions wait "$SESSION" --for-message "$MESSAGE"; do :; done
conductor-cli sessions transcript "$SESSION" > worker-transcript.md
```

`messages send` queues; the returned `state` is `queued` or `sent`. A plain `wait` issued immediately after a send can observe `idle` before the worker ever starts — `--for-message` closes that race by also requiring an agent event tagged with your message id. (The returned `messageId` identifies the turn, not the transcript row it lands in, so it is not a valid `--after` anchor for `messages list`; agent events echo it back as `content.userMessageId`/`content.turnId`.) `sessions wait` exits non-zero on timeout, and prints the final status (`idle` or `error`) on success.

## The transcript view

`sql` queries one read-only view, `session_transcripts_view`, with these columns (observed live, same caveat as everything else here): `session_id`, `workspace_id`, `transcript`, `session_title`, `agent_type`, `model`, `workspace_name`, `workspace_state`, `repo_url`, `session_created_at`, `transcript_updated_at`, `workspace_created_at`, `workspace_creator_id`.

```bash
conductor-cli sql "SELECT session_id, session_title, workspace_state FROM session_transcripts_view ORDER BY transcript_updated_at DESC LIMIT 10"
```

## Agent setup

`skills/conductor-cli/SKILL.md` is an [agent skill](https://agentskills.io) teaching coding agents the commands and the sibling-session pattern. Vendor it with any SKILL.md-aware installer, for example:

```bash
npx --yes skills add https://github.com/Laurens-Nys/conductor-cli --skill conductor-cli
```

## Development

TypeScript source (`src/cli.ts`), built with [Bun](https://bun.sh) into a committed `dist/` bundle that runs on stock Node — `npx`/`npm` consumers never need Bun.

```bash
bun install
bun run test        # rebuilds dist/, then runs the suite (includes a dist-under-node smoke test)
bun run typecheck   # tsc --noEmit
```

After changing `src/`, rerun `bun run test` and commit the regenerated `dist/cli.js`. One runtime dependency (`@toon-format/toon`).

## License

MIT
