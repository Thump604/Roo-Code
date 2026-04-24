import type { ClineAsk, ClineMessage } from "@roo-code/types"

import type { ApprovalRequest } from "../../agent/approval-adapter.js"
import { TuiApprovalAdapter, requestToPendingAsk } from "../tui-approval-adapter.js"

function makeMessage(ask: ClineAsk, text = ""): ClineMessage {
	return { type: "ask", ask, text, ts: 1000 } as ClineMessage
}

function makeRequest(ask: ClineAsk, kind: ApprovalRequest["kind"], text = ""): ApprovalRequest {
	return { kind, ask, message: makeMessage(ask, text) }
}

// =============================================================================
// TuiApprovalAdapter — promise lifecycle
// =============================================================================

describe("TuiApprovalAdapter", () => {
	it("sets pending state on handle and clears on resolve", async () => {
		const setPendingAsk = vi.fn()
		const adapter = new TuiApprovalAdapter(setPendingAsk)

		expect(adapter.hasPending).toBe(false)

		const promise = adapter.handle(makeRequest("tool", "approve"))

		expect(adapter.hasPending).toBe(true)
		expect(setPendingAsk).toHaveBeenCalledWith(expect.objectContaining({ type: "tool" }))

		adapter.resolve({ response: "yesButtonClicked" })

		expect(adapter.hasPending).toBe(false)
		expect(setPendingAsk).toHaveBeenLastCalledWith(null)

		const result = await promise
		expect(result.response).toBe("yesButtonClicked")
	})

	it("rejects the promise on dispose", async () => {
		const setPendingAsk = vi.fn()
		const adapter = new TuiApprovalAdapter(setPendingAsk)

		const promise = adapter.handle(makeRequest("command", "approve"))

		expect(adapter.hasPending).toBe(true)

		adapter.dispose()

		expect(adapter.hasPending).toBe(false)
		expect(setPendingAsk).toHaveBeenLastCalledWith(null)

		await expect(promise).rejects.toThrow("TUI approval adapter disposed")
	})

	it("resolves with messageResponse for followup asks", async () => {
		const setPendingAsk = vi.fn()
		const adapter = new TuiApprovalAdapter(setPendingAsk)

		const promise = adapter.handle(makeRequest("followup", "respond"))

		adapter.resolve({ response: "messageResponse", text: "my answer" })

		const result = await promise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("my answer")
	})

	it("resolve without pending is a no-op", () => {
		const setPendingAsk = vi.fn()
		const adapter = new TuiApprovalAdapter(setPendingAsk)

		// Should not throw
		adapter.resolve({ response: "yesButtonClicked" })
		expect(setPendingAsk).not.toHaveBeenCalled()
	})

	it("dispose without pending is a no-op", () => {
		const setPendingAsk = vi.fn()
		const adapter = new TuiApprovalAdapter(setPendingAsk)

		// Should not throw
		adapter.dispose()
		expect(setPendingAsk).not.toHaveBeenCalled()
	})

	it("disposes stale pending request on double handle", async () => {
		const setPendingAsk = vi.fn()
		const adapter = new TuiApprovalAdapter(setPendingAsk)

		const firstPromise = adapter.handle(makeRequest("tool", "approve"))
		const secondPromise = adapter.handle(makeRequest("command", "approve"))

		// First should be rejected
		await expect(firstPromise).rejects.toThrow("TUI approval adapter disposed")

		// Second should be pending
		expect(adapter.hasPending).toBe(true)

		adapter.resolve({ response: "noButtonClicked" })

		const result = await secondPromise
		expect(result.response).toBe("noButtonClicked")
	})

	it("reject response propagates through resolve", async () => {
		const setPendingAsk = vi.fn()
		const adapter = new TuiApprovalAdapter(setPendingAsk)

		const promise = adapter.handle(makeRequest("tool", "approve"))

		adapter.resolve({ response: "noButtonClicked" })

		const result = await promise
		expect(result.response).toBe("noButtonClicked")
	})
})

// =============================================================================
// requestToPendingAsk — conversion
// =============================================================================

describe("requestToPendingAsk", () => {
	it("converts a plain approve request", () => {
		const request = makeRequest("command", "approve", "ls -la")
		const pending = requestToPendingAsk(request)

		expect(pending.id).toBe("1000")
		expect(pending.type).toBe("command")
		expect(pending.content).toBe("ls -la")
		expect(pending.suggestions).toBeUndefined()
	})

	it("parses followup JSON with suggestions", () => {
		const json = JSON.stringify({
			question: "Which file?",
			suggest: [{ answer: "file-a.ts" }, { answer: "file-b.ts" }],
		})
		const request = makeRequest("followup", "respond", json)
		const pending = requestToPendingAsk(request)

		expect(pending.type).toBe("followup")
		expect(pending.content).toBe("Which file?")
		expect(pending.suggestions).toHaveLength(2)
		expect(pending.suggestions![0]).toEqual({ answer: "file-a.ts" })
	})

	it("uses raw text when followup JSON is malformed", () => {
		const request = makeRequest("followup", "respond", "plain question text")
		const pending = requestToPendingAsk(request)

		expect(pending.content).toBe("plain question text")
		expect(pending.suggestions).toBeUndefined()
	})

	it("formats tool ask with tool name", () => {
		const json = JSON.stringify({ tool: "read_file", path: "/src/main.ts" })
		const request = makeRequest("tool", "approve", json)
		const pending = requestToPendingAsk(request)

		expect(pending.type).toBe("tool")
		// formatToolAskMessage produces a formatted string
		expect(pending.content).toContain("Read file")
	})

	it("uses raw text when tool JSON is malformed", () => {
		const request = makeRequest("tool", "approve", "not json")
		const pending = requestToPendingAsk(request)

		expect(pending.content).toBe("not json")
	})

	it("passes through other ask types as raw text", () => {
		const request = makeRequest("api_req_failed", "retry", "connection timeout")
		const pending = requestToPendingAsk(request)

		expect(pending.type).toBe("api_req_failed")
		expect(pending.content).toBe("connection timeout")
	})
})
