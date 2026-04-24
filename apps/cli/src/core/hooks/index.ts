/**
 * Hook system for Mesa Code CLI.
 *
 * Provides interception points for agent events: tool calls, model requests,
 * task lifecycle, and approval requests. Hooks are external commands that
 * receive JSON on stdin and return JSON on stdout.
 *
 * Usage:
 *   const manager = new HookManager()
 *   await manager.loadConfig(workspaceDir)
 *   const result = await manager.runBeforeTool({ tool: "execute_command", input: { command: "ls" } })
 *   if (!result.allowed) { // blocked by hook }
 */

export { HookManager } from "./manager.js"
export { loadHooksConfig } from "./config.js"
export { runHook } from "./runner.js"
export type { HookDefinition, HookEvent, HookEventName, HookResult, HookRunResult, HooksConfig } from "./types.js"
