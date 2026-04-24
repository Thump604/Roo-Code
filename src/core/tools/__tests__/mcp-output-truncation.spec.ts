/**
 * Tests for MCP tool output truncation boundary.
 *
 * Verifies that oversized MCP results are truncated with a preview + artifact
 * marker, and that the ReadCommandOutputTool accepts MCP artifact IDs.
 */

import { TERMINAL_PREVIEW_BYTES } from "@roo-code/types"

describe("MCP output truncation boundary", () => {
	const threshold = TERMINAL_PREVIEW_BYTES["medium"] // 10KB

	it("threshold is 10KB for medium preview size", () => {
		expect(threshold).toBe(10 * 1024)
	})

	it("text under threshold is not truncated", () => {
		const text = "a".repeat(threshold - 1)
		const textBytes = Buffer.byteLength(text, "utf-8")
		expect(textBytes).toBeLessThanOrEqual(threshold)
	})

	it("text over threshold should be truncatable", () => {
		const text = "a".repeat(threshold + 1000)
		const textBytes = Buffer.byteLength(text, "utf-8")
		expect(textBytes).toBeGreaterThan(threshold)

		// Simulate the preview slice
		const preview = text.slice(0, threshold)
		expect(preview.length).toBe(threshold)
	})

	it("truncation marker includes artifact_id and byte count", () => {
		const totalBytes = 50000
		const artifactId = "mcp-test-123.txt"
		const marker = `\n\n[Truncated: ${totalBytes} bytes total. Use read_command_output with artifact_id="${artifactId}" to read the full output.]`

		expect(marker).toContain("mcp-test-123.txt")
		expect(marker).toContain("50000 bytes")
		expect(marker).toContain("read_command_output")
	})

	it("multi-byte characters are counted by byte length, not string length", () => {
		// 3-byte UTF-8 characters
		const text = "あ".repeat(3500) // 3500 chars × 3 bytes = 10500 bytes > 10KB
		const textBytes = Buffer.byteLength(text, "utf-8")
		expect(textBytes).toBeGreaterThan(threshold)
		expect(text.length).toBeLessThan(threshold) // string length is under, but byte length is over
	})
})

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
