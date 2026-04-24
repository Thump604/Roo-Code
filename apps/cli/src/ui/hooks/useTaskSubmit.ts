import { useCallback } from "react"
import { randomUUID } from "crypto"

import { getGlobalCommand } from "../../lib/utils/commands.js"

import type { TuiApprovalAdapter } from "../tui-approval-adapter.js"
import { useCLIStore } from "../store.js"
import { useUIStateStore } from "../stores/uiStateStore.js"

export interface UseTaskSubmitOptions {
	sendTaskMessage: ((text: string, images?: string[]) => void) | null
	clearTask: (() => void) | null
	refreshCliMetadata: (() => void) | null
	approve: (() => void) | null
	reject: (() => void) | null
	runTask: ((prompt: string) => Promise<void>) | null
	seenMessageIds: React.MutableRefObject<Set<string>>
	firstTextMessageSkipped: React.MutableRefObject<boolean>
	tuiAdapter: TuiApprovalAdapter
}

export interface UseTaskSubmitReturn {
	handleSubmit: (text: string) => Promise<void>
	handleApprove: () => void
	handleReject: () => void
}

/**
 * Hook to handle task submission, user responses, and approvals.
 *
 * Responsibilities:
 * - Process user message submissions
 * - Detect and handle global commands (like /new)
 * - Handle pending ask responses (resolves the TUI approval adapter)
 * - Start new tasks or continue existing ones
 * - Handle Y/N approval responses
 */
export function useTaskSubmit({
	sendTaskMessage,
	clearTask,
	refreshCliMetadata,
	approve,
	reject,
	runTask,
	seenMessageIds,
	firstTextMessageSkipped,
	tuiAdapter,
}: UseTaskSubmitOptions): UseTaskSubmitReturn {
	const { pendingAsk, hasStartedTask, isComplete, addMessage, setHasStartedTask, setLoading, setComplete, setError } =
		useCLIStore()

	const { setShowCustomInput, setIsTransitioningToCustomInput } = useUIStateStore()

	/**
	 * Handle user text submission (from input or followup question)
	 */
	const handleSubmit = useCallback(
		async (text: string) => {
			if (!text.trim()) {
				return
			}

			const trimmedText = text.trim()

			if (trimmedText === "__CUSTOM__") {
				return
			}

			// Check for CLI global action commands (e.g., /new)
			if (trimmedText.startsWith("/")) {
				const commandMatch = trimmedText.match(/^\/(\w+)(?:\s|$)/)

				if (commandMatch && commandMatch[1]) {
					const globalCommand = getGlobalCommand(commandMatch[1])

					if (globalCommand?.action === "clearTask") {
						// Reset CLI state and ask the runtime for a fresh task view.
						useCLIStore.getState().reset()

						// Reset component-level refs to avoid stale message tracking.
						seenMessageIds.current.clear()
						firstTextMessageSkipped.current = false
						clearTask?.()

						// Re-request state, commands and modes since reset() cleared them.
						refreshCliMetadata?.()
						return
					}
				}
			}

			if (pendingAsk) {
				if (!sendTaskMessage) {
					return
				}

				addMessage({ id: randomUUID(), role: "user", content: trimmedText })

				// Resolve the TUI adapter promise (clears pendingAsk internally)
				tuiAdapter.resolve({ response: "messageResponse", text: trimmedText })

				sendTaskMessage(trimmedText)

				setShowCustomInput(false)
				setIsTransitioningToCustomInput(false)
				setLoading(true)
			} else if (!hasStartedTask) {
				setHasStartedTask(true)
				setLoading(true)
				addMessage({ id: randomUUID(), role: "user", content: trimmedText })

				try {
					if (runTask) {
						await runTask(trimmedText)
					}
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err))
					setLoading(false)
				}
			} else {
				if (!sendTaskMessage) {
					return
				}

				if (isComplete) {
					setComplete(false)
				}

				setLoading(true)
				addMessage({ id: randomUUID(), role: "user", content: trimmedText })

				sendTaskMessage(trimmedText)
			}
		},
		[
			sendTaskMessage,
			clearTask,
			refreshCliMetadata,
			runTask,
			pendingAsk,
			hasStartedTask,
			isComplete,
			addMessage,
			setHasStartedTask,
			setLoading,
			setComplete,
			setError,
			setShowCustomInput,
			setIsTransitioningToCustomInput,
			seenMessageIds,
			firstTextMessageSkipped,
			tuiAdapter,
		],
	)

	/**
	 * Handle approval (Y key) — resolves the adapter then dispatches via session controller.
	 */
	const handleApprove = useCallback(() => {
		if (!approve) {
			return
		}

		tuiAdapter.resolve({ response: "yesButtonClicked" })
		approve()
		setLoading(true)
	}, [approve, setLoading, tuiAdapter])

	/**
	 * Handle rejection (N key) — resolves the adapter then dispatches via session controller.
	 */
	const handleReject = useCallback(() => {
		if (!reject) {
			return
		}

		tuiAdapter.resolve({ response: "noButtonClicked" })
		reject()
		setLoading(true)
	}, [reject, setLoading, tuiAdapter])

	return {
		handleSubmit,
		handleApprove,
		handleReject,
	}
}
