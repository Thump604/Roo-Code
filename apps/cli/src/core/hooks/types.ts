/**
 * Hook system types for Mesa Code CLI.
 *
 * Hooks are external commands that intercept agent events. They receive
 * a JSON event on stdin and return a JSON result on stdout.
 */

/**
 * Hook event names that can be intercepted.
 */
export type HookEventName =
	| "task_start"
	| "task_end"
	| "before_tool"
	| "after_tool"
	| "before_model_request"
	| "after_model_response"
	| "approval_request"

/**
 * A single hook definition in the config file.
 */
export interface HookDefinition {
	/** The event this hook intercepts. */
	event: HookEventName
	/** Command as an argv array — NOT a shell string. */
	command: string[]
	/** Timeout in milliseconds. Default: 10000, max: 60000. */
	timeoutMs?: number
	/** Working directory for the command. */
	cwd?: string
	/** Extra environment variables. */
	env?: Record<string, string>
	/** Whether this hook is enabled. Default: true. */
	enabled?: boolean
}

/**
 * The hooks config file shape (.mesa/hooks.json or .roo/hooks.json).
 */
export interface HooksConfig {
	hooks: HookDefinition[]
}

/**
 * The JSON event sent to a hook command on stdin.
 */
export interface HookEvent {
	/** The event name. */
	event: HookEventName
	/** Timestamp (ISO 8601). */
	timestamp: string
	/** Event-specific payload. */
	payload: Record<string, unknown>
}

/**
 * The JSON result returned by a hook command on stdout.
 *
 * For before_tool hooks:
 * - action: "allow" lets the tool proceed
 * - action: "deny" blocks the tool with an optional reason
 *
 * For observe-only hooks (after_tool, task_start, etc.):
 * - any valid JSON is accepted; the action field is ignored
 */
export interface HookResult {
	/** "allow" or "deny" — only meaningful for before_* hooks. */
	action?: "allow" | "deny"
	/** Human-readable reason for deny. */
	reason?: string
}

/**
 * Result of running a hook.
 */
export interface HookRunResult {
	/** Whether the hook succeeded (exit 0 + valid JSON). */
	ok: boolean
	/** The parsed result from stdout. */
	result?: HookResult
	/** Error message if the hook failed. */
	error?: string
	/** Duration in milliseconds. */
	durationMs: number
}

/** Default timeout for hooks. */
export const HOOK_TIMEOUT_DEFAULT = 10_000

/** Maximum allowed timeout for hooks. */
export const HOOK_TIMEOUT_MAX = 60_000
