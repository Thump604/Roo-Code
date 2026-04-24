import { randomUUID } from "crypto"

import type {
	ClineAsk,
	ClineMessage,
	RooCliStartCommand,
	RooCliMessageCommand,
	RooCliCancelCommand,
	RooCliApproveCommand,
	RooCliRejectCommand,
	RooCliRespondCommand,
} from "@roo-code/types"

import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"
import type { TaskCompletedEvent } from "@/agent/events.js"
import type { CliSessionController } from "@/runtime/index.js"
import { isRecord } from "@/lib/utils/guards.js"

import { classifyAsk, shouldRouteAsAskResponse, sendApprovalResponse } from "@/agent/approval-adapter.js"

import { StdinStreamApprovalAdapter } from "./stdin-stream-approval-adapter.js"
import { isCancellationLikeError, isExpectedControlFlowError, isNoActiveTaskLikeError } from "./cancellation.js"

const RESUME_ASKS = new Set(["resume_task", "resume_completed_task"])
const CANCEL_RECOVERY_WAIT_TIMEOUT_MS = 8_000
const CANCEL_RECOVERY_POLL_INTERVAL_MS = 100
const STDIN_EOF_RESUME_WAIT_TIMEOUT_MS = 2_000
const STDIN_EOF_POLL_INTERVAL_MS = 100
const STDIN_EOF_IDLE_ASKS = new Set(["completion_result", "resume_completed_task"])
const STDIN_EOF_IDLE_STABLE_POLLS = 2

interface StreamQueueItem {
	id: string
	text?: string
	imageCount: number
	timestamp?: number
}

export interface StdinStreamSessionOptions {
	sessionController: CliSessionController
	jsonEmitter: JsonEventEmitter
	setStreamRequestId: (id: string | undefined) => void
	isShuttingDown: () => boolean
}

/**
 * @deprecated Use shouldRouteAsAskResponse from approval-adapter.ts directly.
 * Kept for backward compatibility with existing imports.
 */
export function shouldSendMessageAsAskResponse(waitingForInput: boolean, currentAsk: string | undefined): boolean {
	return shouldRouteAsAskResponse(waitingForInput, currentAsk as import("@roo-code/types").ClineAsk | undefined)
}

function normalizeQueueText(text: string | undefined): string | undefined {
	if (!text) {
		return undefined
	}

	const compact = text.replace(/\s+/g, " ").trim()
	if (!compact) {
		return undefined
	}

	return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`
}

function parseQueueSnapshot(rawQueue: unknown): StreamQueueItem[] | undefined {
	if (!Array.isArray(rawQueue)) {
		return undefined
	}

	const snapshot: StreamQueueItem[] = []

	for (const entry of rawQueue) {
		if (!isRecord(entry)) {
			continue
		}

		const idRaw = entry.id
		if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
			continue
		}

		const imagesRaw = entry.images
		const timestampRaw = entry.timestamp
		const imageCount = Array.isArray(imagesRaw) ? imagesRaw.length : 0

		snapshot.push({
			id: idRaw,
			text: normalizeQueueText(typeof entry.text === "string" ? entry.text : undefined),
			imageCount,
			timestamp: typeof timestampRaw === "number" ? timestampRaw : undefined,
		})
	}

	return snapshot
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) {
		return false
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false
		}
	}

	return true
}

export class StdinStreamSession {
	private activeTaskPromise: Promise<void> | null = null
	private fatalStreamError: Error | null = null
	private activeRequestId: string | undefined
	private activeTaskCommand: "start" | undefined
	private latestTaskId: string | undefined
	private cancelRequestedForActiveTask = false
	private awaitingPostCancelRecovery = false
	private hasSeenQueueState = false
	private lastQueueDepth = 0
	private lastQueueMessageIds: string[] = []
	private readonly pendingQueuedMessageRequestIds: string[] = []
	private readonly queueMessageRequestIdByMessageId = new Map<string, string>()

	/** Active approval adapter for explicit approve/reject/respond commands. */
	readonly approvalAdapter: StdinStreamApprovalAdapter

	/** Last known ask type — used to detect ask transitions in state messages. */
	private lastKnownAsk: ClineAsk | undefined

	constructor(private readonly options: StdinStreamSessionOptions) {
		this.approvalAdapter = new StdinStreamApprovalAdapter(options.jsonEmitter, () => this.latestTaskId)
	}

	getLatestTaskId(): string | undefined {
		return this.latestTaskId
	}

	getFatalError(): Error | null {
		return this.fatalStreamError
	}

	handleClientError(error: Error): void {
		if (
			isExpectedControlFlowError(error, {
				stdinStreamMode: true,
				cancelRequested: this.cancelRequestedForActiveTask,
				shuttingDown: this.options.isShuttingDown(),
				operation: "client",
			})
		) {
			if (
				this.activeTaskCommand === "start" &&
				(this.cancelRequestedForActiveTask || isCancellationLikeError(error))
			) {
				this.options.jsonEmitter.emitControl({
					subtype: "done",
					requestId: this.activeRequestId,
					command: "start",
					taskId: this.latestTaskId,
					content: "task cancelled",
					code: "task_aborted",
					success: false,
				})
			}
			this.clearActiveTaskState()
			return
		}

		this.fatalStreamError = error
		this.options.jsonEmitter.emitControl({
			subtype: "error",
			requestId: this.activeRequestId,
			command: this.activeTaskCommand,
			taskId: this.latestTaskId,
			content: error.message,
			code: "client_error",
			success: false,
		})
	}

	handleRuntimeMessage(message: {
		type?: string
		text?: unknown
		state?: {
			currentTaskId?: unknown
			currentTaskItem?: { id?: unknown }
			messageQueue?: unknown
		}
	}): void {
		if (message.type === "commandExecutionStatus") {
			if (typeof message.text !== "string") {
				return
			}

			let parsedStatus: unknown
			try {
				parsedStatus = JSON.parse(message.text)
			} catch {
				return
			}

			if (!isRecord(parsedStatus) || typeof parsedStatus.status !== "string") {
				return
			}

			if (parsedStatus.status === "output" && typeof parsedStatus.output === "string") {
				this.options.jsonEmitter.emitCommandOutputChunk(parsedStatus.output)
				return
			}

			if (parsedStatus.status === "exited") {
				const exitCode =
					parsedStatus.status === "exited" && typeof parsedStatus.exitCode === "number"
						? parsedStatus.exitCode
						: undefined

				if (typeof parsedStatus.output === "string") {
					this.options.jsonEmitter.emitCommandOutputChunk(parsedStatus.output)
				}

				this.options.jsonEmitter.markCommandOutputExited(exitCode)
				return
			}

			if (parsedStatus.status === "timeout" || parsedStatus.status === "fallback") {
				this.options.jsonEmitter.emitCommandOutputDone(undefined)
			}

			return
		}

		if (message.type !== "state") {
			return
		}

		const currentTaskId = message.state?.currentTaskId ?? message.state?.currentTaskItem?.id
		if (typeof currentTaskId === "string" && currentTaskId.trim().length > 0) {
			this.latestTaskId = currentTaskId
		}

		// Detect ask transitions — emit approval_request when a new ask arrives
		this.detectAskTransition()

		const queueSnapshot = parseQueueSnapshot(message.state?.messageQueue)
		if (!queueSnapshot) {
			return
		}

		const queueDepth = queueSnapshot.length
		const queueMessageIds = queueSnapshot.map((item) => item.id)

		if (!this.hasSeenQueueState) {
			this.assignRequestIdsToNewQueueMessages(queueMessageIds)
			this.hasSeenQueueState = true
			this.lastQueueDepth = queueDepth
			this.lastQueueMessageIds = queueMessageIds

			if (queueDepth === 0) {
				return
			}

			this.options.jsonEmitter.emitQueue({
				subtype: "snapshot",
				taskId: this.latestTaskId,
				content: `queue snapshot (${queueDepth} item${queueDepth === 1 ? "" : "s"})`,
				queueDepth,
				queue: queueSnapshot,
			})
			return
		}

		const depthChanged = queueDepth !== this.lastQueueDepth
		const idsChanged = !areStringArraysEqual(queueMessageIds, this.lastQueueMessageIds)

		if (!depthChanged && !idsChanged) {
			return
		}

		this.promoteRequestIdForDequeuedMessages(queueMessageIds)
		this.assignRequestIdsToNewQueueMessages(queueMessageIds)

		const subtype: "enqueued" | "dequeued" | "drained" | "updated" = depthChanged
			? queueDepth > this.lastQueueDepth
				? "enqueued"
				: queueDepth === 0
					? "drained"
					: "dequeued"
			: "updated"

		const content =
			subtype === "drained"
				? "queue drained"
				: `queue ${subtype} (${queueDepth} item${queueDepth === 1 ? "" : "s"})`

		this.options.jsonEmitter.emitQueue({
			subtype,
			taskId: this.latestTaskId,
			content,
			queueDepth,
			queue: queueSnapshot,
		})

		this.lastQueueDepth = queueDepth
		this.lastQueueMessageIds = queueMessageIds
	}

	handleTaskCompleted(event: TaskCompletedEvent): void {
		if (this.activeTaskCommand !== "start") {
			return
		}

		const completionCode = event.success
			? "task_completed"
			: this.cancelRequestedForActiveTask
				? "task_aborted"
				: "task_failed"

		this.options.jsonEmitter.emitControl({
			subtype: "done",
			requestId: this.activeRequestId,
			command: "start",
			taskId: this.latestTaskId,
			content: event.success
				? "task completed"
				: this.cancelRequestedForActiveTask
					? "task cancelled"
					: "task failed",
			code: completionCode,
			success: event.success,
		})

		const oldestQueuedMessageId = this.lastQueueMessageIds[0]
		const nextQueuedRequestId =
			this.pendingQueuedMessageRequestIds[0] ??
			(oldestQueuedMessageId ? this.queueMessageRequestIdByMessageId.get(oldestQueuedMessageId) : undefined)
		if (nextQueuedRequestId) {
			this.options.setStreamRequestId(nextQueuedRequestId)
		}

		this.activeTaskCommand = undefined
		this.activeRequestId = undefined
		this.cancelRequestedForActiveTask = false
	}

	async handleStartCommand(stdinCommand: RooCliStartCommand): Promise<void> {
		if (this.activeTaskPromise && !this.options.sessionController.hasActiveTask()) {
			await this.waitForPreviousTaskToSettle()
		}

		if (this.activeTaskPromise || this.options.sessionController.hasActiveTask()) {
			this.options.jsonEmitter.emitControl({
				subtype: "error",
				requestId: stdinCommand.requestId,
				command: "start",
				taskId: this.latestTaskId,
				content: "cannot start a new task while another task is active",
				code: "task_busy",
				success: false,
			})
			return
		}

		this.activeRequestId = stdinCommand.requestId
		this.activeTaskCommand = "start"
		this.options.setStreamRequestId(stdinCommand.requestId)
		this.latestTaskId = stdinCommand.taskId ?? randomUUID()
		this.cancelRequestedForActiveTask = false
		this.awaitingPostCancelRecovery = false

		this.options.jsonEmitter.emitControl({
			subtype: "ack",
			requestId: stdinCommand.requestId,
			command: "start",
			taskId: this.latestTaskId,
			content: "starting task",
			code: "accepted",
			success: true,
		})

		const taskConfiguration = {
			terminalShellIntegrationDisabled: true,
			...(stdinCommand.configuration ?? {}),
		}

		this.activeTaskPromise = this.options.sessionController
			.startTask(stdinCommand.prompt, this.latestTaskId, taskConfiguration, stdinCommand.images)
			.then(() => this.options.sessionController.waitForTaskCompletion())
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error)

				if (
					isExpectedControlFlowError(error, {
						stdinStreamMode: true,
						cancelRequested: this.cancelRequestedForActiveTask,
						shuttingDown: this.options.isShuttingDown(),
						operation: "client",
					})
				) {
					if (
						this.activeTaskCommand === "start" &&
						(this.cancelRequestedForActiveTask || isCancellationLikeError(error))
					) {
						this.options.jsonEmitter.emitControl({
							subtype: "done",
							requestId: stdinCommand.requestId,
							command: "start",
							taskId: this.latestTaskId,
							content: "task cancelled",
							code: "task_aborted",
							success: false,
						})
					}

					this.clearActiveTaskState()
					return
				}

				this.fatalStreamError = error instanceof Error ? error : new Error(message)
				this.activeTaskCommand = undefined
				this.activeRequestId = undefined
				this.options.setStreamRequestId(undefined)

				this.options.jsonEmitter.emitControl({
					subtype: "error",
					requestId: stdinCommand.requestId,
					command: "start",
					taskId: this.latestTaskId,
					content: message,
					code: "task_error",
					success: false,
				})
			})
			.finally(() => {
				this.activeTaskPromise = null
			})
	}

	async handleMessageCommand(stdinCommand: RooCliMessageCommand): Promise<void> {
		if (this.awaitingPostCancelRecovery) {
			await this.waitForPostCancelRecovery()
		}

		const wasResumable = this.isResumableState()
		const currentAsk = this.options.sessionController.getCurrentAsk()
		const shouldSendAsResponse = shouldRouteAsAskResponse(
			this.options.sessionController.isWaitingForInput(),
			currentAsk,
		)

		if (!this.options.sessionController.hasActiveTask()) {
			this.options.jsonEmitter.emitControl({
				subtype: "error",
				requestId: stdinCommand.requestId,
				command: "message",
				taskId: this.latestTaskId,
				content: "no active task; send a start command first",
				code: "no_active_task",
				success: false,
			})
			return
		}

		this.options.jsonEmitter.emitControl({
			subtype: "ack",
			requestId: stdinCommand.requestId,
			command: "message",
			taskId: this.latestTaskId,
			content: "message accepted",
			code: "accepted",
			success: true,
		})

		if (shouldSendAsResponse) {
			// Try implicit resolution via the approval adapter (backward compat).
			// If the adapter has a pending ask, the message resolves it.
			// Otherwise, fall back to direct sendTaskMessage (legacy path).
			const consumed = this.approvalAdapter.resolveAsMessage(stdinCommand.prompt, stdinCommand.images)

			if (!consumed) {
				this.options.sessionController.sendTaskMessage(stdinCommand.prompt, stdinCommand.images)
			}

			this.options.setStreamRequestId(stdinCommand.requestId)
			this.options.jsonEmitter.emitControl({
				subtype: "done",
				requestId: stdinCommand.requestId,
				command: "message",
				taskId: this.latestTaskId,
				content: consumed ? "message resolved pending approval" : "message sent to current ask",
				code: "responded",
				success: true,
			})
			this.awaitingPostCancelRecovery = false
			return
		}

		this.options.sessionController.queueMessage(stdinCommand.prompt, stdinCommand.images)
		this.pendingQueuedMessageRequestIds.push(stdinCommand.requestId)
		if (this.options.sessionController.isWaitingForInput()) {
			this.options.setStreamRequestId(stdinCommand.requestId)
		}

		this.options.jsonEmitter.emitControl({
			subtype: "done",
			requestId: stdinCommand.requestId,
			command: "message",
			taskId: this.latestTaskId,
			content: wasResumable ? "resume message queued" : "message queued",
			code: wasResumable ? "resumed" : "queued",
			success: true,
		})

		this.awaitingPostCancelRecovery = false
	}

	handleCancelCommand(stdinCommand: RooCliCancelCommand): void {
		this.options.setStreamRequestId(stdinCommand.requestId)

		// Dispose the approval adapter (rejects any pending ask promise)
		this.approvalAdapter.dispose()
		this.lastKnownAsk = undefined

		const hasTaskInFlight = Boolean(
			this.activeTaskPromise ||
				this.activeTaskCommand === "start" ||
				this.options.sessionController.hasActiveTask(),
		)

		if (!hasTaskInFlight) {
			this.options.jsonEmitter.emitControl({
				subtype: "ack",
				requestId: stdinCommand.requestId,
				command: "cancel",
				taskId: this.latestTaskId,
				content: "no active task to cancel",
				code: "accepted",
				success: true,
			})
			this.options.jsonEmitter.emitControl({
				subtype: "done",
				requestId: stdinCommand.requestId,
				command: "cancel",
				taskId: this.latestTaskId,
				content: "cancel ignored (no active task)",
				code: "no_active_task",
				success: true,
			})
			return
		}

		this.cancelRequestedForActiveTask = true
		this.awaitingPostCancelRecovery = true

		this.options.jsonEmitter.emitControl({
			subtype: "ack",
			requestId: stdinCommand.requestId,
			command: "cancel",
			taskId: this.latestTaskId,
			content: this.options.sessionController.hasActiveTask()
				? "cancel requested"
				: "cancel requested (task starting)",
			code: "accepted",
			success: true,
		})

		try {
			this.options.sessionController.cancelTask()
			this.options.jsonEmitter.emitControl({
				subtype: "done",
				requestId: stdinCommand.requestId,
				command: "cancel",
				taskId: this.latestTaskId,
				content: "cancel signal sent",
				code: "cancel_requested",
				success: true,
			})
		} catch (error) {
			if (
				isExpectedControlFlowError(error, {
					stdinStreamMode: true,
					cancelRequested: true,
					shuttingDown: this.options.isShuttingDown(),
					operation: "cancel",
				})
			) {
				const noActiveTask = isNoActiveTaskLikeError(error)
				this.options.jsonEmitter.emitControl({
					subtype: "done",
					requestId: stdinCommand.requestId,
					command: "cancel",
					taskId: this.latestTaskId,
					content: noActiveTask ? "cancel ignored (task already settled)" : "cancel handled",
					code: noActiveTask ? "no_active_task" : "cancel_requested",
					success: true,
				})

				if (noActiveTask) {
					this.awaitingPostCancelRecovery = false
				}

				this.cancelRequestedForActiveTask = false
				return
			}

			const message = error instanceof Error ? error.message : String(error)
			this.options.jsonEmitter.emitControl({
				subtype: "error",
				requestId: stdinCommand.requestId,
				command: "cancel",
				taskId: this.latestTaskId,
				content: message,
				code: "cancel_error",
				success: false,
			})
		}
	}

	async finalizeAfterStdinClosed(hasReceivedStdinCommand: boolean): Promise<void> {
		if (!hasReceivedStdinCommand) {
			throw new Error("no stdin command provided")
		}

		if (this.options.isShuttingDown() && this.options.sessionController.hasActiveTask()) {
			this.options.sessionController.cancelTask()
		}

		if (!this.options.isShuttingDown()) {
			if (this.activeTaskPromise) {
				await this.activeTaskPromise
			} else if (this.options.sessionController.hasActiveTask()) {
				await this.waitForTaskProgressAfterStdinClosed()
			}
		}
	}

	// =========================================================================
	// Explicit approval commands
	// =========================================================================

	handleApproveCommand(stdinCommand: RooCliApproveCommand): void {
		this.approvalAdapter.approve(stdinCommand.requestId)
	}

	handleRejectCommand(stdinCommand: RooCliRejectCommand): void {
		this.approvalAdapter.reject(stdinCommand.requestId)
	}

	handleRespondCommand(stdinCommand: RooCliRespondCommand): void {
		this.approvalAdapter.respond(stdinCommand.requestId, stdinCommand.text)
	}

	// =========================================================================
	// Ask transition detection
	// =========================================================================

	/**
	 * Check if the session controller transitioned to a new ask state.
	 * If so, classify the ask and push it into the approval adapter.
	 * The adapter emits an approval_request event and waits for a response.
	 */
	private detectAskTransition(): void {
		const isWaiting = this.options.sessionController.isWaitingForInput()
		const currentAsk = this.options.sessionController.getCurrentAsk()

		if (!isWaiting || !currentAsk) {
			this.lastKnownAsk = undefined
			return
		}

		// Only act on NEW asks (not repeated state updates for the same ask)
		if (currentAsk === this.lastKnownAsk) {
			return
		}

		this.lastKnownAsk = currentAsk

		// Skip asks that don't need user input (non-blocking, auto-continued)
		const clineMsg = { type: "ask" as const, ask: currentAsk, text: "", ts: Date.now() } as ClineMessage
		const request = classifyAsk(currentAsk, clineMsg)

		if (!request) {
			return
		}

		// Push into the approval adapter — emits approval_request event
		// and waits for explicit approve/reject/respond or implicit message.
		// The response is dispatched to the session controller.
		this.approvalAdapter.handle(request).then(
			(response) => {
				sendApprovalResponse(
					{
						approve: () => this.options.sessionController.approve(),
						reject: () => this.options.sessionController.reject(),
						sendTaskMessage: (text, images) => this.options.sessionController.sendTaskMessage(text, images),
					},
					response,
				)
			},
			() => {
				// Disposed/cancelled — no response needed
			},
		)
	}

	private isResumableState(): boolean {
		const agentState = this.options.sessionController.getAgentState()
		return (
			agentState.isWaitingForInput &&
			typeof agentState.currentAsk === "string" &&
			RESUME_ASKS.has(agentState.currentAsk)
		)
	}

	private assignRequestIdsToNewQueueMessages(queueMessageIds: string[]): void {
		for (const messageId of queueMessageIds) {
			if (this.queueMessageRequestIdByMessageId.has(messageId)) {
				continue
			}

			const requestId = this.pendingQueuedMessageRequestIds.shift()
			if (!requestId) {
				continue
			}

			this.queueMessageRequestIdByMessageId.set(messageId, requestId)
		}
	}

	private promoteRequestIdForDequeuedMessages(queueMessageIds: string[]): void {
		if (this.lastQueueMessageIds.length === 0) {
			return
		}

		const remainingIds = new Set(queueMessageIds)

		for (const dequeuedMessageId of this.lastQueueMessageIds) {
			if (remainingIds.has(dequeuedMessageId)) {
				continue
			}

			const requestId = this.queueMessageRequestIdByMessageId.get(dequeuedMessageId)
			if (requestId) {
				this.options.setStreamRequestId(requestId)
			}
			this.queueMessageRequestIdByMessageId.delete(dequeuedMessageId)
		}
	}

	private async waitForPreviousTaskToSettle(): Promise<void> {
		if (!this.activeTaskPromise) {
			return
		}

		try {
			await this.activeTaskPromise
		} catch {
			// Errors are emitted through control/error events.
		}
	}

	private async waitForPostCancelRecovery(): Promise<void> {
		const deadline = Date.now() + CANCEL_RECOVERY_WAIT_TIMEOUT_MS

		while (Date.now() < deadline) {
			if (this.isResumableState()) {
				return
			}

			await new Promise((resolve) => setTimeout(resolve, CANCEL_RECOVERY_POLL_INTERVAL_MS))
		}
	}

	private async waitForTaskProgressAfterStdinClosed(): Promise<void> {
		while (this.options.sessionController.hasActiveTask()) {
			if (!this.options.sessionController.isWaitingForInput()) {
				await new Promise((resolve) => setTimeout(resolve, STDIN_EOF_POLL_INTERVAL_MS))
				continue
			}

			const deadline = Date.now() + STDIN_EOF_RESUME_WAIT_TIMEOUT_MS

			while (Date.now() < deadline) {
				if (
					!this.options.sessionController.hasActiveTask() ||
					!this.options.sessionController.isWaitingForInput()
				) {
					break
				}

				await new Promise((resolve) => setTimeout(resolve, STDIN_EOF_POLL_INTERVAL_MS))
			}

			if (this.options.sessionController.hasActiveTask() && this.options.sessionController.isWaitingForInput()) {
				const currentAsk = this.options.sessionController.getCurrentAsk()

				if (
					this.hasSeenQueueState &&
					this.lastQueueDepth === 0 &&
					typeof currentAsk === "string" &&
					STDIN_EOF_IDLE_ASKS.has(currentAsk)
				) {
					let isStable = true
					for (let i = 1; i < STDIN_EOF_IDLE_STABLE_POLLS; i++) {
						await new Promise((resolve) => setTimeout(resolve, STDIN_EOF_POLL_INTERVAL_MS))

						if (
							!this.options.sessionController.hasActiveTask() ||
							!this.options.sessionController.isWaitingForInput()
						) {
							isStable = false
							break
						}

						const nextAsk = this.options.sessionController.getCurrentAsk()
						if (nextAsk !== currentAsk || !this.hasSeenQueueState || this.lastQueueDepth !== 0) {
							isStable = false
							break
						}
					}

					if (isStable) {
						return
					}
				}

				throw new Error(`stdin ended while task was waiting for input (${currentAsk ?? "unknown"})`)
			}
		}
	}

	private clearActiveTaskState(): void {
		this.activeTaskCommand = undefined
		this.activeRequestId = undefined
		this.options.setStreamRequestId(undefined)
		this.cancelRequestedForActiveTask = false
		this.awaitingPostCancelRecovery = false
	}
}
