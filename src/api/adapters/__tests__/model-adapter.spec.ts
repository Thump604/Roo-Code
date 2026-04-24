/**
 * Behavior-preserving tests for the ModelAdapter boundary.
 *
 * Verifies that:
 * - Factory selects the right adapter for each provider
 * - OpenAI-compatible adapter converts images, extracts reasoning, strips tags
 * - Passthrough adapter does not convert or strip
 * - Capability flags are correct
 */

import { createModelAdapter, modelEmitsThinkTags, type ImageBlock, type ModelAdapter } from "../model-adapter"

// =============================================================================
// Factory
// =============================================================================

describe("createModelAdapter", () => {
	it.each(["openai", "openai-native", "openai-compatible", "vllm-mlx"])(
		"returns openai-compatible for %s",
		(provider) => {
			const adapter = createModelAdapter(provider)
			expect(adapter.name).toBe("openai-compatible")
		},
	)

	it("returns passthrough for openrouter (aggregator — adapter is per-request)", () => {
		const adapter = createModelAdapter("openrouter")
		expect(adapter.name).toBe("passthrough")
	})

	it.each(["anthropic", "bedrock", "gemini", "unknown"])("returns passthrough for %s", (provider) => {
		const adapter = createModelAdapter(provider)
		expect(adapter.name).toBe("passthrough")
	})
})

// =============================================================================
// modelEmitsThinkTags — model family detection
// =============================================================================

describe("modelEmitsThinkTags", () => {
	it.each([
		"deepseek/deepseek-r1",
		"deepseek/deepseek-r1-0528",
		"deepseek/deepseek-reasoner",
		"qwen/qwq-32b",
		"anthropic/claude-3.7-sonnet:thinking",
		"some-provider/model-name-thinking",
	])("returns true for reasoning model %s", (modelId) => {
		expect(modelEmitsThinkTags(modelId)).toBe(true)
	})

	it.each([
		"anthropic/claude-sonnet-4",
		"google/gemini-2.5-pro",
		"openai/gpt-4o",
		"openai/o1",
		"deepseek/deepseek-chat",
		"deepseek/deepseek-coder",
		"qwen/qwen-2.5-coder-32b",
		"qwen/qwen-2.5-72b-instruct",
		"meta-llama/llama-3.1-70b-instruct",
		"meta-llama/llama-4-maverick",
		"mistralai/mistral-small-latest",
		"mistralai/mistral-large-latest",
	])("returns false for non-reasoning model %s", (modelId) => {
		expect(modelEmitsThinkTags(modelId)).toBe(false)
	})
})

// =============================================================================
// OpenAI-compatible adapter
// =============================================================================

describe("OpenAICompatibleAdapter", () => {
	let adapter: ModelAdapter

	beforeAll(() => {
		adapter = createModelAdapter("openai-compatible")
	})

	describe("capabilities", () => {
		it("supports images", () => {
			expect(adapter.capabilities.supportsImages).toBe(true)
		})

		it("supports tool use", () => {
			expect(adapter.capabilities.supportsToolUse).toBe(true)
		})

		it("supports reasoning", () => {
			expect(adapter.capabilities.supportsReasoning).toBe(true)
		})

		it("does not support reasoning signatures", () => {
			expect(adapter.capabilities.supportsReasoningSignature).toBe(false)
		})
	})

	describe("image conversion", () => {
		it("converts Anthropic image block to OpenAI image_url format", () => {
			const block: ImageBlock = {
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "iVBORw0KGgo=",
				},
			}

			const result = adapter.convertImageBlock(block)
			expect(result).toEqual({
				type: "image_url",
				image_url: {
					url: "data:image/png;base64,iVBORw0KGgo=",
				},
			})
		})
	})

	describe("reasoning extraction", () => {
		it("extracts reasoning_content field (DeepSeek R1 pattern)", () => {
			const chunk = { reasoning_content: "Let me think about this..." }
			const result = adapter.extractReasoning(chunk)
			expect(result).toEqual({ text: "Let me think about this..." })
		})

		it("extracts reasoning field", () => {
			const chunk = { reasoning: "Step 1: analyze the problem" }
			const result = adapter.extractReasoning(chunk)
			expect(result).toEqual({ text: "Step 1: analyze the problem" })
		})

		it("returns null for chunks without reasoning", () => {
			const chunk = { content: "Hello world" }
			expect(adapter.extractReasoning(chunk)).toBeNull()
		})

		it("returns null for empty reasoning", () => {
			const chunk = { reasoning_content: "" }
			expect(adapter.extractReasoning(chunk)).toBeNull()
		})
	})

	describe("reasoning tag stripping", () => {
		it("should strip reasoning tags (local models emit <think> in text)", () => {
			expect(adapter.shouldStripReasoningTags()).toBe(true)
		})
	})
})

// =============================================================================
// Passthrough adapter
// =============================================================================

describe("PassthroughAdapter", () => {
	let adapter: ModelAdapter

	beforeAll(() => {
		adapter = createModelAdapter("unknown-provider")
	})

	it("does not convert images", () => {
		const block: ImageBlock = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "abc" },
		}
		expect(adapter.convertImageBlock(block)).toBeNull()
	})

	it("does not extract reasoning", () => {
		expect(adapter.extractReasoning({ reasoning_content: "text" })).toBeNull()
	})

	it("does not strip reasoning tags", () => {
		expect(adapter.shouldStripReasoningTags()).toBe(false)
	})

	it("has conservative capabilities", () => {
		expect(adapter.capabilities.supportsImages).toBe(false)
		expect(adapter.capabilities.supportsReasoning).toBe(false)
	})
})
