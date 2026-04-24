import type { ClineAsk, ClineMessage } from "@roo-code/types"

import type { ApprovalRequest } from "@/agent/approval-adapter.js"
import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"

import { StdinStreamApprovalAdapter } from "../stdin-stream-approval-adapter.js"

function makeRequest(ask: ClineAsk, kind: ApprovalRequest["kind"], text = ""): ApprovalRequest {
	return { kind, ask, message: { type: "ask", ask, text, ts: 1000 } as ClineMessage }
}

function makeMockEmitter() {
	const events: Array<Record<string, unknown>> = []
	return {
		emitter: { emitRawEvent: vi.fn((event) => events.push(event)) } as unknown as JsonEventEmitter,
		events,
	}
}

// =============================================================================
// Promise lifecycle
// =============================================================================

describe("StdinStreamApprovalAdapter", () => {
	it("sets pending state on handle and clears on approve", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		expect(adapter.hasPending).toBe(false)

		const promise = adapter.handle(makeRequest("tool", "approve"))
		expect(adapter.hasPending).toBe(true)

		adapter.approve("req-1")
		expect(adapter.hasPending).toBe(false)

		const result = await promise
		expect(result.response).toBe("yesButtonClicked")
	})

	it("resolves with noButtonClicked on reject", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		const promise = adapter.handle(makeRequest("command", "approve"))
		adapter.reject("req-1")

		const result = await promise
		expect(result.response).toBe("noButtonClicked")
	})

	it("resolves with messageResponse on respond", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		const promise = adapter.handle(makeRequest("followup", "respond"))
		adapter.respond("req-1", "my answer")

		const result = await promise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("my answer")
	})

	it("rejects the promise on dispose", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		const promise = adapter.handle(makeRequest("tool", "approve"))
		adapter.dispose()

		await expect(promise).rejects.toThrow("stdin-stream approval adapter disposed")
		expect(adapter.hasPending).toBe(false)
	})

	it("disposes stale pending on double handle", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		const first = adapter.handle(makeRequest("tool", "approve"))
		const second = adapter.handle(makeRequest("command", "approve"))

		await expect(first).rejects.toThrow("disposed")

		adapter.approve("req-2")
		const result = await second
		expect(result.response).toBe("yesButtonClicked")
	})

	it("exposes the current request", () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		expect(adapter.currentRequest).toBeNull()

		adapter.handle(makeRequest("tool", "approve")).catch(() => {})
		expect(adapter.currentRequest?.ask).toBe("tool")

		adapter.dispose()
		expect(adapter.currentRequest).toBeNull()
	})
})

// =============================================================================
// Implicit message-as-response
// =============================================================================

describe("StdinStreamApprovalAdapter — resolveAsMessage", () => {
	it("returns false when no pending request", () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		expect(adapter.resolveAsMessage("hello")).toBe(false)
	})

	it("resolves respond-kind as messageResponse", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		const promise = adapter.handle(makeRequest("followup", "respond"))
		const consumed = adapter.resolveAsMessage("my text")

		expect(consumed).toBe(true)
		const result = await promise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("my text")
	})

	it("resolves approve-kind as yesButtonClicked", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		const promise = adapter.handle(makeRequest("tool", "approve"))
		const consumed = adapter.resolveAsMessage("anything")

		expect(consumed).toBe(true)
		const result = await promise
		expect(result.response).toBe("yesButtonClicked")
	})
})

// =============================================================================
// Event emission
// =============================================================================

describe("StdinStreamApprovalAdapter — events", () => {
	it("emits approval_request on handle", () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-42")

		adapter.handle(makeRequest("tool", "approve", '{"tool":"read_file"}')).catch(() => {})

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: "control",
			subtype: "approval_request",
			taskId: "task-42",
			code: "tool",
			command: "approve",
		})

		adapter.dispose()
	})

	it("emits done on approve", () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		adapter.handle(makeRequest("tool", "approve")).catch(() => {})
		adapter.approve("req-abc")

		// events: [approval_request, done]
		expect(events).toHaveLength(2)
		expect(events[1]).toMatchObject({
			type: "control",
			subtype: "done",
			requestId: "req-abc",
			command: "approve",
			code: "approved",
			success: true,
		})
	})

	it("emits error when approving without pending", () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => undefined)

		adapter.approve("req-orphan")

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: "control",
			subtype: "error",
			code: "no_pending_approval",
			success: false,
		})
	})
})
