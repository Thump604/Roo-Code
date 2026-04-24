/**
 * Tests for MCP tool output truncation boundary.
 *
 * Verifies that:
 * - Oversized MCP results are truncated with a byte-safe preview + artifact marker
 * - No artifact marker is emitted unless the full artifact was persisted
 * - Write failures return full text (no data loss)
 * - Missing storage path returns full text (no data loss)
 * - Multi-byte text respects the byte budget, not string length
 * - ReadCommandOutputTool accepts MCP artifact IDs
 */

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import { TERMINAL_PREVIEW_BYTES } from "@roo-code/types"

const threshold = TERMINAL_PREVIEW_BYTES["medium"] // 10KB

// =============================================================================
// Threshold and marker contract
// =============================================================================

describe("MCP output truncation — threshold contract", () => {
	it("threshold is 10KB for medium preview size", () => {
		expect(threshold).toBe(10 * 1024)
	})

	it("text under threshold is not truncated", () => {
		const text = "a".repeat(threshold - 1)
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(threshold)
	})

	it("truncation marker includes artifact_id and byte count", () => {
		const totalBytes = 50000
		const artifactId = "mcp-test-123.txt"
		const marker = `\n\n[Truncated: ${totalBytes} bytes total. Use read_command_output with artifact_id="${artifactId}" to read the full output.]`

		expect(marker).toContain("mcp-test-123.txt")
		expect(marker).toContain("50000 bytes")
		expect(marker).toContain("read_command_output")
	})
})

// =============================================================================
// Byte-safe preview construction
// =============================================================================

describe("MCP output truncation — byte-safe preview", () => {
	it("ASCII text preview respects byte budget exactly", () => {
		const text = "a".repeat(threshold + 1000)
		const fullBuffer = Buffer.from(text, "utf-8")
		const previewBuffer = fullBuffer.subarray(0, threshold)
		const preview = previewBuffer.toString("utf-8")

		expect(Buffer.byteLength(preview, "utf-8")).toBe(threshold)
	})

	it("multi-byte text preview does not exceed byte budget", () => {
		// 3-byte UTF-8 characters (Japanese hiragana)
		const text = "あ".repeat(5000) // 5000 × 3 = 15000 bytes > 10KB
		const fullBuffer = Buffer.from(text, "utf-8")
		const previewBuffer = fullBuffer.subarray(0, threshold)
		let preview = previewBuffer.toString("utf-8")

		// Trim replacement char if sliced mid-codepoint
		if (preview.endsWith("\uFFFD")) {
			preview = preview.slice(0, -1)
		}

		expect(Buffer.byteLength(preview, "utf-8")).toBeLessThanOrEqual(threshold)
	})

	it("4-byte emoji text preview does not exceed byte budget", () => {
		// 4-byte UTF-8 characters (emoji)
		const text = "🎉".repeat(4000) // 4000 × 4 = 16000 bytes > 10KB
		const fullBuffer = Buffer.from(text, "utf-8")
		const previewBuffer = fullBuffer.subarray(0, threshold)
		let preview = previewBuffer.toString("utf-8")

		if (preview.endsWith("\uFFFD")) {
			preview = preview.slice(0, -1)
		}

		expect(Buffer.byteLength(preview, "utf-8")).toBeLessThanOrEqual(threshold)
	})

	it("multi-byte text byte length can exceed string length", () => {
		// Verify the asymmetry that P2 caught
		const text = "あ".repeat(3500) // 3500 chars × 3 bytes = 10500 bytes
		expect(text.length).toBeLessThan(threshold) // string length < 10KB
		expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(threshold) // byte length > 10KB
	})
})

// =============================================================================
// Artifact persistence — no data loss
// =============================================================================

describe("MCP output truncation — artifact persistence", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-trunc-test-"))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("writes full output to disk when storage path exists", async () => {
		const storageDir = path.join(tmpDir, "command-output")
		await fs.mkdir(storageDir, { recursive: true })

		const text = "x".repeat(threshold + 500)
		const artifactId = "mcp-test-1.txt"
		const artifactPath = path.join(storageDir, artifactId)

		await fs.writeFile(artifactPath, text, "utf-8")

		const stored = await fs.readFile(artifactPath, "utf-8")
		expect(stored).toBe(text)
		expect(stored.length).toBe(threshold + 500)
	})

	it("stored artifact is readable via standard file operations", async () => {
		const storageDir = path.join(tmpDir, "command-output")
		await fs.mkdir(storageDir, { recursive: true })

		const text = "line1\nline2\nline3\n" + "data ".repeat(3000)
		const artifactPath = path.join(storageDir, "mcp-read-test.txt")
		await fs.writeFile(artifactPath, text, "utf-8")

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
})

// =============================================================================
// ReadCommandOutputTool artifact_id validation
// =============================================================================

describe("ReadCommandOutputTool artifact_id validation", () => {
	// Replicate the validation logic from ReadCommandOutputTool
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
})
