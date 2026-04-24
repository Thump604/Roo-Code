/**
 * HookManager — central orchestrator for the hook system.
 *
 * Loads config, resolves which hooks apply to each event, runs them,
 * and returns allow/deny decisions for before_* hooks.
 */

import { loadHooksConfig } from "./config.js"
import { runHook } from "./runner.js"
import type { HookDefinition, HookEvent, HookEventName, HookRunResult, HooksConfig } from "./types.js"

export interface BeforeToolResult {
	allowed: boolean
	reason?: string
	hookErrors: string[]
}

export class HookManager {
	private config: HooksConfig = { hooks: [] }
	private loaded = false

	/**
	 * Load hooks config from the workspace directory.
	 * Safe to call multiple times — reloads each time.
	 */
	async loadConfig(workspaceDir: string): Promise<void> {
		this.config = await loadHooksConfig(workspaceDir)
		this.loaded = true
	}

	get isLoaded(): boolean {
		return this.loaded
	}

	get hookCount(): number {
		return this.getEnabledHooks().length
	}

	/**
	 * Run all before_tool hooks. Returns allow/deny.
	 *
	 * If any hook denies, the tool is blocked. If any hook fails
	 * (non-zero exit, timeout, invalid JSON), the tool is also blocked
	 * (fail-closed).
	 */
	async runBeforeTool(payload: Record<string, unknown>): Promise<BeforeToolResult> {
		return this.runBeforeHooks("before_tool", payload)
	}

	/**
	 * Run all after_tool hooks (observe-only — result is not used for gating).
	 */
	async runAfterTool(payload: Record<string, unknown>): Promise<HookRunResult[]> {
		return this.runObserveHooks("after_tool", payload)
	}

	/**
	 * Run all before_model_request hooks. Returns allow/deny.
	 */
	async runBeforeModelRequest(payload: Record<string, unknown>): Promise<BeforeToolResult> {
		return this.runBeforeHooks("before_model_request", payload)
	}

	/**
	 * Run all after_model_response hooks (observe-only).
	 */
	async runAfterModelResponse(payload: Record<string, unknown>): Promise<HookRunResult[]> {
		return this.runObserveHooks("after_model_response", payload)
	}

	/**
	 * Run all task_start hooks (observe-only).
	 */
	async runTaskStart(payload: Record<string, unknown>): Promise<HookRunResult[]> {
		return this.runObserveHooks("task_start", payload)
	}

	/**
	 * Run all task_end hooks (observe-only).
	 */
	async runTaskEnd(payload: Record<string, unknown>): Promise<HookRunResult[]> {
		return this.runObserveHooks("task_end", payload)
	}

	/**
	 * Run all approval_request hooks (observe-only).
	 */
	async runApprovalRequest(payload: Record<string, unknown>): Promise<HookRunResult[]> {
		return this.runObserveHooks("approval_request", payload)
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private getEnabledHooks(event?: HookEventName): HookDefinition[] {
		return this.config.hooks.filter((h) => {
			if (h.enabled === false) return false
			if (event && h.event !== event) return false
			return true
		})
	}

	private buildEvent(event: HookEventName, payload: Record<string, unknown>): HookEvent {
		return {
			event,
			timestamp: new Date().toISOString(),
			payload,
		}
	}

	private async runBeforeHooks(event: HookEventName, payload: Record<string, unknown>): Promise<BeforeToolResult> {
		const hooks = this.getEnabledHooks(event)
		if (hooks.length === 0) {
			return { allowed: true, hookErrors: [] }
		}

		const hookEvent = this.buildEvent(event, payload)
		const errors: string[] = []

		for (const hook of hooks) {
			const result = await runHook(hook, hookEvent)

			if (!result.ok) {
				errors.push(result.error || "hook failed")
				// Fail-closed: hook failure blocks the action
				return { allowed: false, reason: `hook failed: ${result.error}`, hookErrors: errors }
			}

			if (result.result?.action === "deny") {
				return {
					allowed: false,
					reason: result.result.reason || "denied by hook",
					hookErrors: errors,
				}
			}
		}

		return { allowed: true, hookErrors: errors }
	}

	private async runObserveHooks(event: HookEventName, payload: Record<string, unknown>): Promise<HookRunResult[]> {
		const hooks = this.getEnabledHooks(event)
		if (hooks.length === 0) return []

		const hookEvent = this.buildEvent(event, payload)
		const results: HookRunResult[] = []

		for (const hook of hooks) {
			results.push(await runHook(hook, hookEvent))
		}

		return results
	}
}
