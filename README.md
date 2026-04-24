# Mesa Code

Mesa Code is an early public fork of Roo Code focused on a practical gap:
making local and self-hosted AI coding workflows reliable from the terminal.

Most coding agents can send a prompt to an endpoint. Mesa Code is being shaped
to also understand the operating facts around that endpoint: which model was
requested, which model is actually serving, whether it is ready, which features
are qualified, what tools are exposed, and whether approvals behave the same
way in the TUI, CLI, and automation modes.

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
- local/private code indexing and semantic search
- first-class local runtime and session observability
- stable text, JSON, and stream contracts for automation
- explicit user control over tools, approvals, model selection, MCP scope, and
  config
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

The goal is for the CLI to understand:

- what model was requested
- what model is actually serving
- whether the requested model is ready
- whether runtime features are qualified for that model
- what the runtime health and queue state look like
- which tool and MCP schemas are actually needed for the current mode
- whether approval, cancellation, and resume behavior is consistent across TUI,
  CLI, print, and stream modes

That makes local inference easier to trust and easier to automate.

## What Comes First

The early roadmap is sequenced around user value:

1. Make local endpoints work predictably: OpenAI-compatible and
   Anthropic-compatible servers, model discovery, model selection, cancellation,
   and readiness checks.
2. Keep the CLI/TUI core unified: one session model, one approval contract, one
   automation stream, renderer-specific UI only where needed.
3. Add local/private code indexing: provider-agnostic embeddings, local storage,
   fast search, and no cloud dependency for private code.
4. Control tool and MCP overhead: explicit tool profiles, per-mode MCP scope,
   artifact handling for large outputs, and no accidental prompt bloat.
5. Expose useful diagnostics: `doctor`, `status --json`, structured logs,
   session traces, and runtime metrics without leaking secrets by default.
6. Add operator surfaces later: `serve`, `attach`, plugin/skill management, and
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
