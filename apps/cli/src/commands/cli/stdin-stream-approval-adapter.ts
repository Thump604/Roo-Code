/**
 * StdinStreamApprovalAdapter — active approval adapter for stdin-stream mode.
 *
 * Replaces the passive message-as-response pattern with an explicit
 * approval request/response lifecycle:
 *
 * 1. When the agent needs user input, handle() emits an approval_request event
 * 2. The orchestrator reads the event and sends an approve/reject/respond command
 * 3. The corresponding method resolves the pending Promise
 * 4. The resolved response is dispatched to the session controller
 *
 * Backward compatibility: the existing message command can still act as an
 * implicit approval response when the adapter has a pending request.
 */

import type { ClineAsk, RooCliCommandName } from "@roo-code/types"

import type {
	ApprovalAdapter,
	ApprovalRequest,
	ApprovalRequestKind,
	ApprovalResponse,
} from "@/agent/approval-adapter.js"
import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"

/** Monotonic counter for stable approval IDs within a session. */
let approvalCounter = 0

export class StdinStreamApprovalAdapter implements ApprovalAdapter {
	private pending: {
		resolve: (response: ApprovalResponse) => void
		reject: (reason?: unknown) => void
		request: ApprovalRequest
		approvalId: string
	} | null = null

	constructor(
		private readonly emitter: JsonEventEmitter,
		private readonly taskIdProvider: () => string | undefined,
	) {}

	get hasPending(): boolean {
		return this.pending !== null
	}

	get currentRequest(): ApprovalRequest | null {
		return this.pending?.request ?? null
	}

	get currentApprovalId(): string | null {
		return this.pending?.approvalId ?? null
	}

	async handle(request: ApprovalRequest): Promise<ApprovalResponse> {
		// Dispose any stale pending request
		if (this.pending) {
			this.dispose()
		}

		const approvalId = `approval-${++approvalCounter}`

		return new Promise<ApprovalResponse>((resolve, reject) => {
			this.pending = { resolve, reject, request, approvalId }
			this.emitApprovalRequest(request, approvalId)
		})
	}

	/**
	 * Resolve with approval (explicit approve command).
	 *
	 * When approvalId is provided, the pending request must match.
	 * When omitted, legacy single-pending behavior is used with a warning.
	 */
	approve(requestId: string, approvalId?: string): void {
		if (!this.validatePending(requestId, "approve", approvalId)) {
			return
		}

		const { resolve } = this.pending!
		this.pending = null
		this.emitApprovalDone(requestId, "approve", "approved")
		resolve({ response: "yesButtonClicked" })
	}

	/**
	 * Resolve with rejection (explicit reject command).
	 */
	reject(requestId: string, approvalId?: string): void {
		if (!this.validatePending(requestId, "reject", approvalId)) {
			return
		}

		const { resolve } = this.pending!
		this.pending = null
		this.emitApprovalDone(requestId, "reject", "rejected")
		resolve({ response: "noButtonClicked" })
	}

	/**
	 * Resolve with a text response (explicit respond command).
	 */
	respond(requestId: string, text: string, approvalId?: string): void {
		if (!this.validatePending(requestId, "respond", approvalId)) {
			return
		}

		const { resolve } = this.pending!
		this.pending = null
		this.emitApprovalDone(requestId, "respond", "responded")
		resolve({ response: "messageResponse", text })
	}

	/**
	 * Implicit approval via legacy message command.
	 * Returns true if the message was consumed as an approval response.
	 */
	resolveAsMessage(text: string, images?: string[]): boolean {
		if (!this.pending) return false

		const { resolve, request } = this.pending
		this.pending = null

		if (request.kind === "respond") {
			resolve({ response: "messageResponse", text, images })
		} else {
			// For non-respond asks, a message acts as approval
			resolve({ response: "yesButtonClicked" })
		}

		return true
	}

	/**
	 * Reject any pending approval request. Called on cancellation or cleanup.
	 */
	dispose(): void {
		if (!this.pending) return
		const { reject } = this.pending
		this.pending = null
		reject(new Error("stdin-stream approval adapter disposed"))
	}

	// =========================================================================
	// Validation
	// =========================================================================

	/**
	 * Validate that a pending approval exists and the approvalId matches (if provided).
	 *
	 * Returns true when the caller may proceed to resolve/reject the pending promise.
	 *
	 * Backward compatibility: when approvalId is omitted, the command resolves the
	 * single pending approval but a "legacy_approval_no_id" warning is emitted so
	 * orchestrators can migrate.
	 */
	private validatePending(requestId: string, command: RooCliCommandName, approvalId?: string): boolean {
		if (!this.pending) {
			this.emitNoApprovalPending(requestId, command)
			return false
		}

		if (approvalId !== undefined && approvalId !== this.pending.approvalId) {
			this.emitApprovalIdMismatch(requestId, command, approvalId, this.pending.approvalId)
			return false
		}

		if (approvalId === undefined) {
			this.emitLegacyApprovalWarning(requestId, command, this.pending.approvalId)
		}

		return true
	}

	// =========================================================================
	// Event emission
	// =========================================================================

	private emitApprovalRequest(request: ApprovalRequest, approvalId: string): void {
		this.emitter.emitRawEvent({
			type: "control",
			subtype: "approval_request",
			approvalId,
			taskId: this.taskIdProvider(),
			content: summarizeApprovalRequest(request),
			payload: request.message.text || undefined,
			code: request.ask,
			command: mapKindToCommand(request.kind),
		})
	}

	private emitApprovalDone(requestId: string, command: RooCliCommandName, code: string): void {
		this.emitter.emitRawEvent({
			type: "control",
			subtype: "done",
			requestId,
			command,
			taskId: this.taskIdProvider(),
			content: `approval ${code}`,
			code,
			success: true,
			done: true,
		})
	}

	private emitNoApprovalPending(requestId: string, command: RooCliCommandName): void {
		this.emitter.emitRawEvent({
			type: "control",
			subtype: "error",
			requestId,
			command,
			taskId: this.taskIdProvider(),
			content: "no approval request pending",
			code: "no_pending_approval",
			success: false,
		})
	}

	private emitApprovalIdMismatch(
		requestId: string,
		command: RooCliCommandName,
		provided: string,
		expected: string,
	): void {
		this.emitter.emitRawEvent({
			type: "control",
			subtype: "error",
			requestId,
			command,
			taskId: this.taskIdProvider(),
			content: `approvalId mismatch: provided "${provided}", expected "${expected}"`,
			code: "approval_id_mismatch",
			success: false,
		})
	}

	private emitLegacyApprovalWarning(requestId: string, command: RooCliCommandName, approvalId: string): void {
		this.emitter.emitRawEvent({
			type: "control",
			subtype: "done",
			requestId,
			command,
			taskId: this.taskIdProvider(),
			content: `legacy approval without approvalId; expected "${approvalId}"`,
			code: "legacy_approval_no_id",
			success: true,
		})
	}
}

/**
 * Map ApprovalRequestKind to the expected stdin command name.
 */
function mapKindToCommand(kind: ApprovalRequestKind): RooCliCommandName {
	switch (kind) {
		case "approve":
			return "approve"
		case "respond":
			return "respond"
		case "retry":
		case "continue":
		case "acknowledge":
			return "approve"
	}
}

/**
 * Human-readable summary of the approval request for the content field.
 */
function summarizeApprovalRequest(request: ApprovalRequest): string {
	const ask = request.ask as ClineAsk
	const text = request.message.text || ""

	switch (ask) {
		case "command":
			return `approve command: ${text.slice(0, 200)}`
		case "tool": {
			try {
				const info = JSON.parse(text)
				return `approve tool: ${info.tool || "unknown"}`
			} catch {
				return "approve tool"
			}
		}
		case "use_mcp_server": {
			try {
				const info = JSON.parse(text)
				return `approve MCP: ${info.serverName || info.server_name || "unknown"}`
			} catch {
				return "approve MCP server"
			}
		}
		case "followup":
			return `respond to question`
		case "api_req_failed":
			return `retry failed API request`
		default:
			return `approve: ${ask}`
	}
}
