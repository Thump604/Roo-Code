/**
 * TuiApprovalAdapter — bridges the shared ApprovalAdapter contract to React/Ink.
 *
 * When handle() is called:
 * 1. Converts the ApprovalRequest into a PendingAsk for the Zustand store
 * 2. Calls the onPendingAsk callback to update React state
 * 3. Returns a Promise that resolves when the user acts
 *
 * React components resolve the Promise by calling resolve().
 * Cancellation/cleanup rejects the Promise via dispose().
 */

import type { ApprovalAdapter, ApprovalRequest, ApprovalResponse } from "../agent/approval-adapter.js"
import type { PendingAsk } from "./types.js"
import { formatToolAskMessage } from "./utils/tools.js"

export class TuiApprovalAdapter implements ApprovalAdapter {
	private pending: {
		resolve: (response: ApprovalResponse) => void
		reject: (reason?: unknown) => void
	} | null = null

	private readonly onPendingAsk: (ask: PendingAsk | null) => void

	constructor(onPendingAsk: (ask: PendingAsk | null) => void) {
		this.onPendingAsk = onPendingAsk
	}

	get hasPending(): boolean {
		return this.pending !== null
	}

	async handle(request: ApprovalRequest): Promise<ApprovalResponse> {
		// Dispose any stale pending request before starting a new one
		if (this.pending) {
			this.dispose()
		}

		return new Promise<ApprovalResponse>((resolve, reject) => {
			this.pending = { resolve, reject }
			this.onPendingAsk(requestToPendingAsk(request))
		})
	}

	/**
	 * Resolve the pending approval request with the user's response.
	 * Called by React components when the user clicks approve/reject or types text.
	 */
	resolve(response: ApprovalResponse): void {
		if (!this.pending) return
		const { resolve } = this.pending
		this.pending = null
		this.onPendingAsk(null)
		resolve(response)
	}

	/**
	 * Reject any pending approval request. Called on cancellation or cleanup.
	 */
	dispose(): void {
		if (!this.pending) return
		const { reject } = this.pending
		this.pending = null
		this.onPendingAsk(null)
		reject(new Error("TUI approval adapter disposed"))
	}
}

/**
 * Convert an ApprovalRequest to the TUI store's PendingAsk shape.
 * Handles JSON parsing for followup suggestions and tool display formatting.
 */
export function requestToPendingAsk(request: ApprovalRequest): PendingAsk {
	const messageText = request.message.text || ""
	let content = messageText
	let suggestions: PendingAsk["suggestions"]

	if (request.ask === "followup") {
		try {
			const data = JSON.parse(messageText)
			content = data.question || messageText
			suggestions = Array.isArray(data.suggest) ? data.suggest : undefined
		} catch {
			// Use raw text
		}
	} else if (request.ask === "tool") {
		try {
			const toolInfo = JSON.parse(messageText) as Record<string, unknown>
			content = formatToolAskMessage(toolInfo)
		} catch {
			// Use raw text
		}
	}

	return {
		id: request.message.ts.toString(),
		type: request.ask,
		content,
		suggestions,
	}
}
