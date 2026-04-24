export interface TagMatcherResult {
	matched: boolean
	data: string
}

/**
 * Streaming matcher for lightweight tag-delimited regions.
 *
 * Separates content inside `<tag>...</tag>` from surrounding text in a
 * character-by-character streaming fashion. Used by OpenAI-compatible
 * providers to extract `<think>...</think>` reasoning blocks from model
 * output.
 *
 * Design constraints:
 * - Must handle tags split across arbitrary chunk boundaries
 * - Must handle complete `<tag>...</tag>` in a single chunk
 * - Must handle `visible<tag>hidden</tag>visible` mid-stream
 * - Must handle nested same-tag (`<think><think>inner</think></think>`)
 * - Incomplete tag at stream end: buffered chars flushed as unmatched text
 *   (fail-closed — never swallow text silently)
 */
export class TagMatcher<Result = TagMatcherResult> {
	/** Character index into tagName being validated during TAG_OPEN/TAG_CLOSE */
	private tagIndex = 0
	/** Accumulated result chunks waiting to be popped */
	private chunks: TagMatcherResult[] = []
	/** Characters buffered while speculatively parsing a potential tag */
	private cached: string[] = []
	/** Whether we are currently inside a matched tag region */
	private matched = false
	/** Parser state machine */
	private state: "TEXT" | "TAG_OPEN" | "TAG_CLOSE" = "TEXT"
	/** Nesting depth — >0 means we are inside matched region */
	private depth = 0

	constructor(
		readonly tagName: string,
		readonly transform?: (chunks: TagMatcherResult) => Result,
	) {}

	/**
	 * Flush cached characters into the chunks array, merging with the
	 * last chunk if it has the same matched state.
	 */
	private collect() {
		if (!this.cached.length) {
			return
		}
		const last = this.chunks.at(-1)
		const data = this.cached.join("")
		if (last?.matched === this.matched) {
			last.data += data
		} else {
			this.chunks.push({ data, matched: this.matched })
		}
		this.cached = []
	}

	/** Pop accumulated chunks, applying transform if provided. */
	private pop() {
		const chunks = this.chunks
		this.chunks = []
		if (!this.transform) {
			return chunks as Result[]
		}
		return chunks.map(this.transform)
	}

	private _update(chunk: string) {
		for (const char of chunk) {
			if (this.state === "TEXT") {
				if (char === "<") {
					// Flush any pending text before entering speculative tag parse
					this.collect()
					this.state = "TAG_OPEN"
					this.tagIndex = 0
					this.cached.push(char)
				} else {
					this.cached.push(char)
				}
			} else if (this.state === "TAG_OPEN") {
				this.cached.push(char)

				if (this.tagIndex === 0 && char === "/") {
					// Switch to close-tag detection: `</`
					this.state = "TAG_CLOSE"
				} else if (char === " " && (this.tagIndex === 0 || this.tagIndex === this.tagName.length)) {
					// Allow whitespace after `<` or after the full tag name
					continue
				} else if (this.tagIndex < this.tagName.length && this.tagName[this.tagIndex] === char) {
					this.tagIndex++
				} else if (char === ">" && this.tagIndex === this.tagName.length) {
					// Complete open tag: `<tagName>`
					this.depth++
					this.matched = true
					// Discard the tag markup from cached (don't emit `<think>`)
					this.cached = []
					this.state = "TEXT"
				} else {
					// Not a valid open tag — fall back to TEXT, keep cached chars
					this.state = "TEXT"
					this.collect()
				}
			} else if (this.state === "TAG_CLOSE") {
				this.cached.push(char)

				if (char === " " && (this.tagIndex === 0 || this.tagIndex === this.tagName.length)) {
					// Allow whitespace after `</` or after the full tag name
					continue
				} else if (this.tagIndex < this.tagName.length && this.tagName[this.tagIndex] === char) {
					this.tagIndex++
				} else if (char === ">" && this.tagIndex === this.tagName.length) {
					// Complete close tag: `</tagName>`
					this.depth--
					if (this.depth <= 0) {
						this.depth = 0
						this.matched = false
					}
					// Discard the tag markup from cached
					this.cached = []
					this.state = "TEXT"
				} else {
					// Not a valid close tag — fall back to TEXT, keep cached chars
					this.state = "TEXT"
					this.collect()
				}
			}
		}
	}

	/**
	 * Finalize the stream. Any remaining cached characters are flushed
	 * as the current matched state (fail-closed: incomplete tags produce
	 * text, never silently disappear).
	 */
	final(chunk?: string) {
		if (chunk) {
			this._update(chunk)
		}
		// Flush any speculative buffer as current state (fail-closed)
		this.collect()
		return this.pop()
	}

	/**
	 * Feed a chunk of text. Returns any complete result segments accumulated
	 * so far.
	 */
	update(chunk: string) {
		this._update(chunk)
		// Only pop fully flushed chunks; speculative buffer stays cached
		// until we know whether the potential tag is real.
		// But we should flush text that is definitively outside any tag.
		return this.pop()
	}
}
