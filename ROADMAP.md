# Mesa Code Roadmap

Mesa Code is a local/private-first coding agent CLI and TUI forked from Roo
Code. The roadmap is sequenced by practical user value: make local models work
reliably, keep the terminal workflow clean, then add larger operator surfaces.

Detailed implementation notes, environment-specific runtime contracts, and
launch-planning notes do not belong in this public roadmap.

## 1. Local Endpoint Reliability

The first product promise is simple: if a user points Mesa at a local or
self-hosted model server, it should be obvious what is running and whether it is
usable.

- OpenAI-compatible local endpoint support
- Anthropic-compatible local endpoint support
- `vllm-mlx` support
- `llama.cpp` support after qualification
- `/v1/models` discovery where available
- explicit model/profile selection
- no silent fallback to the wrong model
- model switching from both CLI and TUI through the same readiness contract
- real cancellation for local OpenAI-compatible and Anthropic-compatible
  streams
- clear `doctor` and readiness output
- fail-closed behavior for unqualified runtime features

No fake controls: if a runtime feature is not actually qualified, the UI and CLI
should say so.

## 2. Shared CLI/TUI Session Core

Command-line, print, stdin-stream, and TUI flows should be different renderers
over the same session engine, not separate products with divergent behavior.

- one session event contract
- shared prompt submission path
- shared tool approval semantics
- shared cancellation, resume, and fork behavior
- stable text, JSON, and stream-json output contracts
- PTY smoke tests for interactive terminal paths
- same-type consecutive approval coverage
- renderer-specific output only where necessary

The default tool surface should stay small and legible. Richer operator
features should be layered on deliberately, not forced into every prompt.

## 3. Local Code Indexing And Search

Code indexing is a high-value local workflow and should be private by default.

- local/private semantic indexing
- provider-agnostic embedding configuration
- local embedding storage
- incremental re-indexing with stale-vector cleanup
- fast code search usable from CLI, TUI, and automation
- workspace-aware indexing for multi-root projects
- no OpenAI-only or cloud-only indexing path

Indexing should help the model retrieve relevant project context without
dumping large, unrelated environment details into every prompt.

## 4. Tool, MCP, And Prompt Budget Control

Mesa should treat tool exposure as a security and context-budget problem, not a
checkbox.

- explicit tool profiles, including read-only and pure/local-debug profiles
- per-mode allowed/blocked tool lists
- per-mode allowed/blocked MCP server lists
- prompt/tool schema budget reporting
- oversized tool and MCP outputs stored as local artifacts with previews, caps,
  and stable references
- shell-command approval based on a real command parser, not fragile string
  splitting
- URL/external content intake with explicit fetch policy, caps, provenance, and
  offline behavior

The CLI should not dump every configured tool schema into context just because a
server exists.

## 5. Model-Class Capability Profiles

Provider and model behavior should be normalized through explicit capability
profiles instead of scattered one-off hacks.

- reasoning extraction and rendering
- reasoning tag stripping where needed
- tool-call compatibility profiles
- vision/image transport differences
- context-window and token-budget behavior
- model-specific parameter policy
- capability-aware model picker

This is the foundation for supporting local Qwen, GLM/Z.ai, Ollama,
OpenAI-compatible servers, Anthropic-compatible servers, and future models
without turning every provider into a special case.

## 6. Observability And Diagnostics

Users should be able to understand what happened without digging through
private logs or guessing from a frozen UI.

- `doctor` and `status --json`
- structured local logs
- structured session traces
- metrics adapters for local model engines
- OpenTelemetry-aligned naming where practical
- session/tool statistics for prompt growth, tool count, context pressure, and
  output artifacts
- no secret leakage in diagnostics by default
- no fake status indicators

Telemetry, when added, should be local/private by default and should not replace
the metrics emitted by the runtime engines themselves.

## 7. Session Portability And Recovery

Long coding tasks need reliable continuity.

- session resume, fork, import, and export
- checkpoint/restore for local workspace changes
- final diff review
- task-start rollback
- workspace identity that behaves correctly across multiple terminals and
  project roots
- clean behavior after failed edits, provider errors, cancellation, or terminal
  restarts

## 8. Operator Surfaces

Operator surfaces come after the local CLI/TUI core is solid.

- `serve` and `attach`
- headless automation mode
- JSON log streaming
- local stats view
- provider/model management
- plugin/skill management with readiness checks
- security audit/fix commands for local config, permissions, and secrets
- remote/session relay only after local state contracts are strong

These should remain bounded and testable. Mesa should not become a giant
always-on automation daemon before it is an excellent local coding CLI.

## 9. Mesa Code Rename And Migration

Move from the Roo Code fork identity to Mesa Code without breaking early users.

- keep upstream Roo attribution clear
- retain a `roo` compatibility alias during migration
- add the `mesa` CLI command
- rename public package and install docs in stages
- keep useful local settings import paths
- document behavior differences
- remove cloud/auth assumptions from the CLI happy path
- avoid unnecessary internal namespace churn until the CLI surface is stable

## Not First

These are intentionally not the first priority:

- full VS Code extension parity
- hosted routing features
- required cloud account flows
- broad marketplace packaging before permission and provenance contracts are
  stable
- messaging/channel sprawl before the coding workflow is strong
