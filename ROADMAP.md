# Mesa Code Roadmap

Mesa Code is a local/private-first coding agent CLI and TUI forked from Roo
Code. The roadmap is sequenced by practical user value: make local models work
reliably, build a trustworthy agent harness, keep the terminal workflow clean,
then add larger operator surfaces.

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

## 3. Agent Harness UX And Task Control

Mesa should make human-machine collaboration explicit and controllable. The TUI
should not just be a chat window; it should be a task control surface for
autonomous and semi-autonomous coding work.

- recent-task dashboard across terminal sessions
- task pinning for important long-running work
- task forking for alternate implementation paths
- task resume, retry, and recover actions with clear state
- expandable task windows for parallel work and long tool traces
- context snapshots that explain what the agent is using and why
- structured task summaries, diffs, artifacts, and next actions
- error presentation that separates actionable failures from scary internal
  noise
- bounded auto-retry for minor provider/tool failures with visible provenance

The product should reduce beginner intimidation without hiding real failures.
Errors that matter must stay visible; transient noise should be summarized and
made recoverable.

## 4. Hooks, Constraints, And Automation Loops

Automation needs physical interception points. Hooks are the difference between
"the model probably follows instructions" and "the harness enforces policy."

- pre-tool, post-tool, pre-edit, post-edit, pre-shell, and post-shell hooks
- provider request/response hooks for model-specific cleanup and validation
- policy hooks for mandatory constraints, budgets, and workspace rules
- loop hooks for iterative fix/test cycles
- approval hooks for risky shell commands, file writes, external fetches, and
  MCP calls
- local hook packs that can be versioned with a repo
- JSON/stream events for hook decisions and denials
- fail-closed behavior when mandatory hooks are missing or broken

Hooks should be first-class CLI/TUI behavior, not hidden extension callbacks.

## 5. Parallel Tasks And Sub-Agents

Mesa should support parallel software work without forcing users to manually
copy context between chat windows.

- native multi-task panes in the TUI
- scoped sub-agents with explicit input, tools, cwd, and budget
- inline delegation from a parent task to a child task
- structured result handoff back to the parent session
- isolated approvals and artifacts per child task
- conflict detection when child tasks touch overlapping files
- task-level cancellation and cleanup
- session traces that show which agent did what

Parallelism must remain controllable. The harness should make child work
visible, bounded, and reviewable instead of spawning opaque background agents.

## 6. Local Code Indexing And Search

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

## 7. Tool, MCP, Skills, And Prompt Budget Control

Mesa should treat tool exposure as a security and context-budget problem, not a
checkbox.

- explicit tool profiles, including read-only and pure/local-debug profiles
- per-mode allowed/blocked tool lists
- per-mode allowed/blocked MCP server lists
- skills and reusable workflows with explicit activation rules
- tool discovery that exposes only what the current task needs
- frictionless common tools without dumping every schema into every prompt
- prompt/tool schema budget reporting
- oversized tool and MCP outputs stored as local artifacts with previews, caps,
  and stable references
- shell-command approval based on a real command parser, not fragile string
  splitting
- URL/external content intake with explicit fetch policy, caps, provenance, and
  offline behavior

The CLI should not dump every configured tool schema into context just because a
server exists.

## 8. Provider Ecosystem And Model-Class Capability Profiles

Provider and model behavior should be normalized through explicit capability
profiles instead of scattered one-off hacks.

- community-maintainable provider adapters
- clear adapter contracts for OpenAI-compatible and Anthropic-compatible
  servers
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

## 9. Observability And Diagnostics

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

## 10. Session Portability And Recovery

Long coding tasks need reliable continuity.

- session resume, fork, import, and export
- checkpoint/restore for local workspace changes
- final diff review
- task-start rollback
- workspace identity that behaves correctly across multiple terminals and
  project roots
- clean behavior after failed edits, provider errors, cancellation, or terminal
  restarts

## 11. Operator Surfaces

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

## 12. Mesa Code Rename And Migration

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
