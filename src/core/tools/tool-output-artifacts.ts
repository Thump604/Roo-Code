/**
 * Generalized ArtifactStore — persisting and reading oversized tool output.
 *
 * Supports artifact classes: command output (cmd-*), MCP output (mcp-*),
 * search output (search-*), and test output (test-*). Each class uses
 * the same storage layout, validation, and read-back path.
 *
 * Preview policy: HEAD-ONLY. The preview is the first N bytes of the
 * output. Tail-aware preview (head + tail split) is a future extension.
 */

import * as fs from "fs/promises"
import * as path from "path"

import { TERMINAL_PREVIEW_BYTES, DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE } from "@roo-code/types"

import { getTaskDirectoryPath } from "../../utils/storage"

export interface TruncationResult {
	preview: string
	truncated: boolean
}

// =========================================================================
// Artifact ID validation
// =========================================================================

/** Recognized artifact class prefixes. */
export const ARTIFACT_PREFIXES = ["cmd", "mcp", "search", "test"] as const
export type ArtifactPrefix = (typeof ARTIFACT_PREFIXES)[number]

/**
 * Validate that an artifact ID is basename-safe (no path traversal).
 * Accepts cmd-*, mcp-*, search-*, and test-* formats.
 */
const VALID_ARTIFACT_ID = /^(cmd|mcp|search|test)-[\w-]+\.txt$/

export function isValidArtifactId(artifactId: string): boolean {
	return VALID_ARTIFACT_ID.test(artifactId)
}

// =========================================================================
// Artifact ID generation
// =========================================================================

/** Monotonic counter to prevent artifact ID collisions within a process. */
let artifactCounter = 0

/** Sanitize an execution ID for use in artifact file names. */
function sanitizeExecutionId(executionId: string): string {
	const sanitized = executionId.replace(/[^\w-]/g, "")
	return sanitized || "unknown"
}

/**
 * Generate a collision-resistant artifact ID for a given class.
 *
 * Combines the execution timestamp with a monotonic counter so two
 * artifact writes in the same millisecond get distinct file names.
 * The executionId is sanitized to prevent path traversal.
 */
export function generateArtifactId(prefix: ArtifactPrefix, executionId: string): string {
	return `${prefix}-${sanitizeExecutionId(executionId)}-${artifactCounter++}.txt`
}

/**
 * Generate a collision-resistant MCP artifact ID.
 * Convenience alias for `generateArtifactId("mcp", executionId)`.
 */
export function generateMcpArtifactId(executionId: string): string {
	return generateArtifactId("mcp", executionId)
}

/**
 * If `text` exceeds the preview byte budget, persist the full output to
 * `{globalStoragePath}/tasks/{taskId}/command-output/{artifactId}` and
 * return a bounded preview with an artifact marker.
 *
 * Safety contract:
 * - No storage path → full text, truncated false
 * - Write failure → full text, truncated false
 * - Successful write → bounded preview, truncated true, marker includes artifact id
 * - ASCII, CJK, and emoji previews stay within byte budget
 * - Marker is never emitted unless the full artifact exists on disk
 */
export async function maybeTruncateToolOutput(
	text: string,
	artifactId: string,
	taskId: string,
	globalStoragePath: string | undefined,
	previewBytesBudget: number = TERMINAL_PREVIEW_BYTES[DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE],
): Promise<TruncationResult> {
	const textBytes = Buffer.byteLength(text, "utf-8")

	if (textBytes <= previewBytesBudget) {
		return { preview: text, truncated: false }
	}

	// No storage path → return full text rather than advertising a missing artifact
	if (!globalStoragePath) {
		return { preview: text, truncated: false }
	}

	// Defense-in-depth: validate artifactId is basename-safe before writing.
	if (!isValidArtifactId(artifactId)) {
		return { preview: text, truncated: false }
	}

	// Persist full output to disk — only truncate if persistence succeeds.
	try {
		const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
		const storageDir = path.join(taskDir, "command-output")
		await fs.mkdir(storageDir, { recursive: true })
		await fs.writeFile(path.join(storageDir, artifactId), text, "utf-8")
	} catch {
		return { preview: text, truncated: false }
	}

	// Build byte-safe preview (HEAD-ONLY): encode to UTF-8 bytes, slice to
	// budget, then decode back. This respects the byte budget regardless of
	// character width (CJK, emoji, etc.).
	const fullBuffer = Buffer.from(text, "utf-8")
	const previewBuffer = fullBuffer.subarray(0, previewBytesBudget)
	// Decode may produce a replacement character at the end if we sliced
	// mid-codepoint. Trim the last char if it's U+FFFD (replacement).
	let previewText = previewBuffer.toString("utf-8")
	if (previewText.endsWith("\uFFFD")) {
		previewText = previewText.slice(0, -1)
	}

	const marker = `\n\n[Truncated: ${textBytes} bytes total. Use read_command_output with artifact_id="${artifactId}" to read the full output.]`
	return { preview: previewText + marker, truncated: true }
}

/**
 * Read a persisted artifact with optional offset and limit (byte-based).
 *
 * This mirrors what ReadCommandOutputTool does internally, exported as a
 * testable helper. Returns the content slice as a UTF-8 string.
 */
export async function readArtifact(
	globalStoragePath: string,
	taskId: string,
	artifactId: string,
	offset = 0,
	limit = 40 * 1024,
): Promise<{ content: string; totalSize: number }> {
	// Defense-in-depth: validate artifactId is basename-safe before reading.
	if (!isValidArtifactId(artifactId)) {
		throw new Error(`Invalid artifact ID: "${artifactId}"`)
	}

	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const artifactPath = path.join(taskDir, "command-output", artifactId)
	const stat = await fs.stat(artifactPath)
	const totalSize = stat.size

	if (offset >= totalSize) {
		return { content: "", totalSize }
	}

	const fd = await fs.open(artifactPath, "r")
	try {
		const buf = Buffer.alloc(Math.min(limit, totalSize - offset))
		const { bytesRead } = await fd.read(buf, 0, buf.length, offset)
		return { content: buf.subarray(0, bytesRead).toString("utf-8"), totalSize }
	} finally {
		await fd.close()
	}
}
