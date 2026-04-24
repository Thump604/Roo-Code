/**
 * Pure helper for persisting and truncating oversized tool output.
 *
 * Shared between UseMcpToolTool and ExecuteCommandTool so that tests
 * exercise the real production code path instead of duplicating logic.
 *
 * Preview policy: HEAD-ONLY. The preview is the first N bytes of the
 * output. This is deliberate — MCP tool results are typically structured
 * data where the beginning contains schema/header information most useful
 * for the model. Tail-aware preview (head + tail split) is deferred to
 * the generalized ArtifactStore design.
 */

import * as fs from "fs/promises"
import * as path from "path"

import { TERMINAL_PREVIEW_BYTES, DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE } from "@roo-code/types"

import { getTaskDirectoryPath } from "../../utils/storage"

export interface TruncationResult {
	preview: string
	truncated: boolean
}

/**
 * Validate that an artifact ID is basename-safe (no path traversal).
 * Accepts cmd-{id}.txt and mcp-{id}.txt formats only.
 */
const VALID_ARTIFACT_ID = /^(cmd|mcp)-[\w-]+\.txt$/

export function isValidArtifactId(artifactId: string): boolean {
	return VALID_ARTIFACT_ID.test(artifactId)
}

/** Monotonic counter to prevent artifact ID collisions within a process. */
let artifactCounter = 0

/**
 * Generate a collision-resistant MCP artifact ID.
 *
 * Combines the execution timestamp with a monotonic counter so two MCP
 * tool calls in the same millisecond get distinct file names.
 *
 * The executionId is sanitized to prevent path traversal — only word
 * characters and hyphens are allowed. Any other character is stripped.
 */
export function generateMcpArtifactId(executionId: string): string {
	const sanitized = executionId.replace(/[^\w-]/g, "")
	if (!sanitized) {
		return `mcp-unknown-${artifactCounter++}.txt`
	}
	return `mcp-${sanitized}-${artifactCounter++}.txt`
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
