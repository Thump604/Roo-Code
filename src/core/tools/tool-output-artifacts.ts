/**
 * Pure helper for persisting and truncating oversized tool output.
 *
 * Shared between UseMcpToolTool and ExecuteCommandTool so that tests
 * exercise the real production code path instead of duplicating logic.
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

	// Persist full output to disk — only truncate if persistence succeeds.
	try {
		const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
		const storageDir = path.join(taskDir, "command-output")
		await fs.mkdir(storageDir, { recursive: true })
		await fs.writeFile(path.join(storageDir, artifactId), text, "utf-8")
	} catch {
		return { preview: text, truncated: false }
	}

	// Build byte-safe preview: encode to UTF-8 bytes, slice to budget,
	// then decode back. This respects the byte budget regardless of
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
