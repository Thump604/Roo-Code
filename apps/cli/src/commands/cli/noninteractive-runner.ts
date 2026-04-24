import pWaitFor from "p-wait-for"

import { JsonEventEmitter } from "@/agent/json-event-emitter.js"
import {
	CliSessionController,
	createSessionLifecycleStartOptions,
	type CliRuntime,
	type CliRuntimeOptions,
	type CreateCliRuntime,
} from "@/runtime/index.js"
import { isValidOutputFormat } from "@/types/json-events.js"

import { TaskIndex } from "@/core/task-index/index.js"
import { HookManager } from "@/core/hooks/index.js"
import { getConfigDir } from "@/lib/storage/config-dir.js"

import { isExpectedControlFlowError } from "./cancellation.js"
import { createNonInteractiveSessionLifecycle } from "./noninteractive-session-lifecycle.js"
import { runStdinStreamMode } from "./stdin-stream.js"

const SIGNAL_ONLY_EXIT_KEEPALIVE_MS = 60_000
const STREAM_RESUME_WAIT_TIMEOUT_MS = 2_000

export interface RunNonInteractiveCliSessionOptions {
	createCliRuntime: CreateCliRuntime
	runtimeOptions: CliRuntimeOptions
	prompt?: string
	requestedCreateSessionId?: string
	requestedSessionId?: string
	shouldContinueSession: boolean
	outputFormat: "text" | "json" | "stream-json"
	useStdinPromptStream: boolean
	signalOnlyExit: boolean
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

async function bootstrapResumeForStdinStream(runtime: CliRuntime, sessionId: string): Promise<void> {
	runtime.selectTask(sessionId)

	// Best-effort wait so early stdin "message" commands can target the resumed task.
	await pWaitFor(() => runtime.hasActiveTask() || runtime.isWaitingForInput(), {
		interval: 25,
		timeout: STREAM_RESUME_WAIT_TIMEOUT_MS,
	}).catch(() => undefined)
}

export async function runNonInteractiveCliSession({
	createCliRuntime,
	runtimeOptions,
	prompt,
	requestedCreateSessionId,
	requestedSessionId,
	shouldContinueSession,
	outputFormat,
	useStdinPromptStream,
	signalOnlyExit,
}: RunNonInteractiveCliSessionOptions): Promise<void> {
	if (!isValidOutputFormat(outputFormat)) {
		throw new Error(`Invalid output format: ${outputFormat}`)
	}

	const useJsonOutput = outputFormat === "json" || outputFormat === "stream-json"

	runtimeOptions.disableOutput = true

	let sessionController: CliSessionController | null = null
	let sessionLifecycle: ReturnType<typeof createNonInteractiveSessionLifecycle> | null = null
	let streamRequestId: string | undefined
	let keepAliveInterval: NodeJS.Timeout | undefined
	let isShuttingDown = false
	let runtimeDisposed = false

	const jsonEmitter = useJsonOutput
		? new JsonEventEmitter({
				mode: outputFormat as "json" | "stream-json",
				requestIdProvider: () => streamRequestId,
			})
		: null

	const emitRuntimeError = (error: Error, source?: string) => {
		const errorMessage = source ? `${source}: ${error.message}` : error.message

		if (useJsonOutput) {
			const errorEvent = { type: "error", id: Date.now(), content: errorMessage }
			process.stdout.write(JSON.stringify(errorEvent) + "\n")
			return
		}

		console.error("[CLI] Error:", errorMessage)
		console.error(error.stack)
	}

	const clearKeepAliveInterval = () => {
		if (!keepAliveInterval) {
			return
		}

		clearInterval(keepAliveInterval)
		keepAliveInterval = undefined
	}

	const flushStdout = async () => {
		try {
			if (!process.stdout.writable || process.stdout.destroyed) {
				return
			}

			await new Promise<void>((resolve, reject) => {
				process.stdout.write("", (error?: Error | null) => {
					if (error) {
						reject(error)
						return
					}

					resolve()
				})
			})
		} catch {
			// Best effort: shutdown should proceed even if stdout flush fails.
		}
	}

	const ensureKeepAliveInterval = () => {
		if (!signalOnlyExit || keepAliveInterval) {
			return
		}

		keepAliveInterval = setInterval(() => {}, SIGNAL_ONLY_EXIT_KEEPALIVE_MS)
	}

	const disposeRuntime = async () => {
		if (runtimeDisposed || !sessionController) {
			return
		}

		runtimeDisposed = true

		// Cancel the active task before cleanup so the task loop and provider
		// streams get a proper abort signal instead of a raw socket close.
		try {
			sessionController.cancelTask()
		} catch {
			// Task may already be done or controller not ready — proceed with cleanup.
		}

		await sessionLifecycle?.dispose?.()
		sessionLifecycle = null
		jsonEmitter?.detach()
		await sessionController.cleanup()
	}

	const onSigint = () => {
		void shutdown("SIGINT", 130)
	}

	const onSigterm = () => {
		void shutdown("SIGTERM", 143)
	}

	const onUncaughtException = (error: Error) => {
		if (
			isExpectedControlFlowError(error, {
				stdinStreamMode: useStdinPromptStream,
				shuttingDown: isShuttingDown,
				operation: "runtime",
			})
		) {
			return
		}

		emitRuntimeError(error, "uncaughtException")

		if (signalOnlyExit) {
			return
		}

		void shutdown("uncaughtException", 1)
	}

	const onUnhandledRejection = (reason: unknown) => {
		if (
			isExpectedControlFlowError(reason, {
				stdinStreamMode: useStdinPromptStream,
				shuttingDown: isShuttingDown,
				operation: "runtime",
			})
		) {
			return
		}

		const error = normalizeError(reason)
		emitRuntimeError(error, "unhandledRejection")

		if (signalOnlyExit) {
			return
		}

		void shutdown("unhandledRejection", 1)
	}

	const parkUntilSignal = async (reason: string): Promise<never> => {
		ensureKeepAliveInterval()

		if (!useJsonOutput) {
			console.error(`[CLI] ${reason} (--signal-only-exit active; waiting for SIGINT/SIGTERM).`)
		}

		await new Promise<void>(() => {})
		throw new Error("unreachable")
	}

	async function shutdown(signal: string, exitCode: number): Promise<void> {
		if (isShuttingDown) {
			return
		}

		isShuttingDown = true
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
		process.off("uncaughtException", onUncaughtException)
		process.off("unhandledRejection", onUnhandledRejection)
		clearKeepAliveInterval()

		if (!useJsonOutput) {
			console.log(`\n[CLI] Received ${signal}, shutting down...`)
		}

		await disposeRuntime()
		if (jsonEmitter) {
			await jsonEmitter.flush()
		}
		await flushStdout()
		process.exit(exitCode)
	}

	process.on("SIGINT", onSigint)
	process.on("SIGTERM", onSigterm)
	process.on("uncaughtException", onUncaughtException)
	process.on("unhandledRejection", onUnhandledRejection)

	try {
		sessionController = new CliSessionController({
			createCliRuntime,
			runtimeOptions,
		})
		const activeSessionController = sessionController
		const taskIndex = new TaskIndex(getConfigDir())
		sessionLifecycle = createNonInteractiveSessionLifecycle({
			useJsonOutput,
			jsonEmitter,
			nonInteractive: runtimeOptions.nonInteractive ?? false,
			exitOnError: runtimeOptions.exitOnError,
			stdinPromptStream: useStdinPromptStream,
			bootstrapResumeForStdinStream,
			taskIndex,
		})

		await activeSessionController.start(
			createSessionLifecycleStartOptions(activeSessionController, sessionLifecycle, {
				initialPrompt: prompt,
				initialTaskId: requestedCreateSessionId,
				initialSessionId: requestedSessionId,
				continueSession: shouldContinueSession,
			}),
		)

		// Record task start in index AFTER launch succeeds.
		// Uses a generated label — never raw prompt text.
		// setActiveTaskId is called synchronously so that updateStatus
		// (fired by onTaskCompleted) can find the task even if the async
		// upsert write hasn't completed yet.
		if (prompt) {
			const taskId = requestedCreateSessionId || `task-${Date.now()}`
			taskIndex.setActiveTaskId(taskId)
			void taskIndex
				.upsert({
					taskId,
					cwd: runtimeOptions.workspacePath || process.cwd(),
					promptSummary: `CLI task started at ${new Date().toISOString().slice(0, 19)}`,
					taskStatus: "running",
					model: runtimeOptions.model,
					provider: runtimeOptions.provider,
				})
				.catch(() => {})
		}

		if (useStdinPromptStream) {
			if (!jsonEmitter || outputFormat !== "stream-json") {
				throw new Error("--stdin-prompt-stream requires --output-format=stream-json to emit control events")
			}

			// Load hooks from workspace .mesa/hooks.json or .roo/hooks.json
			const hookManager = new HookManager()
			try {
				await hookManager.loadConfig(runtimeOptions.workspacePath || process.cwd())
			} catch {
				// Config load failure is not fatal — hooks just won't run
			}

			await runStdinStreamMode({
				sessionController: activeSessionController,
				jsonEmitter,
				setStreamRequestId: (id) => {
					streamRequestId = id
				},
				hookManager: hookManager.hookCount > 0 ? hookManager : undefined,
			})
		}

		await disposeRuntime()
		if (jsonEmitter) {
			await jsonEmitter.flush()
		}
		await flushStdout()

		if (signalOnlyExit) {
			await parkUntilSignal("Task loop completed")
		}

		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
		process.off("uncaughtException", onUncaughtException)
		process.off("unhandledRejection", onUnhandledRejection)
		process.exit(0)
	} catch (error) {
		emitRuntimeError(normalizeError(error))
		await disposeRuntime()
		if (jsonEmitter) {
			await jsonEmitter.flush()
		}
		await flushStdout()

		if (signalOnlyExit) {
			await parkUntilSignal("Task loop failed")
		}

		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
		process.off("uncaughtException", onUncaughtException)
		process.off("unhandledRejection", onUnhandledRejection)
		process.exit(1)
	}
}
