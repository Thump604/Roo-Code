/**
 * Tests that OpenAICompatibleHandler passes metadata.signal as abortSignal
 * to the AI SDK's streamText call.
 *
 * This test mocks streamText and verifies the actual argument object,
 * not just the construction logic.
 */

const { mockStreamText } = vi.hoisted(() => ({
	mockStreamText: vi.fn(),
}))

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>()
	return {
		...actual,
		streamText: mockStreamText,
	}
})

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => {
		return vi.fn(() => ({
			modelId: "test-compat-model",
			provider: "test-compat",
		}))
	}),
}))

import type { ModelInfo } from "@roo-code/types"

import { OpenAICompatibleHandler } from "../openai-compatible"
import type { OpenAICompatibleConfig } from "../openai-compatible"
import type { ApiHandlerOptions } from "../../../shared/api"

// Concrete subclass for testing
class TestCompatHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions, config: OpenAICompatibleConfig) {
		super(options, config)
	}

	override getModel() {
		return {
			id: this.config.modelId,
			info: this.config.modelInfo,
			maxTokens: this.config.modelInfo.maxTokens ?? undefined,
			temperature: this.config.temperature,
		}
	}
}

const testModelInfo: ModelInfo = {
	maxTokens: 4096,
	contextWindow: 128000,
	supportsImages: false,
	supportsPromptCache: false,
}

function makeStreamResult() {
	// Minimal mock that provides an async iterable fullStream and usage
	return {
		fullStream: {
			[Symbol.asyncIterator]: () => ({
				next: vi.fn().mockResolvedValueOnce({ done: true }),
			}),
		},
		usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
	}
}

describe("OpenAICompatibleHandler abort signal propagation", () => {
	let handler: TestCompatHandler

	beforeEach(() => {
		vi.clearAllMocks()

		handler = new TestCompatHandler(
			{ apiKey: "test-key" },
			{
				providerName: "test-compat",
				baseURL: "https://test.local/v1",
				apiKey: "test-key",
				modelId: "test-compat-model",
				modelInfo: testModelInfo,
			},
		)
	})

	it("passes metadata.signal as abortSignal to streamText", async () => {
		mockStreamText.mockReturnValueOnce(makeStreamResult())

		const taskController = new AbortController()
		const stream = handler.createMessage("system prompt", [], {
			taskId: "compat-task-1",
			signal: taskController.signal,
		})

		for await (const _ of stream) {
			// noop
		}

		expect(mockStreamText).toHaveBeenCalledTimes(1)
		const callArgs = mockStreamText.mock.calls[0][0]
		expect(callArgs.abortSignal).toBe(taskController.signal)
	})

	it("passes undefined abortSignal when metadata has no signal", async () => {
		mockStreamText.mockReturnValueOnce(makeStreamResult())

		const stream = handler.createMessage("system prompt", [], {
			taskId: "compat-task-nosignal",
		})

		for await (const _ of stream) {
			// noop
		}

		expect(mockStreamText).toHaveBeenCalledTimes(1)
		const callArgs = mockStreamText.mock.calls[0][0]
		expect(callArgs.abortSignal).toBeUndefined()
	})

	it("already-aborted signal is passed through to streamText", async () => {
		mockStreamText.mockReturnValueOnce(makeStreamResult())

		const taskController = new AbortController()
		taskController.abort() // abort before call

		const stream = handler.createMessage("system prompt", [], {
			taskId: "compat-task-pre-aborted",
			signal: taskController.signal,
		})

		for await (const _ of stream) {
			// noop
		}

		expect(mockStreamText).toHaveBeenCalledTimes(1)
		const callArgs = mockStreamText.mock.calls[0][0]
		expect(callArgs.abortSignal).toBe(taskController.signal)
		expect(callArgs.abortSignal.aborted).toBe(true)
	})
})
