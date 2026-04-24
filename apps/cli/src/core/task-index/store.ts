/**
 * TaskIndex — read/write/update operations for the local task index.
 *
 * The index is a single JSON file. Corruption is handled gracefully
 * by resetting to an empty index with a warning.
 */

import fs from "fs/promises"
import path from "path"

import type { TaskIndexEntry, TaskIndexFile } from "./types.js"
import { MAX_INDEX_ENTRIES } from "./types.js"

const INDEX_FILENAME = "task-index.json"

function emptyIndex(): TaskIndexFile {
	return { version: 1, entries: [] }
}

/**
 * Validate a caller-provided safe summary. The caller must never pass raw
 * prompt text — only a pre-sanitized title or generated label. This function
 * enforces length/newline constraints but does not attempt redaction.
 *
 * If the summary is empty or missing, a generic placeholder is used.
 */
function validateSummary(summary: string | undefined): string {
	if (!summary || summary.trim().length === 0) {
		return "(no summary)"
	}
	return summary.replace(/\n/g, " ").slice(0, 120).trim()
}

export class TaskIndex {
	private indexDir: string
	private indexPath: string

	constructor(indexDir: string) {
		this.indexDir = indexDir
		this.indexPath = path.join(indexDir, INDEX_FILENAME)
	}

	/**
	 * Read the index from disk. Returns empty index on missing or corrupt file.
	 */
	async read(): Promise<TaskIndexFile> {
		try {
			const raw = await fs.readFile(this.indexPath, "utf-8")
			const parsed = JSON.parse(raw)
			if (this.isValidIndex(parsed)) {
				return parsed
			}
			// Invalid structure — reset
			return emptyIndex()
		} catch {
			// File missing or corrupt JSON
			return emptyIndex()
		}
	}

	/**
	 * Write the index to disk. Ensures the directory exists.
	 */
	async write(index: TaskIndexFile): Promise<void> {
		await fs.mkdir(this.indexDir, { recursive: true })
		await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8")
	}

	/**
	 * Add or update a task entry. If the taskId already exists, update it.
	 * Trims the index to MAX_INDEX_ENTRIES.
	 */
	async upsert(
		entry: Omit<TaskIndexEntry, "createdAt" | "updatedAt" | "pinned"> & { pinned?: boolean },
	): Promise<TaskIndexEntry> {
		const index = await this.read()
		const now = new Date().toISOString()

		const existing = index.entries.find((e) => e.taskId === entry.taskId)
		if (existing) {
			existing.updatedAt = now
			existing.taskStatus = entry.taskStatus
			existing.promptSummary = validateSummary(entry.promptSummary)
			if (entry.model !== undefined) existing.model = entry.model
			if (entry.provider !== undefined) existing.provider = entry.provider
			await this.write(index)
			return existing
		}

		const newEntry: TaskIndexEntry = {
			taskId: entry.taskId,
			createdAt: now,
			updatedAt: now,
			cwd: entry.cwd,
			promptSummary: validateSummary(entry.promptSummary),
			taskStatus: entry.taskStatus,
			pinned: entry.pinned ?? false,
			model: entry.model,
			provider: entry.provider,
		}

		index.entries.unshift(newEntry)

		// Trim: keep pinned entries + most recent unpinned
		if (index.entries.length > MAX_INDEX_ENTRIES) {
			const pinned = index.entries.filter((e) => e.pinned)
			const unpinned = index.entries.filter((e) => !e.pinned)
			index.entries = [...pinned, ...unpinned.slice(0, MAX_INDEX_ENTRIES - pinned.length)]
		}

		await this.write(index)
		return newEntry
	}

	/**
	 * Get a single entry by taskId.
	 */
	async get(taskId: string): Promise<TaskIndexEntry | undefined> {
		const index = await this.read()
		return index.entries.find((e) => e.taskId === taskId)
	}

	/**
	 * List entries, optionally filtered by cwd.
	 */
	async list(cwd?: string): Promise<TaskIndexEntry[]> {
		const index = await this.read()
		if (!cwd) return index.entries
		return index.entries.filter((e) => e.cwd === cwd)
	}

	/**
	 * Pin a task.
	 */
	async pin(taskId: string): Promise<boolean> {
		const index = await this.read()
		const entry = index.entries.find((e) => e.taskId === taskId)
		if (!entry) return false
		entry.pinned = true
		entry.updatedAt = new Date().toISOString()
		await this.write(index)
		return true
	}

	/**
	 * Unpin a task.
	 */
	async unpin(taskId: string): Promise<boolean> {
		const index = await this.read()
		const entry = index.entries.find((e) => e.taskId === taskId)
		if (!entry) return false
		entry.pinned = false
		entry.updatedAt = new Date().toISOString()
		await this.write(index)
		return true
	}

	/**
	 * Remove a task from the index.
	 */
	async remove(taskId: string): Promise<boolean> {
		const index = await this.read()
		const before = index.entries.length
		index.entries = index.entries.filter((e) => e.taskId !== taskId)
		if (index.entries.length === before) return false
		await this.write(index)
		return true
	}

	// =========================================================================
	// Validation
	// =========================================================================

	private isValidIndex(data: unknown): data is TaskIndexFile {
		if (typeof data !== "object" || data === null) return false
		const obj = data as Record<string, unknown>
		if (obj.version !== 1) return false
		if (!Array.isArray(obj.entries)) return false
		return true
	}
}
