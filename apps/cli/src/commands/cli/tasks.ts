/**
 * CLI commands for the local task index.
 *
 * mesa tasks list [--workspace <path>] [--format json|text]
 * mesa tasks show <id> [--format json|text]
 * mesa tasks pin <id>
 * mesa tasks unpin <id>
 * mesa tasks remove <id>
 */

import path from "path"

import { TaskIndex } from "@/core/task-index/index.js"
import { getConfigDir } from "@/lib/storage/config-dir.js"
import type { TaskIndexEntry } from "@/core/task-index/types.js"

type TasksFormat = "json" | "text"

function parseFormat(raw?: string): TasksFormat {
	if (raw === "text") return "text"
	return "json"
}

function resolveWorkspace(workspace?: string): string {
	return workspace ? path.resolve(workspace) : process.cwd()
}

function outputJson(data: unknown): void {
	process.stdout.write(JSON.stringify(data, null, 2) + "\n")
}

function formatEntry(entry: TaskIndexEntry): string {
	const pin = entry.pinned ? " [pinned]" : ""
	const model = entry.model ? ` (${entry.model})` : ""
	return `${entry.taskId}  ${entry.taskStatus.padEnd(10)} ${entry.promptSummary}${model}${pin}`
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface TasksListOptions {
	workspace?: string
	format?: string
}

export async function tasksList(options: TasksListOptions): Promise<void> {
	const format = parseFormat(options.format)
	const cwd = resolveWorkspace(options.workspace)
	const index = new TaskIndex(getConfigDir())
	const entries = await index.list(cwd)

	if (format === "json") {
		outputJson({ workspace: cwd, tasks: entries })
		return
	}

	if (entries.length === 0) {
		process.stdout.write("No tasks found for this workspace.\n")
		return
	}

	process.stdout.write(`Tasks for ${cwd}:\n\n`)
	for (const entry of entries) {
		process.stdout.write(`  ${formatEntry(entry)}\n`)
	}
	process.stdout.write(`\n${entries.length} task(s)\n`)
}

export interface TasksShowOptions {
	format?: string
}

export async function tasksShow(taskId: string, options: TasksShowOptions): Promise<void> {
	const format = parseFormat(options.format)
	const index = new TaskIndex(getConfigDir())
	const entry = await index.get(taskId)

	if (!entry) {
		throw new Error(`Task not found: ${taskId}`)
	}

	if (format === "json") {
		outputJson(entry)
		return
	}

	process.stdout.write(`Task: ${entry.taskId}\n`)
	process.stdout.write(`Status: ${entry.taskStatus}\n`)
	process.stdout.write(`Summary: ${entry.promptSummary}\n`)
	process.stdout.write(`Created: ${entry.createdAt}\n`)
	process.stdout.write(`Updated: ${entry.updatedAt}\n`)
	process.stdout.write(`Workspace: ${entry.cwd}\n`)
	if (entry.model) process.stdout.write(`Model: ${entry.model}\n`)
	if (entry.provider) process.stdout.write(`Provider: ${entry.provider}\n`)
	process.stdout.write(`Pinned: ${entry.pinned}\n`)
}

export async function tasksPin(taskId: string): Promise<void> {
	const index = new TaskIndex(getConfigDir())
	const ok = await index.pin(taskId)
	if (!ok) throw new Error(`Task not found: ${taskId}`)
	process.stdout.write(`Pinned: ${taskId}\n`)
}

export async function tasksUnpin(taskId: string): Promise<void> {
	const index = new TaskIndex(getConfigDir())
	const ok = await index.unpin(taskId)
	if (!ok) throw new Error(`Task not found: ${taskId}`)
	process.stdout.write(`Unpinned: ${taskId}\n`)
}

export async function tasksRemove(taskId: string): Promise<void> {
	const index = new TaskIndex(getConfigDir())
	const ok = await index.remove(taskId)
	if (!ok) throw new Error(`Task not found: ${taskId}`)
	process.stdout.write(`Removed: ${taskId}\n`)
}
