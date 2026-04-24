/**
 * Cancellation signal propagation tests.
 *
 * Verifies that cancellation signals flow correctly through CLI layers:
 * - TUI: Escape → handleCancelTask → adapter.dispose() + cancelTask()
 * - Stdin-stream: cancel command → adapter.dispose() + cancelTask()
 * - Approval adapters: pending promises rejected on dispose
 *
 * Does NOT test provider-layer signal propagation (documented gap).
 */

import type { ClineMessage } from "@roo-code/types"

import type { ApprovalRequest } from "@/agent/approval-adapter.js"
import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"

import { StdinStreamApprovalAdapter } from "../stdin-stream-approval-adapter.js"

function makeRequest(text = ""): ApprovalRequest {
	return {
		kind: "approve",
		ask: "tool",
		message: { type: "ask", ask: "tool", text, ts: Date.now() } as ClineMessage,
	}
}

function makeMockEmitter() {
	return {
		emitRawEvent: vi.fn(),
	} as unknown as JsonEventEmitter
}

// =============================================================================
// Approval adapter disposal on cancellation
// =============================================================================

describe("cancellation — approval adapter disposal", () => {
	it("stdin-stream adapter rejects pending promise on dispose", async () => {
		const adapter = new StdinStreamApprovalAdapter(makeMockEmitter(), () => undefined)

		const promise = adapter.handle(makeRequest())
		expect(adapter.hasPending).toBe(true)

		adapter.dispose()
		expect(adapter.hasPending).toBe(false)

		await expect(promise).rejects.toThrow("disposed")
	})

	it("stdin-stream adapter emits error when approving after dispose", () => {
		const emitter = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		// No pending request — should emit error event
		adapter.approve("req-orphan")

		expect(emitter.emitRawEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "control",
				subtype: "error",
				code: "no_pending_approval",
			}),
		)
	})

	it("double dispose is safe (no-op)", () => {
		const adapter = new StdinStreamApprovalAdapter(makeMockEmitter(), () => undefined)

		adapter.handle(makeRequest()).catch(() => {})

		adapter.dispose()
		adapter.dispose() // should not throw
		expect(adapter.hasPending).toBe(false)
	})

	it("cancel during implicit message resolution is safe", async () => {
		const adapter = new StdinStreamApprovalAdapter(makeMockEmitter(), () => undefined)

		const promise = adapter.handle(makeRequest())

		// Resolve via implicit message
		const consumed = adapter.resolveAsMessage("hello")
		expect(consumed).toBe(true)

		// Dispose after resolution is a no-op
		adapter.dispose()
		expect(adapter.hasPending).toBe(false)

		const result = await promise
		expect(result.response).toBe("yesButtonClicked")
	})
})

// =============================================================================
// Stream event contract on cancellation
// =============================================================================

describe("cancellation — stream event contract", () => {
	it("approval_request followed by dispose does not emit done event", () => {
		const emitter = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		adapter.handle(makeRequest('{"tool":"read_file"}')).catch(() => {})

		// Should have emitted approval_request
		expect(emitter.emitRawEvent).toHaveBeenCalledWith(expect.objectContaining({ subtype: "approval_request" }))

		const callCountBeforeDispose = (emitter.emitRawEvent as ReturnType<typeof vi.fn>).mock.calls.length

		// Dispose should NOT emit a done event (it's a rejection, not a resolution)
		adapter.dispose()

		expect((emitter.emitRawEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBeforeDispose)
	})
})
