/**
 * Tests that RooHandler merges the abort signal with custom headers and
 * forwards both to the underlying OpenAI SDK create() call.
 *
 * RooHandler fully overrides createMessage() to add X-Roo-* headers.
 * This test proves that metadata.signal is included in the requestOptions
 * alongside those headers.
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
		// RooHandler sets apiKey on the client instance
		apiKey: "test",
	})),
}))

// Mock cloud service so constructor doesn't throw
vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: () => false,
		instance: undefined,
	},
}))

// Mock model cache so constructor doesn't fail loading models
vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	getModelsFromCache: vi.fn().mockReturnValue(null),
}))

import { RooHandler } from "../roo"

function makeEmptyStream() {
	return {
		[Symbol.asyncIterator]: () => ({
			next: vi.fn().mockResolvedValueOnce({ done: true }),
		}),
	}
}

describe("RooHandler abort signal propagation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("merges signal with X-Roo headers into requestOptions", async () => {
		mockCreate.mockReturnValueOnce(makeEmptyStream())

		const handler = new RooHandler({
			rooApiKey: "test-session-token",
			apiModelId: "test-model",
		})

		const taskController = new AbortController()
		const stream = handler.createMessage("system", [], {
			taskId: "roo-task-1",
			signal: taskController.signal,
		})

		for await (const _ of stream) {
			// noop
		}

		expect(mockCreate).toHaveBeenCalledTimes(1)
		const [, requestOptions] = mockCreate.mock.calls[0]

		// Signal must be present
		expect(requestOptions).toBeDefined()
		expect(requestOptions.signal).toBe(taskController.signal)

		// Custom headers must also be present
		expect(requestOptions.headers).toBeDefined()
		expect(requestOptions.headers["X-Roo-Task-ID"]).toBe("roo-task-1")
		expect(requestOptions.headers["X-Roo-App-Version"]).toBeDefined()
	})

	it("includes headers but no signal when metadata has no signal", async () => {
		mockCreate.mockReturnValueOnce(makeEmptyStream())

		const handler = new RooHandler({
			rooApiKey: "test-session-token",
			apiModelId: "test-model",
		})

		const stream = handler.createMessage("system", [], {
			taskId: "roo-task-nosignal",
		})

		for await (const _ of stream) {
			// noop
		}

		expect(mockCreate).toHaveBeenCalledTimes(1)
		const [, requestOptions] = mockCreate.mock.calls[0]

		expect(requestOptions).toBeDefined()
		expect(requestOptions.headers).toBeDefined()
		expect(requestOptions.headers["X-Roo-Task-ID"]).toBe("roo-task-nosignal")
		// No signal should be set
		expect(requestOptions).not.toHaveProperty("signal")
	})
})
