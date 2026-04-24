/**
 * Tests for MCP tool output truncation via the production helper.
 *
 * Exercises maybeTruncateToolOutput directly — the same function
 * that UseMcpToolTool.maybeTruncateResult delegates to.
 *
 * Verifies that:
 * - Text under threshold is returned unchanged (truncated: false)
 * - No artifact marker is emitted unless the full artifact was persisted
 * - Write failures return full text (no data loss)
 * - Missing storage path returns full text (no data loss)
 * - Multi-byte text (CJK, emoji) respects the byte budget, not string length
 * - ReadCommandOutputTool accepts MCP artifact IDs
 * - Saved artifacts can be read back from the persisted path
 */

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import { TERMINAL_PREVIEW_BYTES } from "@roo-code/types"

import {
	maybeTruncateToolOutput,
	generateArtifactId,
	generateMcpArtifactId,
	readArtifact,
	isValidArtifactId,
	ARTIFACT_PREFIXES,
} from "../tool-output-artifacts"

const threshold = TERMINAL_PREVIEW_BYTES["medium"] // 10KB

// =============================================================================
// Threshold and passthrough
// =============================================================================

describe("maybeTruncateToolOutput — passthrough", () => {
	it("threshold is 10KB for medium preview size", () => {
		expect(threshold).toBe(10 * 1024)
	})

	it("text under threshold returns unchanged", async () => {
		const text = "a".repeat(threshold - 1)
		const result = await maybeTruncateToolOutput(text, "mcp-1.txt", "task-1", "/tmp/fake")
		expect(result.truncated).toBe(false)
		expect(result.preview).toBe(text)
	})

	it("text at exact threshold returns unchanged", async () => {
		const text = "a".repeat(threshold)
		const result = await maybeTruncateToolOutput(text, "mcp-2.txt", "task-2", "/tmp/fake")
		expect(result.truncated).toBe(false)
		expect(result.preview).toBe(text)
	})
})

// =============================================================================
// No-storage-path safety
// =============================================================================

describe("maybeTruncateToolOutput — no storage path", () => {
	it("returns full text when globalStoragePath is undefined", async () => {
		const text = "x".repeat(threshold + 500)
		const result = await maybeTruncateToolOutput(text, "mcp-3.txt", "task-3", undefined)
		expect(result.truncated).toBe(false)
		expect(result.preview).toBe(text)
	})
})

// =============================================================================
// Defense-in-depth: artifactId validation inside helper
// =============================================================================

describe("maybeTruncateToolOutput — artifactId validation", () => {
	it("returns full text when artifactId contains path traversal", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-id-test-"))
		try {
			const text = "x".repeat(threshold + 100)
			const result = await maybeTruncateToolOutput(text, "../../../etc/passwd", "task-bad", tmpDir)
			expect(result.truncated).toBe(false)
			expect(result.preview).toBe(text)
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	it("returns full text when artifactId has invalid prefix", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-id-test-"))
		try {
			const text = "y".repeat(threshold + 100)
			const result = await maybeTruncateToolOutput(text, "evil-1234.txt", "task-bad2", tmpDir)
			expect(result.truncated).toBe(false)
			expect(result.preview).toBe(text)
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})
})

// =============================================================================
// isValidArtifactId — shared validator
// =============================================================================

describe("isValidArtifactId", () => {
	it.each([
		"cmd-1706119234567.txt",
		"mcp-1706119234567-0.txt",
		"mcp-abc_def-3.txt",
		"search-1706119234567-0.txt",
		"test-1706119234567-0.txt",
	])("accepts valid ID: %s", (id) => expect(isValidArtifactId(id)).toBe(true))

	it.each([
		"../../../etc/passwd",
		"cmd-123.txt/../../etc/passwd",
		"mcp-../evil.txt",
		"evil-1234.txt",
		"cmd-123;rm -rf.txt",
		"cmd-$(whoami).txt",
		"debug-123.txt",
	])("rejects invalid ID: %s", (id) => expect(isValidArtifactId(id)).toBe(false))
})

// =============================================================================
// Artifact persistence + truncation
// =============================================================================

describe("maybeTruncateToolOutput — artifact persistence", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-trunc-test-"))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("writes full output to disk and returns truncated preview", async () => {
		const text = "x".repeat(threshold + 500)
		const artifactId = "mcp-test-persist.txt"
		const result = await maybeTruncateToolOutput(text, artifactId, "task-p", tmpDir)

		expect(result.truncated).toBe(true)
		expect(result.preview).toContain(artifactId)
		expect(result.preview).toContain("read_command_output")
		expect(result.preview).toContain(`${threshold + 500} bytes total`)
	})

	it("preview byte length does not exceed budget (ASCII)", async () => {
		const text = "a".repeat(threshold + 1000)
		const result = await maybeTruncateToolOutput(text, "mcp-ascii.txt", "task-a", tmpDir)

		// Extract preview before the marker
		const markerStart = result.preview.indexOf("\n\n[Truncated:")
		const previewOnly = result.preview.slice(0, markerStart)
		expect(Buffer.byteLength(previewOnly, "utf-8")).toBe(threshold)
	})

	it("preview byte length does not exceed budget (CJK)", async () => {
		// 3-byte UTF-8 characters (Japanese hiragana)
		const text = "あ".repeat(5000) // 15000 bytes > 10KB
		const result = await maybeTruncateToolOutput(text, "mcp-cjk.txt", "task-cjk", tmpDir)

		expect(result.truncated).toBe(true)
		const markerStart = result.preview.indexOf("\n\n[Truncated:")
		const previewOnly = result.preview.slice(0, markerStart)
		expect(Buffer.byteLength(previewOnly, "utf-8")).toBeLessThanOrEqual(threshold)
	})

	it("preview byte length does not exceed budget (emoji)", async () => {
		// 4-byte UTF-8 characters
		const text = "🎉".repeat(4000) // 16000 bytes > 10KB
		const result = await maybeTruncateToolOutput(text, "mcp-emoji.txt", "task-emoji", tmpDir)

		expect(result.truncated).toBe(true)
		const markerStart = result.preview.indexOf("\n\n[Truncated:")
		const previewOnly = result.preview.slice(0, markerStart)
		expect(Buffer.byteLength(previewOnly, "utf-8")).toBeLessThanOrEqual(threshold)
	})

	it("persisted artifact matches original text exactly", async () => {
		const text = "hello world! ".repeat(1000) + "🎉"
		const artifactId = "mcp-readback.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-rb", tmpDir)

		// Read back via the same path structure ReadCommandOutputTool expects
		const artifactPath = path.join(tmpDir, "tasks", "task-rb", "command-output", artifactId)
		const stored = await fs.readFile(artifactPath, "utf-8")
		expect(stored).toBe(text)
	})

	it("read-back artifact is accessible via standard file operations", async () => {
		const text = "line1\nline2\nline3\n" + "data ".repeat(3000)
		const artifactId = "mcp-readback-ops.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-rbops", tmpDir)

		const artifactPath = path.join(tmpDir, "tasks", "task-rbops", "command-output", artifactId)

		// Simulate read_command_output: read with offset and limit
		const fileHandle = await fs.open(artifactPath, "r")
		try {
			const stat = await fileHandle.stat()
			const readBuffer = Buffer.alloc(1024)
			const { bytesRead } = await fileHandle.read(readBuffer, 0, 1024, 0)
			const content = readBuffer.subarray(0, bytesRead).toString("utf-8")

			expect(content).toContain("line1")
			expect(stat.size).toBe(Buffer.byteLength(text, "utf-8"))
		} finally {
			await fileHandle.close()
		}
	})

	it("write failure returns full text (no data loss)", async () => {
		// Use an invalid path to trigger write failure
		const text = "x".repeat(threshold + 100)
		const result = await maybeTruncateToolOutput(
			text,
			"mcp-fail.txt",
			"task-fail",
			"/nonexistent/path/that/does/not/exist",
		)

		expect(result.truncated).toBe(false)
		expect(result.preview).toBe(text)
	})
})

// =============================================================================
// ReadCommandOutputTool artifact_id validation
// =============================================================================

describe("ReadCommandOutputTool artifact_id validation", () => {
	// This must match the production regex in ReadCommandOutputTool.isValidArtifactId
	const isValidArtifactId = (artifactId: string): boolean => {
		const validPattern = /^(cmd|mcp)-[\w-]+\.txt$/
		return validPattern.test(artifactId)
	}

	it("accepts standard command artifact IDs", () => {
		expect(isValidArtifactId("cmd-1706119234567.txt")).toBe(true)
	})

	it("accepts MCP artifact IDs", () => {
		expect(isValidArtifactId("mcp-1706119234567.txt")).toBe(true)
		expect(isValidArtifactId("mcp-exec-42.txt")).toBe(true)
	})

	it("rejects path traversal attempts", () => {
		expect(isValidArtifactId("../../../etc/passwd")).toBe(false)
		expect(isValidArtifactId("cmd-123.txt/../../etc/passwd")).toBe(false)
		expect(isValidArtifactId("mcp-../evil.txt")).toBe(false)
	})

	it("rejects unknown prefixes", () => {
		expect(isValidArtifactId("evil-123.txt")).toBe(false)
		expect(isValidArtifactId("foo-123.txt")).toBe(false)
	})

	it("rejects IDs with special characters", () => {
		expect(isValidArtifactId("cmd-123;rm -rf /.txt")).toBe(false)
		expect(isValidArtifactId("mcp-$(whoami).txt")).toBe(false)
	})

	it("accepts counter-suffixed MCP artifact IDs", () => {
		expect(isValidArtifactId("mcp-12345-0.txt")).toBe(true)
		expect(isValidArtifactId("mcp-12345-42.txt")).toBe(true)
	})
})

// =============================================================================
// Artifact ID collision prevention
// =============================================================================

describe("generateArtifactId — generalized artifact classes", () => {
	it.each(ARTIFACT_PREFIXES)("generates valid ID for %s prefix", (prefix) => {
		const id = generateArtifactId(prefix, "1706119234567")
		expect(isValidArtifactId(id)).toBe(true)
		expect(id).toMatch(new RegExp(`^${prefix}-`))
	})

	it("generates unique IDs across classes for same executionId", () => {
		const mcpId = generateArtifactId("mcp", "same-ts")
		const searchId = generateArtifactId("search", "same-ts")
		const testId = generateArtifactId("test", "same-ts")
		expect(new Set([mcpId, searchId, testId]).size).toBe(3)
	})

	it("sanitizes path traversal in executionId for all classes", () => {
		for (const prefix of ARTIFACT_PREFIXES) {
			const id = generateArtifactId(prefix, "../../etc/passwd")
			expect(isValidArtifactId(id)).toBe(true)
			expect(id).not.toContain("..")
			expect(id).not.toContain("/")
		}
	})

	it("handles empty executionId after sanitization", () => {
		const id = generateArtifactId("test", "///...")
		expect(isValidArtifactId(id)).toBe(true)
		expect(id).toContain("unknown")
	})
})

describe("generateMcpArtifactId — backward-compatible alias", () => {
	it("generates unique IDs for same executionId", () => {
		const id1 = generateMcpArtifactId("same-ts")
		const id2 = generateMcpArtifactId("same-ts")
		expect(id1).not.toBe(id2)
	})

	it("produces IDs with mcp- prefix", () => {
		const id = generateMcpArtifactId("1706119234567")
		expect(id).toMatch(/^mcp-/)
		expect(isValidArtifactId(id)).toBe(true)
	})

	it("preserves normal executionId characters", () => {
		const id = generateMcpArtifactId("1706119234567")
		expect(id).toContain("1706119234567")
	})
})

// =============================================================================
// readArtifact — offset/limit reads
// =============================================================================

describe("readArtifact — offset and limit reads", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-read-test-"))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("reads full artifact with default offset/limit", async () => {
		const text = "Hello, artifact world!"
		const artifactId = "mcp-read-full.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-rf", tmpDir)

		// Text is under threshold so no truncation, but we manually wrote it
		// for the passthrough case. Let's use a large text instead.
		const largeText = "A".repeat(threshold + 500)
		const largeId = "mcp-read-large.txt"
		await maybeTruncateToolOutput(largeText, largeId, "task-rl", tmpDir)

		const result = await readArtifact(tmpDir, "task-rl", largeId)
		expect(result.totalSize).toBe(threshold + 500)
		// Default limit is 40KB, so full content is returned
		expect(result.content.length).toBe(threshold + 500)
	})

	it("reads with offset skipping the first N bytes", async () => {
		const text = "HEADER" + "X".repeat(threshold + 500)
		const artifactId = "mcp-read-offset.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-ro", tmpDir)

		const result = await readArtifact(tmpDir, "task-ro", artifactId, 6, 100)
		expect(result.content).toBe("X".repeat(100))
		expect(result.totalSize).toBe(6 + threshold + 500)
	})

	it("reads with limit smaller than file size", async () => {
		const text = "Y".repeat(threshold + 1000)
		const artifactId = "mcp-read-limit.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-rlim", tmpDir)

		const result = await readArtifact(tmpDir, "task-rlim", artifactId, 0, 256)
		expect(result.content.length).toBe(256)
		expect(result.content).toBe("Y".repeat(256))
	})

	it("returns empty content when offset >= totalSize (no RangeError)", async () => {
		const text = "Z".repeat(threshold + 100)
		const artifactId = "mcp-read-past-eof.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-rpeof", tmpDir)

		const result = await readArtifact(tmpDir, "task-rpeof", artifactId, threshold + 5000)
		expect(result.content).toBe("")
		expect(result.totalSize).toBe(threshold + 100)
	})

	it("returns empty content when offset equals totalSize exactly", async () => {
		const text = "W".repeat(threshold + 50)
		const artifactId = "mcp-read-exact-eof.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-reeof", tmpDir)

		const result = await readArtifact(tmpDir, "task-reeof", artifactId, threshold + 50)
		expect(result.content).toBe("")
		expect(result.totalSize).toBe(threshold + 50)
	})

	it("handles multibyte content at offset boundary", async () => {
		// CJK characters are 3 bytes each in UTF-8
		const text = "あ".repeat(Math.ceil((threshold + 100) / 3))
		const artifactId = "mcp-read-multibyte.txt"
		await maybeTruncateToolOutput(text, artifactId, "task-rmb", tmpDir)

		const result = await readArtifact(tmpDir, "task-rmb", artifactId, 6, 9)
		// 6 bytes = 2 CJK chars offset, 9 bytes = 3 CJK chars
		expect(result.content).toBe("あああ")
	})

	it("persists and reads back search-* artifacts", async () => {
		const text = "search result ".repeat(1000)
		const artifactId = generateArtifactId("search", "1706119234567")

		const result = await maybeTruncateToolOutput(text, artifactId, "task-search", tmpDir)
		expect(result.truncated).toBe(true)
		expect(result.preview).toContain(artifactId)

		const readResult = await readArtifact(tmpDir, "task-search", artifactId)
		expect(readResult.content).toBe(text)
	})

	it("persists and reads back test-* artifacts", async () => {
		const text = "PASS test_example\nFAIL test_broken\n".repeat(500)
		const artifactId = generateArtifactId("test", "run-42")

		const result = await maybeTruncateToolOutput(text, artifactId, "task-test", tmpDir)
		expect(result.truncated).toBe(true)
		expect(result.preview).toContain(artifactId)

		const readResult = await readArtifact(tmpDir, "task-test", artifactId)
		expect(readResult.content).toBe(text)
	})
})
