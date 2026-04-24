/**
 * ModelAdapter — central capability boundary for model-class differences.
 *
 * STATUS: Wired first into BaseOpenAiCompatibleProvider (reasoning extraction
 * and <think> tag stripping). Broader provider migration pending — Anthropic,
 * Gemini, and other provider families should adopt this boundary incrementally.
 *
 * Each model family (OpenAI-compatible, Anthropic, Gemini, DeepSeek R1, etc.)
 * handles reasoning, tool calls, and image transport differently. This interface
 * captures those differences in one place instead of scattering them across
 * provider code.
 *
 * Providers should delegate model-class-specific behavior to their adapter
 * rather than using direct model-ID string matching.
 *
 * Runtime qualification is separate from CLI affordances — the adapter knows
 * what a model class CAN do, not whether a specific model is qualified.
 */

import type Anthropic from "@anthropic-ai/sdk"
import type { ModelInfo } from "@roo-code/types"

// =============================================================================
// Types
// =============================================================================

/** Reasoning content extracted from a stream chunk. */
export interface ExtractedReasoning {
	text: string
	signature?: string
}

/** Image block in provider-neutral form (Anthropic format as baseline). */
export interface ImageBlock {
	type: "image"
	source: {
		type: "base64"
		media_type: string
		data: string
	}
}

/** Image block converted for a specific provider. */
export type ProviderImageBlock =
	| { type: "image_url"; image_url: { url: string } } // OpenAI
	| { inlineData: { data: string; mimeType: string } } // Gemini
	| ImageBlock // Anthropic passthrough

/** Capability flags derived from ModelInfo. */
export interface ModelCapabilities {
	supportsImages: boolean
	supportsToolUse: boolean
	supportsReasoning: boolean
	supportsReasoningSignature: boolean
	supportsStreaming: boolean
}

// =============================================================================
// Interface
// =============================================================================

export interface ModelAdapter {
	/** Human-readable adapter name (e.g., "openai-compatible", "anthropic"). */
	readonly name: string

	/** Capability flags for this model class. */
	readonly capabilities: ModelCapabilities

	/**
	 * Convert an Anthropic-format image block to the provider's format.
	 * Returns null if the model class does not support images.
	 */
	convertImageBlock(block: ImageBlock): ProviderImageBlock | null

	/**
	 * Extract reasoning/thinking content from a raw stream chunk object.
	 * Returns null if the chunk does not contain reasoning content.
	 *
	 * This replaces scattered regex-based tag matching across providers.
	 */
	extractReasoning(chunk: Record<string, unknown>): ExtractedReasoning | null

	/**
	 * Determine whether to strip reasoning tags from visible output.
	 * Some models emit <think>...</think> in their text output;
	 * the adapter knows whether those should be extracted and hidden.
	 */
	shouldStripReasoningTags(): boolean
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ModelAdapter for the given provider and model info.
 *
 * OpenAI-compatible providers (including OpenRouter) use the adapter
 * that strips `<think>` tags and extracts reasoning from dedicated
 * fields. Other model classes return the default passthrough adapter.
 */
export function createModelAdapter(provider: string, _modelInfo?: ModelInfo): ModelAdapter {
	switch (provider) {
		case "openai":
		case "openai-native":
		case "openai-compatible":
		case "openrouter":
		case "vllm-mlx":
			return new OpenAICompatibleAdapter()
		default:
			return new PassthroughAdapter()
	}
}

// =============================================================================
// Implementations
// =============================================================================

/**
 * Adapter for OpenAI-compatible local models (vllm-mlx, llama.cpp, etc.).
 *
 * - Images use OpenAI's `image_url` format with data URIs
 * - Reasoning uses `<think>`/`<thought>` tags in text output (Qwen, DeepSeek)
 * - Tool calls use native OpenAI function-call format
 */
class OpenAICompatibleAdapter implements ModelAdapter {
	readonly name = "openai-compatible"

	readonly capabilities: ModelCapabilities = {
		supportsImages: true,
		supportsToolUse: true,
		supportsReasoning: true,
		supportsReasoningSignature: false, // Local models don't use Anthropic signatures
		supportsStreaming: true,
	}

	convertImageBlock(block: ImageBlock): ProviderImageBlock {
		return {
			type: "image_url",
			image_url: {
				url: `data:${block.source.media_type};base64,${block.source.data}`,
			},
		}
	}

	extractReasoning(chunk: Record<string, unknown>): ExtractedReasoning | null {
		// OpenAI-compatible models may include reasoning in a dedicated field
		// (e.g., DeepSeek R1's reasoning_content) or in <think>/<thought> tags.
		const reasoning = chunk.reasoning_content ?? chunk.reasoning
		if (typeof reasoning === "string" && reasoning.length > 0) {
			return { text: reasoning }
		}
		return null
	}

	shouldStripReasoningTags(): boolean {
		// Local models (Qwen, DeepSeek) often emit <think>...</think> in text.
		// These should be extracted and shown as reasoning, not visible text.
		return true
	}
}

/**
 * Default passthrough adapter — no conversion, no tag stripping.
 * Used for providers that don't yet have a dedicated adapter.
 */
class PassthroughAdapter implements ModelAdapter {
	readonly name = "passthrough"

	readonly capabilities: ModelCapabilities = {
		supportsImages: false,
		supportsToolUse: true,
		supportsReasoning: false,
		supportsReasoningSignature: false,
		supportsStreaming: true,
	}

	convertImageBlock(_block: ImageBlock): ProviderImageBlock | null {
		return null
	}

	extractReasoning(_chunk: Record<string, unknown>): ExtractedReasoning | null {
		return null
	}

	shouldStripReasoningTags(): boolean {
		return false
	}
}
