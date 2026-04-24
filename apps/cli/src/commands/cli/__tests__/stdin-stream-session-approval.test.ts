/**
 * Integration tests for StdinStreamSession approval adapter wiring.
 *
 * Focuses on detectAskTransition — verifying that:
 * - Consecutive same-type asks (e.g., tool → approve → tool) are each detected
 * - The real message payload is passed through to classifyAsk and the adapter
 * - The approval_request event contains enough content for an orchestrator
 */

import type { ClineAsk, ClineMessage } from "@roo-code/types"

import { AgentLoopState, type AgentStateInfo } from "@/agent/agent-state.js"
import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"
import type { CliSessionController } from "@/runtime/index.js"

import { StdinStreamSession } from "../stdin-stream-session.js"

// =============================================================================
// Helpers
// =============================================================================

function makeMockEmitter() {
	const events: Array<Record<string, unknown>> = []
	return {
		emitter: {
			emitRawEvent: vi.fn((event: Record<string, unknown>) => events.push(event)),
			emitControl: vi.fn(),
			emitQueue: vi.fn(),
			emitCommandOutputChunk: vi.fn(),
			emitCommandOutputDone: vi.fn(),
			markCommandOutputExited: vi.fn(),
		} as unknown as JsonEventEmitter,
		events,
	}
}

function makeAskMessage(ask: ClineAsk, text: string, ts: number): ClineMessage {
	return { type: "ask", ask, text, ts } as ClineMessage
}

function makeAgentState(overrides: Partial<AgentStateInfo> = {}): AgentStateInfo {
	return {
		state: AgentLoopState.WAITING_FOR_INPUT,
		isWaitingForInput: false,
		isRunning: false,
		isStreaming: false,
		requiredAction: "none",
		description: "test",
		...overrides,
	}
}

function makeMockSessionController(initialState: AgentStateInfo) {
	let agentState = initialState
	return {
		controller: {
			getAgentState: vi.fn(() => agentState),
			isWaitingForInput: vi.fn(() => agentState.isWaitingForInput),
			getCurrentAsk: vi.fn(() => agentState.currentAsk),
			hasActiveTask: vi.fn(() => true),
			approve: vi.fn(),
			reject: vi.fn(),
			sendTaskMessage: vi.fn(),
			cancelTask: vi.fn(),
			queueMessage: vi.fn(),
			onMessage: vi.fn(() => () => {}),
			onTaskCompleted: vi.fn(() => () => {}),
			onError: vi.fn(() => () => {}),
		} as unknown as CliSessionController,
		setAgentState: (s: AgentStateInfo) => {
			agentState = s
		},
	}
}

function createSession(controller: CliSessionController, emitter: JsonEventEmitter): StdinStreamSession {
	return new StdinStreamSession({
		sessionController: controller,
		jsonEmitter: emitter,
		setStreamRequestId: vi.fn(),
		isShuttingDown: () => false,
	})
}

// Simulate a state message arriving — this triggers detectAskTransition
function sendStateMessage(session: StdinStreamSession): void {
	session.handleRuntimeMessage({ type: "state", state: {} })
}

// =============================================================================
// Tests
// =============================================================================

describe("StdinStreamSession — detectAskTransition", () => {
	it("emits approval_request when a new ask arrives", () => {
		const { emitter, events } = makeMockEmitter()
		const toolMsg = makeAskMessage("tool", '{"tool":"read_file","path":"/src/main.ts"}', 1001)
		const { controller } = makeMockSessionController(
			makeAgentState({ isWaitingForInput: true, currentAsk: "tool", lastMessageTs: 1001, lastMessage: toolMsg }),
		)
		const session = createSession(controller, emitter)

		sendStateMessage(session)

		// Should have emitted one approval_request
		const approvalEvents = events.filter((e) => e.subtype === "approval_request")
		expect(approvalEvents).toHaveLength(1)
		expect(approvalEvents[0]!.code).toBe("tool")
		// Content should include the real tool name from the payload
		expect(approvalEvents[0]!.content).toContain("read_file")
	})

	it("does NOT re-emit for the same ask message (same ts)", () => {
		const { emitter, events } = makeMockEmitter()
		const toolMsg = makeAskMessage("tool", '{"tool":"read_file"}', 2001)
		const { controller } = makeMockSessionController(
			makeAgentState({ isWaitingForInput: true, currentAsk: "tool", lastMessageTs: 2001, lastMessage: toolMsg }),
		)
		const session = createSession(controller, emitter)

		sendStateMessage(session)
		sendStateMessage(session)
		sendStateMessage(session)

		const approvalEvents = events.filter((e) => e.subtype === "approval_request")
		expect(approvalEvents).toHaveLength(1)
	})

	it("detects consecutive same-type asks with different timestamps", async () => {
		const { emitter, events } = makeMockEmitter()

		const firstToolMsg = makeAskMessage("tool", '{"tool":"read_file","path":"a.ts"}', 3001)
		const { controller, setAgentState } = makeMockSessionController(
			makeAgentState({
				isWaitingForInput: true,
				currentAsk: "tool",
				lastMessageTs: 3001,
				lastMessage: firstToolMsg,
			}),
		)
		const session = createSession(controller, emitter)

		// First tool ask
		sendStateMessage(session)

		let approvalEvents = events.filter((e) => e.subtype === "approval_request")
		expect(approvalEvents).toHaveLength(1)
		expect(approvalEvents[0]!.content).toContain("read_file")

		// Approve the first ask
		session.approvalAdapter.approve("req-1")

		// Second tool ask — same type, different ts and payload
		const secondToolMsg = makeAskMessage("tool", '{"tool":"write_to_file","path":"b.ts"}', 3002)
		setAgentState(
			makeAgentState({
				isWaitingForInput: true,
				currentAsk: "tool",
				lastMessageTs: 3002,
				lastMessage: secondToolMsg,
			}),
		)

		sendStateMessage(session)

		approvalEvents = events.filter((e) => e.subtype === "approval_request")
		expect(approvalEvents).toHaveLength(2)
		// Second event should have the new payload
		expect(approvalEvents[1]!.content).toContain("write_to_file")
	})

	it("passes the real message text to the approval_request content", () => {
		const { emitter, events } = makeMockEmitter()
		const cmdMsg = makeAskMessage("command", "rm -rf /tmp/test", 4001)
		const { controller } = makeMockSessionController(
			makeAgentState({
				isWaitingForInput: true,
				currentAsk: "command",
				lastMessageTs: 4001,
				lastMessage: cmdMsg,
			}),
		)
		const session = createSession(controller, emitter)

		sendStateMessage(session)

		const approvalEvents = events.filter((e) => e.subtype === "approval_request")
		expect(approvalEvents).toHaveLength(1)
		expect(approvalEvents[0]!.content).toContain("rm -rf /tmp/test")
	})

	it("clears tracking when ask state clears (not waiting)", () => {
		const { emitter, events } = makeMockEmitter()
		const toolMsg = makeAskMessage("tool", '{"tool":"read_file"}', 5001)
		const { controller, setAgentState } = makeMockSessionController(
			makeAgentState({
				isWaitingForInput: true,
				currentAsk: "tool",
				lastMessageTs: 5001,
				lastMessage: toolMsg,
			}),
		)
		const session = createSession(controller, emitter)

		sendStateMessage(session)
		expect(events.filter((e) => e.subtype === "approval_request")).toHaveLength(1)

		// Agent processes, clears waiting state
		setAgentState(makeAgentState({ isWaitingForInput: false }))
		sendStateMessage(session)

		// Same ts comes back (agent loops back to same ask after internal state change)
		setAgentState(
			makeAgentState({
				isWaitingForInput: true,
				currentAsk: "tool",
				lastMessageTs: 5001,
				lastMessage: toolMsg,
			}),
		)
		sendStateMessage(session)

		// Should NOT re-emit since ts hasn't changed
		expect(events.filter((e) => e.subtype === "approval_request")).toHaveLength(1)
	})

	it("handles tool → approve → tool → approve sequence end-to-end", async () => {
		const { emitter, events } = makeMockEmitter()

		const { controller, setAgentState } = makeMockSessionController(makeAgentState())
		const session = createSession(controller, emitter)

		// --- First tool ask ---
		const tool1 = makeAskMessage("tool", '{"tool":"execute_command","command":"ls"}', 6001)
		setAgentState(
			makeAgentState({ isWaitingForInput: true, currentAsk: "tool", lastMessageTs: 6001, lastMessage: tool1 }),
		)
		sendStateMessage(session)

		expect(session.approvalAdapter.hasPending).toBe(true)
		expect(session.approvalAdapter.currentRequest?.ask).toBe("tool")

		// Approve
		session.approvalAdapter.approve("req-a")
		expect(session.approvalAdapter.hasPending).toBe(false)

		// Verify the approve dispatched (async via .then microtask)
		const mockController = controller as unknown as { approve: ReturnType<typeof vi.fn> }
		expect(mockController.approve).toHaveBeenCalledTimes(0)
		await new Promise((r) => setTimeout(r, 0)) // flush microtasks
		expect(mockController.approve).toHaveBeenCalledTimes(1)

		// --- Second tool ask ---
		const tool2 = makeAskMessage("tool", '{"tool":"read_file","path":"README.md"}', 6002)
		setAgentState(
			makeAgentState({ isWaitingForInput: true, currentAsk: "tool", lastMessageTs: 6002, lastMessage: tool2 }),
		)
		sendStateMessage(session)

		expect(session.approvalAdapter.hasPending).toBe(true)

		// Approve again
		session.approvalAdapter.approve("req-b")
		await new Promise((r) => setTimeout(r, 0))
		expect(mockController.approve).toHaveBeenCalledTimes(2)

		// Both approval_request events emitted with correct payloads
		const approvals = events.filter((e) => e.subtype === "approval_request")
		expect(approvals).toHaveLength(2)
		expect(approvals[0]!.content).toContain("execute_command")
		expect(approvals[1]!.content).toContain("read_file")
	})
})
