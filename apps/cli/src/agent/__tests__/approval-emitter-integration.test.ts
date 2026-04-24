/**
 * Integration tests: StdinStreamApprovalAdapter → real JsonEventEmitter
 *
 * These tests verify the full approval event pipeline through the real
 * JsonEventEmitter (not a mock), proving:
 * - approval_request events include requestId after injection
 * - malformed approvalId emits fail-closed error through real emitter
 * - legacy no-approvalId emits ack (non-terminal) then done (terminal)
 * - consecutive same-type approvals preserve distinct approvalIds and payload
 */

import { Writable } from "stream"

import type { ClineAsk, ClineMessage } from "@roo-code/types"

import type { ApprovalRequest } from "@/agent/approval-adapter.js"

import { JsonEventEmitter } from "../json-event-emitter.js"
import { StdinStreamApprovalAdapter } from "@/commands/cli/stdin-stream-approval-adapter.js"

// =============================================================================
// Helpers
// =============================================================================

function createCapturingStdout(): { stdout: NodeJS.WriteStream; events: () => Record<string, unknown>[] } {
	const chunks: string[] = []
	const writable = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk.toString())
			callback()
		},
	}) as unknown as NodeJS.WriteStream

	const events = () =>
		chunks
			.join("")
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>)

	return { stdout: writable, events }
}

function makeRequest(ask: ClineAsk, kind: ApprovalRequest["kind"], text = ""): ApprovalRequest {
	return { kind, ask, message: { type: "ask", ask, text, ts: Date.now() } as ClineMessage }
}

// =============================================================================
// Tests
// =============================================================================

describe("Approval adapter → real JsonEventEmitter integration", () => {
	let activeRequestId: string | undefined

	function createPipeline() {
		const { stdout, events } = createCapturingStdout()
		activeRequestId = "stream-req-1"
		const emitter = new JsonEventEmitter({
			mode: "stream-json",
			stdout,
			requestIdProvider: () => activeRequestId,
		})
		const adapter = new StdinStreamApprovalAdapter(emitter, () => "task-integration")
		return { emitter, adapter, events }
	}

	it("approval_request includes requestId from provider after injection", () => {
		const { adapter, events } = createPipeline()

		adapter.handle(makeRequest("tool", "approve", '{"tool":"read_file"}')).catch(() => {})

		const output = events()
		const approvalReq = output.find((e) => e.subtype === "approval_request")

		expect(approvalReq).toBeDefined()
		expect(approvalReq!.requestId).toBe("stream-req-1")
		expect(approvalReq!.type).toBe("control")
		expect(approvalReq!.subtype).toBe("approval_request")
		expect(approvalReq!.approvalId).toBeDefined()
		expect(approvalReq!.taskId).toBe("task-integration")
		expect(approvalReq!.code).toBe("tool")
		expect(approvalReq!.payload).toBe('{"tool":"read_file"}')

		adapter.dispose()
	})

	it("malformed approvalId emits fail-closed error through real emitter", () => {
		const { adapter, events } = createPipeline()

		adapter.handle(makeRequest("tool", "approve", '{"tool":"write_to_file"}')).catch(() => {})

		// Try to approve with wrong approvalId
		adapter.approve("req-bad", "approval-definitely-wrong")

		const output = events()
		const mismatch = output.find((e) => e.code === "approval_id_mismatch")

		expect(mismatch).toBeDefined()
		expect(mismatch!.type).toBe("control")
		expect(mismatch!.subtype).toBe("error")
		expect(mismatch!.success).toBe(false)
		// The mismatch event carries the command's own requestId, not the provider's
		expect(mismatch!.requestId).toBe("req-bad")
		// Pending should still be held
		expect(adapter.hasPending).toBe(true)

		adapter.dispose()
	})

	it("legacy no-approvalId emits ack (non-terminal) then done (terminal)", async () => {
		const { adapter, events } = createPipeline()

		const promise = adapter.handle(makeRequest("tool", "approve", '{"tool":"read_file"}'))

		// Approve WITHOUT approvalId — legacy path
		adapter.approve("req-legacy")
		await promise

		const output = events()

		// Should have: approval_request, legacy_approval_no_id (ack), done (approved)
		const legacyAck = output.find((e) => e.code === "legacy_approval_no_id")
		const done = output.find((e) => e.subtype === "done" && e.code === "approved")

		expect(legacyAck).toBeDefined()
		expect(legacyAck!.subtype).toBe("ack")
		expect(legacyAck!.done).toBe(false)
		// Legacy ack carries the command's own requestId
		expect(legacyAck!.requestId).toBe("req-legacy")

		expect(done).toBeDefined()
		expect(done!.subtype).toBe("done")
		expect(done!.done).toBe(true)
		expect(done!.success).toBe(true)
		expect(done!.requestId).toBe("req-legacy")
	})

	it("consecutive same-type approvals emit distinct approvalIds and preserve payload through real emitter", async () => {
		const { adapter, events } = createPipeline()

		// First approval cycle
		const p1 = adapter.handle(makeRequest("tool", "approve", '{"tool":"read_file","path":"/a.ts"}'))
		const id1 = adapter.currentApprovalId!
		adapter.approve("req-1", id1)
		await p1

		// Second approval cycle
		const p2 = adapter.handle(makeRequest("tool", "approve", '{"tool":"write_to_file","path":"/b.ts"}'))
		const id2 = adapter.currentApprovalId!
		adapter.approve("req-2", id2)
		await p2

		const output = events()
		const approvalReqs = output.filter((e) => e.subtype === "approval_request")

		expect(approvalReqs).toHaveLength(2)
		expect(approvalReqs[0]!.approvalId).toBe(id1)
		expect(approvalReqs[1]!.approvalId).toBe(id2)
		expect(id1).not.toBe(id2)

		// Payloads preserved
		expect(approvalReqs[0]!.payload).toBe('{"tool":"read_file","path":"/a.ts"}')
		expect(approvalReqs[1]!.payload).toBe('{"tool":"write_to_file","path":"/b.ts"}')

		// Both have requestId from provider
		expect(approvalReqs[0]!.requestId).toBe("stream-req-1")
		expect(approvalReqs[1]!.requestId).toBe("stream-req-1")
	})

	it("done events use the explicit requestId from the approve command, not the provider", async () => {
		const { adapter, events } = createPipeline()

		const promise = adapter.handle(makeRequest("tool", "approve"))
		const approvalId = adapter.currentApprovalId!
		adapter.approve("explicit-req-42", approvalId)
		await promise

		const output = events()
		const done = output.find((e) => e.subtype === "done" && e.code === "approved")

		// The done event should carry the explicit requestId from the approve command
		expect(done!.requestId).toBe("explicit-req-42")
	})

	it("no_pending_approval error is emitted through real emitter", () => {
		const { adapter, events } = createPipeline()

		// Approve without any pending approval
		adapter.approve("req-orphan", "approval-nonexistent")

		const output = events()
		const noPending = output.find((e) => e.code === "no_pending_approval")

		expect(noPending).toBeDefined()
		expect(noPending!.type).toBe("control")
		expect(noPending!.subtype).toBe("error")
		expect(noPending!.success).toBe(false)
	})
})
