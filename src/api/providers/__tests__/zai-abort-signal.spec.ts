/**
 * Tests that ZAiHandler forwards the abort signal through the thinking-mode
 * code path to the underlying OpenAI SDK create() call.
 *
 * ZAiHandler overrides createStream() and, for thinking models (GLM-4.7),
 * calls createStreamWithThinking() which builds its own params. This test
 * proves that requestOptions (including signal) survive both branches.
 */

// Create mock before imports so vi.mock hoisting works
const mockCreate = vi.fn()

vi.mock("openai", () => ({
	default: vi.fn(() => ({
		chat: {
			completions: {
				create: mockCreate,
			},
		},
	})),
}))

import type { ModelInfo } from "@roo-code/types"

import { ZAiHandler } from "../zai"

// Build a minimal thinking-capable model info
const thinkingModelInfo: ModelInfo = {
	maxTokens: 4096,
	contextWindow: 128000,
	supportsImages: false,
	supportsPromptCache: false,
	// Array value triggers isThinkingModel branch in ZAiHandler
	supportsReasoningEffort: ["low", "medium", "high"],
}

// Build a non-thinking model info
const plainModelInfo: ModelInfo = {
	maxTokens: 4096,
	contextWindow: 128000,
	supportsImages: false,
	supportsPromptCache: false,
}

function makeEmptyStream() {
	return {
		[Symbol.asyncIterator]: () => ({
			next: vi.fn().mockResolvedValueOnce({ done: true }),
		}),
	}
}

describe("ZAiHandler abort signal propagation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("forwards signal to SDK create() in thinking-mode branch", async () => {
		mockCreate.mockReturnValueOnce(makeEmptyStream())

		// Patch internationalZAiModels so getModel() returns our thinking model
		const handler = new ZAiHandler({
			zaiApiKey: "test-key",
			apiModelId: "test-thinking",
			zaiApiLine: "international_coding",
		})

		// Override getModel to return our thinking-capable model
		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "test-thinking",
			info: thinkingModelInfo,
		})

		const taskController = new AbortController()
		const stream = handler.createMessage("system", [], {
			taskId: "t1",
			signal: taskController.signal,
		})

		// Drain the stream to trigger createStream → createStreamWithThinking
		for await (const _ of stream) {
			// noop
		}

		// mockCreate should have been called with (params, requestOptions)
		expect(mockCreate).toHaveBeenCalledTimes(1)
		const [, requestOptions] = mockCreate.mock.calls[0]

		expect(requestOptions).toBeDefined()
		expect(requestOptions.signal).toBe(taskController.signal)
	})

	it("forwards signal to SDK create() in non-thinking branch", async () => {
		mockCreate.mockReturnValueOnce(makeEmptyStream())

		const handler = new ZAiHandler({
			zaiApiKey: "test-key",
			apiModelId: "test-plain",
			zaiApiLine: "international_coding",
		})

		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "test-plain",
			info: plainModelInfo,
		})

		const taskController = new AbortController()
		const stream = handler.createMessage("system", [], {
			taskId: "t2",
			signal: taskController.signal,
		})

		for await (const _ of stream) {
			// noop
		}

		expect(mockCreate).toHaveBeenCalledTimes(1)
		const [, requestOptions] = mockCreate.mock.calls[0]

		expect(requestOptions).toBeDefined()
		expect(requestOptions.signal).toBe(taskController.signal)
	})

	it("does not include signal when metadata has no signal", async () => {
		mockCreate.mockReturnValueOnce(makeEmptyStream())

		const handler = new ZAiHandler({
			zaiApiKey: "test-key",
			apiModelId: "test-nosignal",
			zaiApiLine: "international_coding",
		})

		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "test-nosignal",
			info: plainModelInfo,
		})

		const stream = handler.createMessage("system", [], { taskId: "t3" })

		for await (const _ of stream) {
			// noop
		}

		expect(mockCreate).toHaveBeenCalledTimes(1)
		const [, requestOptions] = mockCreate.mock.calls[0]

		// No signal in metadata → requestOptions should be undefined
		expect(requestOptions).toBeUndefined()
	})
})
