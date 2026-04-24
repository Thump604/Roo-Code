# Mesa Code

Mesa Code is an early public fork of Roo Code focused on a practical gap:
making local and self-hosted AI coding workflows reliable from the terminal.

Most coding agents can send a prompt to an endpoint. Mesa Code is being shaped
as a terminal-native agent harness: it should understand which model was
requested, which model is actually serving, whether it is ready, which features
are qualified, what tools are exposed, what constraints must be enforced, and
whether approvals behave the same way in the TUI, CLI, and automation modes.

## Status

This fork is in active development and is not packaged as a stable release yet.
The public roadmap is a draft and will change as the CLI architecture settles.

The product name is **Mesa Code**. The repository still contains forked Roo Code
package names and compatibility paths while the rename is staged. The intended
CLI command is `mesa`; `roo` will remain a compatibility alias during migration.

See [ROADMAP.md](ROADMAP.md) for the current public plan.

## Direction

- CLI and TUI first
- local/self-hosted runtimes first
- no required cloud account in the happy path
- OpenAI-compatible and Anthropic-compatible local endpoint support
- runtime readiness and model identity checks before claiming success
- local model discovery instead of manual/stale model IDs
- explicit approval protocol with typed `approvalId` targeting for automation
- stable text, JSON, and NDJSON stream contracts for automation
- local/private code indexing and semantic search
- first-class local runtime and session observability
- task history, task pinning, task forking, and task recovery as first-class
  workflow objects
- hook points for mandatory constraints before and after tool/model actions
- parallel task and sub-agent workflows without context-jump hacks
- explicit user control over tools, approvals, model selection, MCP scope, and
  config
- multi-provider ecosystem with normalized capability profiles (OpenRouter
  migrated to shared ModelAdapter with tag stripping and reasoning extraction)
- generalized artifact store for oversized tool, MCP, search, and test output
- editor integration later, after the CLI core is solid

## Local Runtime Goals

Mesa Code is being shaped around local model engines such as:

- `vllm-mlx`
- `llama.cpp`
- OpenAI-compatible local servers
- Anthropic-compatible local servers

The CLI should not hide local runtime complexity behind fake green buttons. If
a runtime feature is not qualified, the CLI should say so clearly and fail
closed.

## Why Not Just Another Coding CLI?

Some coding CLIs optimize for a tiny tool surface. Some optimize for broad
agent operations. Some are strongest as structured automation harnesses. Mesa
Code is aimed at combining the useful parts around a narrower local/private
goal.

The goal is for the CLI/TUI to understand:

- what model was requested
- what model is actually serving
- whether the requested model is ready
- whether runtime features are qualified for that model
- what the runtime health and queue state look like
- which tool and MCP schemas are actually needed for the current mode
- whether approval, cancellation, and resume behavior is consistent across TUI,
  CLI, print, and stream modes
- which task is active, pinned, forked, recoverable, or safe to retry
- which hooks and policies must intercept a tool call, shell command, file edit,
  or provider request
- which sub-agent or parallel task is allowed to run and how its result returns
  to the parent session

That makes local inference easier to trust and easier to automate.

## What Comes First

The early roadmap is sequenced around user value:

1. Make local endpoints work predictably: OpenAI-compatible and
   Anthropic-compatible servers, model discovery, model selection, cancellation,
   and readiness checks.
2. Keep the CLI/TUI core unified: one session model, one approval contract, one
   automation stream, renderer-specific UI only where needed.
3. Build the agent harness: task history, task pinning, task forking, recent
   task dashboards, context snapshots, and expandable TUI task views.
4. Add hooks and policy interception: mandatory pre/post constraints for tools,
   edits, shell commands, provider calls, loops, and automation.
5. Add parallel task and sub-agent workflows: native multi-task panes, scoped
   child sessions, inline delegation, and structured result handoff.
6. Add local/private code indexing: provider-agnostic embeddings, local storage,
   fast search, and no cloud dependency for private code.
7. Control tool and MCP overhead: explicit tool profiles, per-mode MCP scope,
   artifact handling for large outputs, and no accidental prompt bloat.
8. Expose useful diagnostics: `doctor`, `status --json`, structured logs,
   session traces, and runtime metrics without leaking secrets by default.
9. Add operator surfaces later: `serve`, `attach`, plugin/skill management, and
   remote/session relay only after the local core is stable.

## Development

Prerequisites:

- Node.js 20.x
- `pnpm`

Install dependencies:

```bash
pnpm install
```

Build the CLI:

```bash
pnpm --filter @roo-code/cli build
```

Run CLI checks:

```bash
pnpm --filter @roo-code/cli check-types
pnpm --filter @roo-code/cli test
```

Run monorepo checks:

```bash
pnpm check-types
pnpm lint
```

## Repository Layout

- [apps/cli](apps/cli) - terminal CLI and TUI work
- [src](src) - existing Roo extension/runtime code being carved apart
- [packages/core](packages/core) - shared core logic
- [packages/types](packages/types) - shared contracts and provider/model types
- [webview-ui](webview-ui) - upstream webview UI retained while the fork narrows
- [ROADMAP.md](ROADMAP.md) - public draft roadmap

## Contributing

This fork is not ready for broad drive-by contribution yet, but focused
collaboration is welcome around:

- CLI/TUI session architecture
- local runtime adapters
- local model discovery and setup
- task UX, task history, and session recovery
- hooks, constraints, and approval policy
- parallel task and sub-agent orchestration
- local/private code indexing
- tool and MCP scope control
- terminal UX
- model/runtime/session observability
- privacy-first defaults
- tests for command-line and PTY behavior

Open an issue or discussion before starting large changes so the work lines up
with the fork direction.

## License

This repository remains under the upstream [Apache 2.0](LICENSE) license.
