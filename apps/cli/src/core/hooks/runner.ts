/**
 * Hook runner — executes hook commands as child processes.
 *
 * Sends a JSON event on stdin, reads a JSON result from stdout.
 * Non-zero exit or timeout is a hook failure.
 */

import { spawn } from "child_process"

import type { HookDefinition, HookEvent, HookResult, HookRunResult } from "./types.js"
import { HOOK_TIMEOUT_DEFAULT, HOOK_TIMEOUT_MAX } from "./types.js"

/**
 * Run a single hook command.
 *
 * The hook process receives the event as JSON on stdin.
 * It must write a JSON result to stdout and exit 0.
 */
export async function runHook(hook: HookDefinition, event: HookEvent): Promise<HookRunResult> {
	const timeout = clampTimeout(hook.timeoutMs)
	const started = Date.now()

	return new Promise<HookRunResult>((resolve) => {
		const [cmd, ...args] = hook.command
		const env = hook.env ? { ...process.env, ...hook.env } : process.env

		const child = spawn(cmd!, args, {
			cwd: hook.cwd || process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
			timeout,
		})

		let stdout = ""
		let stderr = ""
		let settled = false

		function settle(result: HookRunResult) {
			if (settled) return
			settled = true
			resolve(result)
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})

		child.on("error", (err) => {
			settle({
				ok: false,
				error: `hook command failed: ${err.message}`,
				durationMs: Date.now() - started,
			})
		})

		child.on("close", (code) => {
			const durationMs = Date.now() - started

			if (code !== 0) {
				settle({
					ok: false,
					error: `hook exited ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
					durationMs,
				})
				return
			}

			const trimmed = stdout.trim()
			if (!trimmed) {
				// Empty stdout on exit 0 is treated as success with no result
				settle({ ok: true, result: { action: "allow" }, durationMs })
				return
			}

			let parsed: HookResult
			try {
				parsed = JSON.parse(trimmed)
			} catch {
				settle({
					ok: false,
					error: `hook stdout is not valid JSON: ${trimmed.slice(0, 200)}`,
					durationMs,
				})
				return
			}

			settle({ ok: true, result: parsed, durationMs })
		})

		// Send the event on stdin and close it
		try {
			child.stdin?.write(JSON.stringify(event) + "\n")
			child.stdin?.end()
		} catch {
			// stdin may already be closed if the process errored immediately
		}
	})
}

function clampTimeout(value: number | undefined): number {
	if (value === undefined) return HOOK_TIMEOUT_DEFAULT
	return Math.max(100, Math.min(value, HOOK_TIMEOUT_MAX))
}
