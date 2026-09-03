# conductor-cli

An unofficial command-line companion for the [Conductor](https://conductor.build) beta API, built for coding agents: the REST operations as commands, race-safe waiting and transcript composites, a raw API escape hatch, and token-efficient [TOON](https://github.com/toon-format/toon) output by default.

## Disclaimer

This is a personal tool, not affiliated with or endorsed by Conductor. It is built against Conductor's beta OpenAPI document (`Roundhouse public API`, document version `0.0.1`, reviewed at `https://api.conductor.build/v0/openapi.json` on 2026-09-03). The API is in beta: endpoints and fields can change without notice. The `api` escape-hatch command keeps new endpoints reachable before first-class commands catch up, while `models` reads the current model and effort vocabulary from the live document.

Conductor bundles an official `conductor` CLI in its macOS app and cloud workspaces. Prefer it for ordinary management from inside Conductor. This companion intentionally uses the binary name `conductor-cli` so it never shadows the official tool; use it when you need TOON output, `sessions wait`, Markdown transcripts, `--all` pagination, the raw API escape hatch, or installation on CI and external servers. Installing also adds `duct` (con-**duct**-or) as a short alias for the same binary — documentation sticks to the full name.

## Install

```bash
npm install -g https://github.com/Laurens-Nys/conductor-cli/archive/refs/heads/main.tar.gz
```

Install from the branch tarball, not `npm install -g github:Laurens-Nys/conductor-cli`: some npm versions (seen on 10.9.8) resolve the git spec, report `added 2 packages`, and then install an empty package directory with a dangling `conductor-cli` symlink. The tarball URL takes the same code from the same branch and installs it reliably. `npx github:...` is unaffected.

Or run without installing:

```bash
npx --yes github:Laurens-Nys/conductor-cli --help
```

Requires Node 22 or newer (or Bun) at runtime.

## Authentication

| Variable | Purpose |
|---|---|
| `CONDUCTOR_API_KEY` | Personal API key. Takes precedence over a workspace token. |
| `CONDUCTOR_API_TOKEN` | Workspace-scoped token provided to supported cloud workspaces when API access is enabled. |
| `CONDUCTOR_API_URL` | Optional base URL override (default `https://api.conductor.build`). |
| `CONDUCTOR_SESSION_ID` | Optional. Sent as the `x-conductor-session-id` header when present; Conductor injects it inside workspaces. |

Pass `--token <token>` to override both credential variables. Commands other than `models`, `--help`, and `--version` require a token. The API addresses Cloud workspaces and API-created sessions; a local Mac workspace's own session is not visible through it (`Session not found` is expected there).

## Quickstart

```bash
conductor-cli me
conductor-cli models
conductor-cli projects list
conductor-cli workspaces list --mine --since 2026-09-01 --all

# Create a workspace, its first session, and its initial turn atomically
conductor-cli workspaces create --project <projectId> --name fix-parser \
  --agent claude --model fable-5 --message-file brief.md --json

# Wait on the initialMessage.messageId and sessionId returned by --json
conductor-cli sessions wait <sessionId> --for-message <messageId> --timeout 3600
conductor-cli sessions transcript <sessionId>
```

## Commands

| Command | Purpose |
|---|---|
| `me` | Show the authenticated identity |
| `models` | Fetch accepted model, effort, and fast-mode combinations from the live OpenAPI document |
| `projects list [--all]` / `projects get <id>` | Inspect projects |
| `workspaces list [projectId] [--mine] [--creator] [--since] [--state] [--repo] [--name] [--include-archived] [--all]` | List one project's workspaces, or search across the organization when `projectId` is omitted |
| `workspaces create --project <id>\|--repo <url> [--branch] [--name] [--session-name] [--agent] [--model] [--effort] [--fast] [--message\|--message-file] [--env K=V]... [--restricted]` | Create a workspace and its first session; inside Conductor, project defaults from the current workspace |
| `workspaces get\|rename\|archive\|unarchive\|sleep\|status [<id>]` | Inspect and manage one workspace; ID defaults from `CONDUCTOR_WORKSPACE_ID` where unambiguous |
| `sessions list [workspaceId] [--include-archived] [--all]` | List a workspace's sessions |
| `sessions create [--workspace <id>] --agent <agent> [--name] [--model] [--effort] [--fast] [--session-id] [--message-id] [--message\|--message-file]` | Start a session and optionally its first turn; workspace defaults from `CONDUCTOR_WORKSPACE_ID` |
| `sessions get\|rename\|archive\|status\|cancel <id>` | Inspect and manage one session |
| `sessions wait <id> [--timeout <s>] [--interval <s>] [--for-message <messageId>]` | Poll until the session leaves `working`; `--for-message` also requires agent activity after that message (defaults 480s / 10s — sized to fit agent-harness command timeouts; rerun to keep waiting) |
| `sessions transcript <id>` | Print the session's concise transcript as markdown |
| `messages list <sessionId> [--limit] [--offset] [--after] [--all]` | List messages as digest rows; `--json` for full content |
| `messages send <sessionId> [text] [--message\|--message-file] [--message-id]` | Queue a user message; `--file`/`--id` remain aliases and stdin is the fallback |
| `messages get <messageId>` | Show one message with full content |
| `sql <query>` | Read-only SQL over `session_transcripts_view` |
| `api <METHOD> <path> [--body <json>]` | Raw request against any endpoint, e.g. `api GET /v0/projects` |

Agent and model vocabularies move frequently. Run `conductor-cli models` immediately before choosing an agent/model/effort combination; trust an API validation error over cached output.

Workspace/session create, get, rename, and list commands plus `messages send` accept `--channel <name>`: the desktop-app channel that `deepLink` fields in responses should open (defaults to the deployment's primary channel).

## Output

Human- and agent-readable TOON by default. TOON renders uniform arrays as one header plus one row per item, which keeps list output small in an LLM context window:

```
data[2]{id,name,gitRemote}:
  5c5f75d4-...,website,"https://github.com/acme/website"
  f592b310-...,platform,"https://github.com/acme/platform"
offset: 0
hasMore: false
```

`--json` prints the raw API payload instead. `sessions transcript` always prints plain markdown. On offset-paginated project, workspace, and session lists, `--all` follows every page; message lists use cursor pagination instead.

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

`sql` queries one read-only view, `session_transcripts_view`, with these columns (observed live, same caveat as everything else here): `session_id`, `workspace_id`, `transcript`, `session_title`, `agent_type`, `model`, `workspace_name`, `workspace_state`, `repo_url`, `session_created_at`, `transcript_updated_at`, `workspace_created_at`, `workspace_creator_id`, `workspace_creator_name`.

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
