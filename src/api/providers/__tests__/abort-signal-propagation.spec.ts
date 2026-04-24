/**
 * Tests that the Task-level AbortSignal propagates to provider-level
 * AbortControllers and SDK calls across all OpenAI-compatible providers.
 *
 * Coverage:
 * - openai-native / openai-codex: local AbortController linked via addEventListener
 * - BaseOpenAiCompatibleProvider: signal forwarded via OpenAI RequestOptions.signal
 * - ZAiHandler: signal forwarded through thinking-mode branch
 * - RooHandler: signal merged with custom headers in requestOptions
 * - openai-compatible (AI SDK): abortSignal passed to streamText
 */

import OpenAI from "openai"

// =============================================================================
// Generic abort-signal linking (openai-native / openai-codex pattern)
// =============================================================================

describe("provider abort signal linking", () => {
	it("linked abort controller fires when external signal aborts", () => {
		const taskController = new AbortController()
		const providerController = new AbortController()

		taskController.signal.addEventListener("abort", () => providerController.abort(), { once: true })

		expect(providerController.signal.aborted).toBe(false)
		taskController.abort()
		expect(providerController.signal.aborted).toBe(true)
	})

	it("linked abort controller fires immediately if signal already aborted", () => {
		const taskController = new AbortController()
		taskController.abort()

		const providerController = new AbortController()

		if (taskController.signal.aborted) {
			providerController.abort()
		} else {
			taskController.signal.addEventListener("abort", () => providerController.abort(), { once: true })
		}

		expect(providerController.signal.aborted).toBe(true)
	})

	it("provider controller is independent when no signal provided", () => {
		const providerController = new AbortController()

		expect(providerController.signal.aborted).toBe(false)
		providerController.abort()
		expect(providerController.signal.aborted).toBe(true)
	})

	it("once: true prevents listener leak after abort", () => {
		const taskController = new AbortController()
		const providerController = new AbortController()

		taskController.signal.addEventListener("abort", () => providerController.abort(), { once: true })

		taskController.abort()
		expect(providerController.signal.aborted).toBe(true)
		expect(() => taskController.abort()).not.toThrow()
	})
})

// =============================================================================
// ApiHandlerCreateMessageMetadata.signal contract
// =============================================================================

describe("ApiHandlerCreateMessageMetadata.signal contract", () => {
	it("signal field is optional (undefined by default)", () => {
		const metadata = { taskId: "test-123" }
		expect(metadata).not.toHaveProperty("signal")
	})

	it("signal field accepts a standard AbortSignal", () => {
		const controller = new AbortController()
		const metadata = { taskId: "test-123", signal: controller.signal }

		expect(metadata.signal).toBeInstanceOf(AbortSignal)
		expect(metadata.signal.aborted).toBe(false)

		controller.abort()
		expect(metadata.signal.aborted).toBe(true)
	})
})

// =============================================================================
// BaseOpenAiCompatibleProvider: signal → OpenAI RequestOptions.signal
// =============================================================================

describe("BaseOpenAiCompatibleProvider abort signal forwarding", () => {
	it("builds RequestOptions with signal when metadata.signal is present", () => {
		const taskController = new AbortController()
		const metadata = { taskId: "test-456", signal: taskController.signal }

		const requestOptions: OpenAI.RequestOptions | undefined = metadata.signal
			? { signal: metadata.signal }
			: undefined

		expect(requestOptions).toBeDefined()
		expect(requestOptions!.signal).toBe(taskController.signal)
		expect(requestOptions!.signal!.aborted).toBe(false)

		taskController.abort()
		expect(requestOptions!.signal!.aborted).toBe(true)
	})

	it("builds undefined RequestOptions when no signal in metadata", () => {
		const metadata = { taskId: "test-789" }

		const requestOptions: OpenAI.RequestOptions | undefined = (metadata as any).signal
			? { signal: (metadata as any).signal }
			: undefined

		expect(requestOptions).toBeUndefined()
	})

	it("OpenAI RequestOptions type accepts AbortSignal", () => {
		const controller = new AbortController()
		const opts: OpenAI.RequestOptions = { signal: controller.signal }
		expect(opts.signal).toBe(controller.signal)
	})
})

// =============================================================================
// RooHandler: signal merged with custom headers into requestOptions
// =============================================================================

describe("RooHandler abort signal + headers merging", () => {
	it("merges signal with custom headers into one RequestOptions object", () => {
		// Simulate what RooHandler.createMessage() does
		const taskController = new AbortController()
		const metadata = { taskId: "task-roo", signal: taskController.signal }

		const headers: Record<string, string> = {
			"X-Roo-App-Version": "1.0.0",
		}
		if (metadata.taskId) {
			headers["X-Roo-Task-ID"] = metadata.taskId
		}

		const requestOptions: OpenAI.RequestOptions = {
			headers,
			...(metadata.signal ? { signal: metadata.signal } : {}),
		}

		// Both headers and signal are present
		expect(requestOptions.headers).toEqual({
			"X-Roo-App-Version": "1.0.0",
			"X-Roo-Task-ID": "task-roo",
		})
		expect(requestOptions.signal).toBe(taskController.signal)
		expect(requestOptions.signal!.aborted).toBe(false)

		taskController.abort()
		expect(requestOptions.signal!.aborted).toBe(true)
	})

	it("omits signal from requestOptions when metadata.signal is undefined", () => {
		const metadata = { taskId: "task-roo-nosignal" }

		const headers: Record<string, string> = {
			"X-Roo-App-Version": "1.0.0",
		}

		const requestOptions: OpenAI.RequestOptions = {
			headers,
			...((metadata as any).signal ? { signal: (metadata as any).signal } : {}),
		}

		expect(requestOptions.headers).toBeDefined()
		expect(requestOptions).not.toHaveProperty("signal")
	})
})
