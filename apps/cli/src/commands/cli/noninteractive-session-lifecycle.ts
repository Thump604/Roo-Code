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
}

export function createNonInteractiveSessionLifecycle({
	useJsonOutput,
	jsonEmitter,
	nonInteractive,
	exitOnError,
	stdinPromptStream,
	bootstrapResumeForStdinStream,
	taskIndex,
}: NonInteractiveSessionLifecycleOptions): CliSessionLifecycle {
	let textSurface: TextSessionSurface | null = null

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

			// Subscribe to task completion as an event listener (additive, not replacement).
			// Task start is recorded by the runner after launch — not here — because
			// onStart in the lifecycle contract replaces the default launch path.
			if (taskIndex) {
				runtime.onTaskCompleted((event) => {
					// Fire-and-forget: index update must not block task completion
					void taskIndex.updateStatus(event.success ? "completed" : "failed").catch(() => {})
				})
			}
		},
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
