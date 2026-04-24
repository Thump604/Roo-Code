/**
 * Task index types for Mesa Code CLI.
 *
 * The task index is a lightweight local JSON file that tracks recent tasks
 * across CLI sessions. It records metadata but not secrets or full prompts.
 */

/**
 * A single entry in the task index.
 */
export interface TaskIndexEntry {
	/** Stable task ID (UUID or session ID from the runtime). */
	taskId: string
	/** ISO 8601 timestamp when the task was created. */
	createdAt: string
	/** ISO 8601 timestamp when the entry was last updated. */
	updatedAt: string
	/** Working directory at task start. */
	cwd: string
	/** Short prompt summary (first ~120 chars, no secrets). */
	promptSummary: string
	/** Task status. */
	taskStatus: "running" | "completed" | "failed" | "cancelled"
	/** Whether the task is pinned. */
	pinned: boolean
	/** Model ID if known. */
	model?: string
	/** Provider name if known. */
	provider?: string
}

/**
 * The on-disk task index file shape.
 */
export interface TaskIndexFile {
	version: 1
	entries: TaskIndexEntry[]
}

/** Maximum entries to keep in the index (prevents unbounded growth). */
export const MAX_INDEX_ENTRIES = 500
