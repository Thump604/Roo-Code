# Mesa Code CLI

Terminal CLI and TUI package for Mesa Code, a local-first coding agent forked
from Roo Code.

The CLI is being refactored toward one shared session core used by interactive
TUI, print mode, stdin-stream automation, and file/command-line workflows.
Renderers may differ, but prompt handling, tool approval, cancellation, resume,
and runtime invocation should not drift across modes.

The package still uses `@roo-code/cli` and the `roo` binary while the public
rename is staged. The intended public command is `mesa`; `roo` will remain as a
compatibility alias during migration.

## Current Focus

- local/self-hosted endpoint support with explicit model discovery
- shared CLI/TUI session controller and approval contract
- stable text, JSON, and stream-json output contracts
- real cancellation, resume, and same-type approval behavior across modes
- local/private code indexing and search
- explicit tool and MCP scope control
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

Future operator surfaces such as `serve`, `attach`, logs, stats, plugin/skill
management, and remote/session relay should build on the same session/runtime
contracts instead of creating a second behavior model.

## Smoke Tests

PTY and non-interactive smoke tests live under `apps/cli/scripts`.

```bash
pnpm --filter @roo-code/cli test:tui:smoke
pnpm --filter @roo-code/cli test:noninteractive:smoke
```

These tests are for terminal/session plumbing. Model quality and runtime
qualification should be tested separately against real runtime contracts.
