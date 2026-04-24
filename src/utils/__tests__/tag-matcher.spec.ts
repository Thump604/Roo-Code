/**
 * Comprehensive tests for TagMatcher streaming tag parser.
 *
 * Covers:
 * - Complete tag in one chunk
 * - Tag split across chunks (open, close, and content boundaries)
 * - Multiple tags in one chunk
 * - Visible text before, after, and between tags
 * - Nested same-tag
 * - Malformed / incomplete tag at stream end (fail-closed)
 * - Empty content inside tag
 * - Whitespace tolerance in tag syntax
 * - No false positives from angle brackets in regular text
 */

import { TagMatcher, type TagMatcherResult } from "../tag-matcher"

/** Helper: feed all chunks through update(), then final(), collect results. */
function run(tagName: string, ...chunks: string[]): TagMatcherResult[] {
	const matcher = new TagMatcher(tagName)
	const results: TagMatcherResult[] = []
	for (const chunk of chunks) {
		results.push(...matcher.update(chunk))
	}
	results.push(...matcher.final())
	return results
}

/** Helper: concatenate all unmatched text from results. */
function visibleText(results: TagMatcherResult[]): string {
	return results
		.filter((r) => !r.matched)
		.map((r) => r.data)
		.join("")
}

/** Helper: concatenate all matched (reasoning) text from results. */
function matchedText(results: TagMatcherResult[]): string {
	return results
		.filter((r) => r.matched)
		.map((r) => r.data)
		.join("")
}

// =============================================================================
// Complete tag in one chunk
// =============================================================================

describe("TagMatcher — complete tag in one chunk", () => {
	it("<think>hidden</think> at start of stream", () => {
		const results = run("think", "<think>hidden</think>")
		expect(matchedText(results)).toBe("hidden")
		expect(visibleText(results)).toBe("")
	})

	it("<think>hidden</think>visible", () => {
		const results = run("think", "<think>hidden</think>visible")
		expect(matchedText(results)).toBe("hidden")
		expect(visibleText(results)).toBe("visible")
	})

	it("visible<think>hidden</think>visible", () => {
		const results = run("think", "visible<think>hidden</think>more visible")
		expect(matchedText(results)).toBe("hidden")
		expect(visibleText(results)).toBe("visiblemore visible")
	})

	it("visible text with no tags at all", () => {
		const results = run("think", "just regular text")
		expect(visibleText(results)).toBe("just regular text")
		expect(matchedText(results)).toBe("")
	})

	it("empty content inside tag", () => {
		const results = run("think", "<think></think>visible")
		expect(matchedText(results)).toBe("")
		expect(visibleText(results)).toBe("visible")
	})
})

// =============================================================================
// Tag split across chunks
// =============================================================================

describe("TagMatcher — split across chunks", () => {
	it("open tag split: '<thi' + 'nk>content</think>'", () => {
		const results = run("think", "<thi", "nk>content</think>")
		expect(matchedText(results)).toBe("content")
		expect(visibleText(results)).toBe("")
	})

	it("close tag split: '<think>content</thi' + 'nk>'", () => {
		const results = run("think", "<think>content</thi", "nk>")
		expect(matchedText(results)).toBe("content")
		expect(visibleText(results)).toBe("")
	})

	it("content split: '<think>con' + 'tent</think>'", () => {
		const results = run("think", "<think>con", "tent</think>")
		expect(matchedText(results)).toBe("content")
		expect(visibleText(results)).toBe("")
	})

	it("tag split at < boundary: 'text' + '<think>r</think>'", () => {
		const results = run("think", "text", "<think>r</think>")
		expect(matchedText(results)).toBe("r")
		expect(visibleText(results)).toBe("text")
	})

	it("every character is a separate chunk", () => {
		const input = "<think>hi</think>bye"
		const results = run("think", ...input.split(""))
		expect(matchedText(results)).toBe("hi")
		expect(visibleText(results)).toBe("bye")
	})
})

// =============================================================================
// Multiple tags
// =============================================================================

describe("TagMatcher — multiple tags in stream", () => {
	it("two consecutive tags", () => {
		const results = run("think", "<think>first</think><think>second</think>")
		expect(matchedText(results)).toBe("firstsecond")
		expect(visibleText(results)).toBe("")
	})

	it("text between two tags", () => {
		const results = run("think", "<think>a</think>middle<think>b</think>end")
		expect(matchedText(results)).toBe("ab")
		expect(visibleText(results)).toBe("middleend")
	})
})

// =============================================================================
// Nested same-tag
// =============================================================================

describe("TagMatcher — nested same-tag", () => {
	it("nested <think><think>inner</think></think>", () => {
		const results = run("think", "<think>outer<think>inner</think>still-outer</think>visible")
		expect(matchedText(results)).toBe("outerinnerstill-outer")
		expect(visibleText(results)).toBe("visible")
	})
})

// =============================================================================
// Malformed / incomplete tag at stream end
// =============================================================================

describe("TagMatcher — incomplete tag at stream end (fail-closed)", () => {
	it("unclosed <think> — content flushed as matched (inside tag)", () => {
		const results = run("think", "<think>orphaned content")
		// Content is inside the tag, so it should be matched (reasoning)
		// The tag markup itself is discarded, content is flushed as matched
		expect(matchedText(results)).toBe("orphaned content")
	})

	it("partial open tag '<thi' at end — flushed as unmatched text", () => {
		const results = run("think", "text<thi")
		// The partial '<thi' can't form a tag, so everything is visible
		expect(visibleText(results)).toBe("text<thi")
	})

	it("partial close tag '</thi' at end — content stays matched", () => {
		const results = run("think", "<think>content</thi")
		// We are still inside the tag; the partial close tag is buffered
		expect(matchedText(results)).toContain("content")
	})
})

// =============================================================================
// Whitespace tolerance
// =============================================================================

describe("TagMatcher — whitespace in tags", () => {
	it("< think> with space after <", () => {
		const results = run("think", "< think>hidden</think>visible")
		expect(matchedText(results)).toBe("hidden")
		expect(visibleText(results)).toBe("visible")
	})

	it("<think > with space before >", () => {
		const results = run("think", "<think >hidden</think>visible")
		expect(matchedText(results)).toBe("hidden")
		expect(visibleText(results)).toBe("visible")
	})
})

// =============================================================================
// No false positives
// =============================================================================

describe("TagMatcher — no false positives", () => {
	it("angle brackets in regular text like 'x < y > z'", () => {
		const results = run("think", "x < y > z")
		expect(visibleText(results)).toBe("x < y > z")
		expect(matchedText(results)).toBe("")
	})

	it("different tag name <thought> does not match <think>", () => {
		const results = run("think", "<thought>not a think tag</thought>")
		expect(visibleText(results)).toContain("<thought>")
		expect(matchedText(results)).toBe("")
	})

	it("HTML-like tags that aren't the target", () => {
		const results = run("think", "<div>content</div>")
		expect(visibleText(results)).toContain("<div>")
		expect(matchedText(results)).toBe("")
	})
})

// =============================================================================
// <thought> tag family
// =============================================================================

describe("TagMatcher — thought tag", () => {
	it("<thought>hidden</thought>visible with thought matcher", () => {
		const results = run("thought", "<thought>hidden</thought>visible")
		expect(matchedText(results)).toBe("hidden")
		expect(visibleText(results)).toBe("visible")
	})

	it("mixed chunks with thought tag", () => {
		const results = run("thought", "before<thou", "ght>inner</thought>after")
		expect(matchedText(results)).toBe("inner")
		expect(visibleText(results)).toBe("beforeafter")
	})
})

// =============================================================================
// Transform function
// =============================================================================

describe("TagMatcher — transform function", () => {
	it("transforms results via provided function", () => {
		const matcher = new TagMatcher("think", (chunk) => ({
			type: chunk.matched ? ("reasoning" as const) : ("text" as const),
			text: chunk.data,
		}))
		const results = [...matcher.update("<think>reasoning</think>visible"), ...matcher.final()]

		const reasoning = results.filter((r) => r.type === "reasoning")
		const text = results.filter((r) => r.type === "text")
		expect(reasoning.map((r) => r.text).join("")).toBe("reasoning")
		expect(text.map((r) => r.text).join("")).toBe("visible")
	})
})

// =============================================================================
// Regression: no <think> or </think> in visible text
// =============================================================================

describe("TagMatcher — no tag markup in visible output", () => {
	const scenarios = [
		"<think>hidden</think>visible",
		"visible<think>hidden</think>visible",
		"<think>h</think>v<think>h2</think>v2",
		"<think>multi\nline\ncontent</think>after",
	]

	for (const input of scenarios) {
		it(`no <think> or </think> in visible text: ${JSON.stringify(input)}`, () => {
			const results = run("think", input)
			const visible = visibleText(results)
			expect(visible).not.toContain("<think>")
			expect(visible).not.toContain("</think>")
		})

		it(`no <think> or </think> in visible text (char-by-char): ${JSON.stringify(input)}`, () => {
			const results = run("think", ...input.split(""))
			const visible = visibleText(results)
			expect(visible).not.toContain("<think>")
			expect(visible).not.toContain("</think>")
		})
	}
})
