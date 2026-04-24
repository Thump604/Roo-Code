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
	it("emits approval_request with approvalId on handle", () => {
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
		expect(events[0]!.approvalId).toBeDefined()
		expect(typeof events[0]!.approvalId).toBe("string")

		adapter.dispose()
	})

	it("emits done on approve", () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		adapter.handle(makeRequest("tool", "approve")).catch(() => {})
		const approvalId = adapter.currentApprovalId!
		adapter.approve("req-abc", approvalId)

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

		adapter.approve("req-orphan", "approval-999")

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: "control",
			subtype: "error",
			code: "no_pending_approval",
			success: false,
		})
	})

	it("includes raw payload in approval_request", () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")
		const fullPayload = '{"tool":"read_file","path":"/src/main.ts","content":"hello world"}'

		adapter.handle(makeRequest("tool", "approve", fullPayload)).catch(() => {})

		expect(events[0]!.payload).toBe(fullPayload)

		adapter.dispose()
	})

	it("uses serverName in MCP summary", () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		adapter.handle(makeRequest("use_mcp_server", "approve", '{"serverName":"my-mcp-server"}')).catch(() => {})

		expect(events[0]!.content).toContain("my-mcp-server")

		adapter.dispose()
	})
})

// =============================================================================
// approvalId enforcement
// =============================================================================

describe("StdinStreamApprovalAdapter — approvalId enforcement", () => {
	it("approve with matching approvalId resolves", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("tool", "approve"))
		const approvalId = adapter.currentApprovalId!

		adapter.approve("req-1", approvalId)
		const result = await promise
		expect(result.response).toBe("yesButtonClicked")
	})

	it("reject with matching approvalId resolves", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("tool", "approve"))
		const approvalId = adapter.currentApprovalId!

		adapter.reject("req-1", approvalId)
		const result = await promise
		expect(result.response).toBe("noButtonClicked")
	})

	it("respond with matching approvalId resolves and preserves text", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("followup", "respond"))
		const approvalId = adapter.currentApprovalId!

		adapter.respond("req-1", "my detailed answer", approvalId)
		const result = await promise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("my detailed answer")
	})

	it("approve with stale/wrong approvalId does NOT resolve pending promise", async () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("tool", "approve"))
		expect(adapter.hasPending).toBe(true)

		adapter.approve("req-1", "approval-wrong")

		// Pending should still be there
		expect(adapter.hasPending).toBe(true)

		// Should have emitted approval_id_mismatch error
		const mismatchEvents = events.filter((e) => e.code === "approval_id_mismatch")
		expect(mismatchEvents).toHaveLength(1)
		expect(mismatchEvents[0]!.subtype).toBe("error")
		expect(mismatchEvents[0]!.success).toBe(false)

		adapter.dispose()
		await expect(promise).rejects.toThrow()
	})

	it("after wrong approvalId, correct approvalId still works", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("tool", "approve"))
		const correctId = adapter.currentApprovalId!

		// Wrong ID — should not resolve
		adapter.approve("req-1", "approval-stale")
		expect(adapter.hasPending).toBe(true)

		// Correct ID — should resolve
		adapter.approve("req-2", correctId)
		expect(adapter.hasPending).toBe(false)

		const result = await promise
		expect(result.response).toBe("yesButtonClicked")
	})

	it("consecutive same-type tool approvals each get distinct approvalIds", async () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		// First approval
		const promise1 = adapter.handle(makeRequest("tool", "approve"))
		const id1 = adapter.currentApprovalId!
		adapter.approve("req-1", id1)
		await promise1

		// Second approval
		const promise2 = adapter.handle(makeRequest("tool", "approve"))
		const id2 = adapter.currentApprovalId!
		adapter.approve("req-2", id2)
		await promise2

		expect(id1).not.toBe(id2)

		// Both approval_request events should have their respective IDs
		const approvalEvents = events.filter((e) => e.subtype === "approval_request")
		expect(approvalEvents).toHaveLength(2)
		expect(approvalEvents[0]!.approvalId).toBe(id1)
		expect(approvalEvents[1]!.approvalId).toBe(id2)
	})

	it("legacy approve without approvalId resolves but emits warning", async () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("tool", "approve"))
		const expectedId = adapter.currentApprovalId!

		// No approvalId — legacy behavior
		adapter.approve("req-1")
		const result = await promise
		expect(result.response).toBe("yesButtonClicked")

		// Should have emitted a legacy warning as ack (not done — not terminal)
		const warningEvents = events.filter((e) => e.code === "legacy_approval_no_id")
		expect(warningEvents).toHaveLength(1)
		expect(warningEvents[0]!.subtype).toBe("ack")
		expect(warningEvents[0]!.done).toBe(false)
		expect(warningEvents[0]!.content).toContain(expectedId)
	})

	it("reject with wrong approvalId does NOT resolve", async () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("tool", "approve"))
		adapter.reject("req-1", "approval-wrong")

		expect(adapter.hasPending).toBe(true)
		expect(events.some((e) => e.code === "approval_id_mismatch")).toBe(true)

		adapter.dispose()
		await expect(promise).rejects.toThrow()
	})

	it("respond with wrong approvalId does NOT resolve", async () => {
		const { emitter, events } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		const promise = adapter.handle(makeRequest("followup", "respond"))
		adapter.respond("req-1", "answer", "approval-wrong")

		expect(adapter.hasPending).toBe(true)
		expect(events.some((e) => e.code === "approval_id_mismatch")).toBe(true)

		adapter.dispose()
		await expect(promise).rejects.toThrow()
	})

	it("stale approval from previous cycle does not approve next prompt", async () => {
		const { emitter } = makeMockEmitter()
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-1")

		// First cycle
		const promise1 = adapter.handle(makeRequest("tool", "approve"))
		const staleId = adapter.currentApprovalId!
		adapter.approve("req-1", staleId)
		await promise1

		// Second cycle — new approval
		const promise2 = adapter.handle(makeRequest("command", "approve"))
		const currentId = adapter.currentApprovalId!

		// Use stale ID from first cycle — should NOT resolve the second
		adapter.approve("req-2", staleId)
		expect(adapter.hasPending).toBe(true)

		// Use current ID — should resolve
		adapter.approve("req-3", currentId)
		const result = await promise2
		expect(result.response).toBe("yesButtonClicked")
	})
})
