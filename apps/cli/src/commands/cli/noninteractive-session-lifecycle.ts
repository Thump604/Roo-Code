import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"
import { TextSessionSurface } from "@/agent/text-session-surface.js"
import type { CliSessionLifecycle } from "@/runtime/session-lifecycle.js"
import type { CliRuntime } from "@/runtime/runtime.js"
import type { TaskIndex } from "@/core/task-index/index.js"

export interface NonInteractiveSessionLifecycleOptions {
	useJsonOutput: boolean
	jsonEmitter: JsonEventEmitter | null
	nonInteractive: boolean
	exitOnError?: boolean
	stdinPromptStream?: boolean
	bootstrapResumeForStdinStream?: (runtime: CliRuntime, sessionId: string) => Promise<void>
	taskIndex?: TaskIndex
	workspacePath?: string
	model?: string
	provider?: string
}

export function createNonInteractiveSessionLifecycle({
	useJsonOutput,
	jsonEmitter,
	nonInteractive,
	exitOnError,
	stdinPromptStream,
	bootstrapResumeForStdinStream,
	taskIndex,
	workspacePath,
	model,
	provider,
}: NonInteractiveSessionLifecycleOptions): CliSessionLifecycle {
	let textSurface: TextSessionSurface | null = null
	let activeTaskId: string | undefined

	return {
		afterActivate: (runtime, controller) => {
			if (!useJsonOutput) {
				textSurface = new TextSessionSurface(runtime, {
					nonInteractive,
					exitOnError,
				})
				textSurface.attach()
			}

			if (jsonEmitter) {
				controller.attachJsonEmitter(jsonEmitter)
			}
		},
		onStart: taskIndex
			? async (launch) => {
					activeTaskId = launch.taskId || `task-${Date.now()}`
					await taskIndex.upsert({
						taskId: activeTaskId,
						cwd: workspacePath || process.cwd(),
						promptSummary: launch.prompt ? `Task: ${launch.prompt.slice(0, 100)}` : "(no summary)",
						taskStatus: "running",
						model,
						provider,
					})
				}
			: undefined,
		onTaskCompleted: taskIndex
			? async (event) => {
					const taskId = activeTaskId || `task-${Date.now()}`
					await taskIndex.upsert({
						taskId,
						cwd: workspacePath || process.cwd(),
						promptSummary: "",
						taskStatus: event.success ? "completed" : "failed",
						model,
						provider,
					})
				}
			: undefined,
		onResume:
			stdinPromptStream && bootstrapResumeForStdinStream
				? async (launch, controller) => {
						await bootstrapResumeForStdinStream(controller.getRuntimeOrThrow(), launch.sessionId)
					}
				: undefined,
		dispose: async () => {
			if (!textSurface) {
				return
			}

			await textSurface.dispose()
			textSurface = null
		},
	}
}
