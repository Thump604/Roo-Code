/**
 * Tests for mesa tasks CLI commands.
 */

import fs from "fs/promises"
import os from "os"
import path from "path"

import { TaskIndex } from "@/core/task-index/index.js"

import { tasksList, tasksShow, tasksPin, tasksUnpin, tasksRemove } from "../tasks.js"

// Mock getConfigDir to use a temp directory
let tempDir: string

vi.mock("@/lib/storage/config-dir.js", () => ({
	getConfigDir: () => tempDir,
}))

async function seedIndex(entries: Array<{ taskId: string; cwd?: string; promptSummary?: string; pinned?: boolean }>) {
	const index = new TaskIndex(tempDir)
	for (const e of entries) {
		const result = await index.upsert({
			taskId: e.taskId,
			cwd: e.cwd || "/test/workspace",
			promptSummary: e.promptSummary || `Summary for ${e.taskId}`,
			taskStatus: "completed",
		})
		if (e.pinned) {
			await index.pin(result.taskId)
		}
	}
}

describe("mesa tasks commands", () => {
	let stdoutChunks: string[]
	const originalWrite = process.stdout.write

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesa-tasks-cmd-test-"))
		stdoutChunks = []
		process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
			stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString())
			return true
		}) as typeof process.stdout.write
	})

	afterEach(() => {
		process.stdout.write = originalWrite
	})

	describe("tasksList", () => {
		it("outputs empty list as JSON", async () => {
			await tasksList({ format: "json", workspace: "/test/workspace" })
			const output = JSON.parse(stdoutChunks.join(""))
			expect(output.tasks).toEqual([])
		})

		it("outputs seeded tasks as JSON", async () => {
			await seedIndex([{ taskId: "t1" }, { taskId: "t2" }])
			await tasksList({ format: "json", workspace: "/test/workspace" })
			const output = JSON.parse(stdoutChunks.join(""))
			expect(output.tasks).toHaveLength(2)
		})

		it("outputs text format", async () => {
			await seedIndex([{ taskId: "t1" }])
			await tasksList({ format: "text", workspace: "/test/workspace" })
			const text = stdoutChunks.join("")
			expect(text).toContain("t1")
			expect(text).toContain("1 task(s)")
		})
	})

	describe("tasksShow", () => {
		it("outputs task details as JSON", async () => {
			await seedIndex([{ taskId: "t1", promptSummary: "Test task" }])
			await tasksShow("t1", { format: "json" })
			const output = JSON.parse(stdoutChunks.join(""))
			expect(output.taskId).toBe("t1")
			expect(output.promptSummary).toBe("Test task")
		})

		it("throws for nonexistent task", async () => {
			await expect(tasksShow("nonexistent", {})).rejects.toThrow("Task not found")
		})
	})

	describe("tasksPin", () => {
		it("pins a task", async () => {
			await seedIndex([{ taskId: "t1" }])
			await tasksPin("t1")
			const index = new TaskIndex(tempDir)
			const entry = await index.get("t1")
			expect(entry?.pinned).toBe(true)
		})

		it("throws for nonexistent task", async () => {
			await expect(tasksPin("nonexistent")).rejects.toThrow("Task not found")
		})
	})

	describe("tasksUnpin", () => {
		it("unpins a task", async () => {
			await seedIndex([{ taskId: "t1", pinned: true }])
			await tasksUnpin("t1")
			const index = new TaskIndex(tempDir)
			const entry = await index.get("t1")
			expect(entry?.pinned).toBe(false)
		})
	})

	describe("tasksRemove", () => {
		it("removes a task", async () => {
			await seedIndex([{ taskId: "t1" }])
			await tasksRemove("t1")
			const index = new TaskIndex(tempDir)
			const entry = await index.get("t1")
			expect(entry).toBeUndefined()
		})

		it("throws for nonexistent task", async () => {
			await expect(tasksRemove("nonexistent")).rejects.toThrow("Task not found")
		})
	})
})
