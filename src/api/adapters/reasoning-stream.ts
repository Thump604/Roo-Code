/**
 * Shared reasoning stream processor for OpenAI-compatible providers.
 *
 * Encapsulates the TagMatcher + extractReasoning pattern so providers
 * don't duplicate reasoning/tag handling logic. Driven by ModelAdapter
 * capabilities.
 */

import { TagMatcher } from "../../utils/tag-matcher"
import type { ModelAdapter } from "./model-adapter"

type StreamChunk = { type: "reasoning"; text: string } | { type: "text"; text: string }

/**
 * Creates a reasoning stream processor bound to a ModelAdapter.
 *
 * The processor handles two reasoning extraction paths:
 * 1. Tag stripping: `<think>...</think>` → reasoning chunks (if adapter says to strip)
 * 2. Dedicated fields: `reasoning_content` / `reasoning` → reasoning chunks
 *
 * Usage:
 * ```ts
 * const processor = createReasoningProcessor(adapter)
 * // For each stream delta:
 * yield* processor.processContent(delta.content)
 * yield* processor.processReasoning(delta)
 * // At stream end:
 * yield* processor.final()
 * ```
 */
export function createReasoningProcessor(adapter: ModelAdapter) {
	const stripTags = adapter.shouldStripReasoningTags()
	const matcher = stripTags
		? new TagMatcher(
				"think",
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)
		: null

	return {
		/**
		 * Process text content from a stream delta.
		 * When tag stripping is enabled, `<think>` tags are extracted as reasoning.
		 */
		*processContent(content: string): Generator<StreamChunk> {
			if (matcher) {
				yield* matcher.update(content)
			} else {
				yield { type: "text", text: content }
			}
		},

		/**
		 * Extract reasoning from dedicated fields (reasoning_content, reasoning)
		 * using the adapter. Call this with the raw delta object.
		 */
		*processReasoning(delta: Record<string, unknown>): Generator<StreamChunk> {
			const extracted = adapter.extractReasoning(delta)
			if (extracted && extracted.text.trim()) {
				yield { type: "reasoning", text: extracted.text }
			}
		},

		/**
		 * Finalize the stream. Flushes any remaining buffered tag content.
		 */
		*final(): Generator<StreamChunk> {
			if (matcher) {
				yield* matcher.final()
			}
		},
	}
}
