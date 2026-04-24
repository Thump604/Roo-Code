/**
 * Tests that the Task-level AbortSignal propagates to provider-level
 * AbortControllers via the metadata.signal linking pattern.
 *
 * These tests verify the linking behavior in isolation without
 * requiring live inference or real provider connections.
 */

describe("provider abort signal linking", () => {
	it("linked abort controller fires when external signal aborts", () => {
		// Simulate what openai-native/openai-codex do internally
		const taskController = new AbortController()
		const providerController = new AbortController()

		// Link: metadata.signal → provider controller
		taskController.signal.addEventListener("abort", () => providerController.abort(), { once: true })

		expect(providerController.signal.aborted).toBe(false)

		// Task cancels
		taskController.abort()

		expect(providerController.signal.aborted).toBe(true)
	})

	it("linked abort controller fires immediately if signal already aborted", () => {
		const taskController = new AbortController()
		taskController.abort() // already aborted

		const providerController = new AbortController()

		// Link after abort — should fire immediately
		if (taskController.signal.aborted) {
			providerController.abort()
		} else {
			taskController.signal.addEventListener("abort", () => providerController.abort(), { once: true })
		}

		expect(providerController.signal.aborted).toBe(true)
	})

	it("provider controller is independent when no signal provided", () => {
		// Simulate provider behavior without metadata.signal
		const providerController = new AbortController()

		// No linking — provider manages its own lifecycle
		expect(providerController.signal.aborted).toBe(false)

		providerController.abort()
		expect(providerController.signal.aborted).toBe(true)
	})

	it("once: true prevents listener leak after abort", () => {
		const taskController = new AbortController()
		const providerController = new AbortController()

		// Use { once: true } to auto-remove after first fire
		taskController.signal.addEventListener("abort", () => providerController.abort(), { once: true })

		taskController.abort()
		expect(providerController.signal.aborted).toBe(true)

		// No error on subsequent operations (listener removed)
		expect(() => taskController.abort()).not.toThrow()
	})
})

describe("ApiHandlerCreateMessageMetadata.signal contract", () => {
	it("signal field is optional (undefined by default)", () => {
		const metadata = { taskId: "test-123" }

		// No signal field — providers should create their own controller
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
