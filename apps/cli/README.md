# Mesa Code CLI

Terminal CLI and TUI package for Mesa Code, a local-first coding agent forked
from Roo Code.

The CLI is being refactored toward one shared session core used by interactive
TUI, print mode, stdin-stream automation, and file/command-line workflows.
Renderers may differ, but prompt handling, tool approval, cancellation, resume,
runtime invocation, hook enforcement, and task state should not drift across
modes.

The package still uses `@roo-code/cli` and the `roo` binary while the public
rename is staged. The intended public command is `mesa`; `roo` will remain as a
compatibility alias during migration.

## Current Focus

- local/self-hosted endpoint support with explicit model discovery
- shared CLI/TUI session controller and approval contract
- stable text, JSON, and stream-json output contracts
- real cancellation, resume, and same-type approval behavior across modes
- task history, pinning, forking, and recovery as shared session primitives
- hook points for mandatory constraints around tools, shell, edits, and provider
  calls
- native parallel task and sub-agent plumbing without separate behavior paths
- local/private code indexing and search
- explicit tool, skill, and MCP scope control
- PTY smoke tests for terminal flows
- local runtime `doctor`, readiness, and status checks

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @roo-code/cli build
pnpm --filter @roo-code/cli check-types
pnpm --filter @roo-code/cli test
```

## Runtime Profiles

The CLI is designed to work with local and self-hosted inference endpoints.
Runtime support is being built around explicit configuration, doctor output,
and fail-closed behavior for unqualified features.

Examples during the transition:

```bash
mesa use \
  --runtime vllm-mlx \
  --protocol openai \
  --model mlx-community/Qwen3-4B-4bit

mesa doctor \
  --runtime vllm-mlx \
  --protocol openai \
  --base-url http://127.0.0.1:8080/v1
```

Target public command shape:

```bash
mesa use fast-qwen
mesa doctor
mesa status --json
mesa models
mesa run task.md --json
mesa run task.md --output-format stream-json
mesa tui
```

Future operator surfaces such as `serve`, `attach`, logs, stats, hooks,
plugin/skill management, sub-agents, and remote/session relay should build on
the same session/runtime contracts instead of creating a second behavior model.

## NDJSON Stdin Control Protocol

The `--stdin-prompt-stream` mode accepts newline-delimited JSON commands on
stdin and emits NDJSON events on stdout. This is the primary automation
interface for orchestrators, harnesses, and CI systems.

### Input commands

Every command requires `command` (string) and `requestId` (non-empty string).
The `requestId` correlates ack/done/error responses back to your command.

```jsonc
// Start a new task
{"command":"start","requestId":"req-1","prompt":"Fix the login bug"}

// Send a follow-up message to the active task
{"command":"message","requestId":"req-2","prompt":"Also update the tests"}

// Approve a pending tool/command/MCP approval request
{"command":"approve","requestId":"req-3","approvalId":"approval-1"}

// Reject a pending approval request
{"command":"reject","requestId":"req-4","approvalId":"approval-2"}

// Respond with text to a question/followup approval
{"command":"respond","requestId":"req-5","text":"Use the prod database","approvalId":"approval-3"}

// Cancel the active task
{"command":"cancel","requestId":"req-6"}

// Shut down the process
{"command":"shutdown","requestId":"req-7"}
```

### The `approval_request` event

When the agent needs user permission (tool execution, shell command, MCP
server, followup question), the CLI emits:

```json
{
	"type": "control",
	"subtype": "approval_request",
	"approvalId": "approval-1",
	"taskId": "018f7fc8-...",
	"code": "tool",
	"command": "approve",
	"content": "approve tool: read_file",
	"payload": "{\"tool\":\"read_file\",\"path\":\"/src/main.ts\"}"
}
```

- `approvalId` — stable, monotonic ID for this specific approval request.
  Use it in your `approve`, `reject`, or `respond` command to target the
  correct pending request.
- `code` — the ask type (`tool`, `command`, `use_mcp_server`, `followup`,
  `api_req_failed`).
- `command` — the expected response command (`approve` or `respond`).
- `payload` — the raw text from the agent (full tool JSON, command text, or
  question text). Not truncated.
- `content` — a human-readable summary.

### `requestId` vs `approvalId`

These are separate concepts:

- **`requestId`** — your command's correlation ID. Every command you send
  includes one, and the CLI echoes it back in ack/done/error events so you
  can match responses to commands.
- **`approvalId`** — the approval request's identity. Emitted by the CLI in
  `approval_request` events. You include it in your `approve`/`reject`/
  `respond` command to target the specific pending approval.

If you send `approve` with a wrong or stale `approvalId`, the CLI emits an
`approval_id_mismatch` error and the pending approval remains unresolved.

If you omit `approvalId` (backward compatibility), the CLI resolves the
single pending approval but emits a `legacy_approval_no_id` warning.

## Smoke Tests

PTY and non-interactive smoke tests live under `apps/cli/scripts`.

```bash
pnpm --filter @roo-code/cli test:tui:smoke
pnpm --filter @roo-code/cli test:noninteractive:smoke
```

These tests are for terminal/session plumbing. Model quality and runtime
qualification should be tested separately against real runtime contracts.
