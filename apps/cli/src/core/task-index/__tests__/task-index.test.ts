/**
 * Tests for the task index: CRUD, pin/unpin, corrupted index recovery.
 */

import fs from "fs/promises"
import os from "os"
import path from "path"

import { TaskIndex } from "../store.js"

// =============================================================================
// Helpers
// =============================================================================

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "mesa-task-index-test-"))
}

function makeEntry(taskId: string, overrides: Record<string, unknown> = {}) {
	return {
		taskId,
		cwd: "/home/user/project",
		promptSummary: `Task ${taskId} prompt`,
		taskStatus: "running" as const,
		model: "fixture-model",
		provider: "openai",
		...overrides,
	}
}

// =============================================================================
// Tests
// =============================================================================

describe("TaskIndex", () => {
	describe("read", () => {
		it("returns empty index when file does not exist", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)
			const data = await index.read()

			expect(data.version).toBe(1)
			expect(data.entries).toEqual([])
		})

		it("reads a valid index file", async () => {
			const dir = await makeTempDir()
			await fs.writeFile(
				path.join(dir, "task-index.json"),
				JSON.stringify({
					version: 1,
					entries: [
						{
							taskId: "t1",
							createdAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
							cwd: "/tmp",
							promptSummary: "test",
							taskStatus: "completed",
							pinned: false,
						},
					],
				}),
			)

			const index = new TaskIndex(dir)
			const data = await index.read()
			expect(data.entries).toHaveLength(1)
			expect(data.entries[0]!.taskId).toBe("t1")
		})

		it("returns empty index on corrupted JSON", async () => {
			const dir = await makeTempDir()
			await fs.writeFile(path.join(dir, "task-index.json"), "not json{{{")

			const index = new TaskIndex(dir)
			const data = await index.read()
			expect(data.entries).toEqual([])
		})

		it("returns empty index on invalid structure", async () => {
			const dir = await makeTempDir()
			await fs.writeFile(path.join(dir, "task-index.json"), JSON.stringify({ version: 99, entries: "bad" }))

			const index = new TaskIndex(dir)
			const data = await index.read()
			expect(data.entries).toEqual([])
		})
	})

	describe("upsert", () => {
		it("creates a new entry", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const entry = await index.upsert(makeEntry("task-1"))
			expect(entry.taskId).toBe("task-1")
			expect(entry.pinned).toBe(false)
			expect(entry.createdAt).toBeDefined()
			expect(entry.updatedAt).toBeDefined()

			const data = await index.read()
			expect(data.entries).toHaveLength(1)
		})

		it("updates an existing entry", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1"))
			const updated = await index.upsert(makeEntry("task-1", { taskStatus: "completed" }))

			expect(updated.taskStatus).toBe("completed")
			const data = await index.read()
			expect(data.entries).toHaveLength(1)
		})

		it("new entries go to the front", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1"))
			await index.upsert(makeEntry("task-2"))

			const data = await index.read()
			expect(data.entries[0]!.taskId).toBe("task-2")
			expect(data.entries[1]!.taskId).toBe("task-1")
		})

		it("validates and truncates caller-provided summary", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const longSummary = "a".repeat(200) + "\nwith newline"
			const entry = await index.upsert(makeEntry("task-1", { promptSummary: longSummary }))

			expect(entry.promptSummary.length).toBeLessThanOrEqual(120)
			expect(entry.promptSummary).not.toContain("\n")
		})

		it("uses placeholder for empty summary", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const entry = await index.upsert(makeEntry("task-1", { promptSummary: "" }))
			expect(entry.promptSummary).toBe("(no summary)")
		})

		it("uses placeholder for whitespace-only summary", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const entry = await index.upsert(makeEntry("task-1", { promptSummary: "   " }))
			expect(entry.promptSummary).toBe("(no summary)")
		})

		it("creates directory if it does not exist", async () => {
			const dir = path.join(await makeTempDir(), "nested", "dir")
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1"))
			const data = await index.read()
			expect(data.entries).toHaveLength(1)
		})
	})

	describe("get", () => {
		it("returns entry by taskId", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1"))
			const entry = await index.get("task-1")
			expect(entry?.taskId).toBe("task-1")
		})

		it("returns undefined for missing taskId", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const entry = await index.get("nonexistent")
			expect(entry).toBeUndefined()
		})
	})

	describe("list", () => {
		it("returns all entries", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1"))
			await index.upsert(makeEntry("task-2"))

			const entries = await index.list()
			expect(entries).toHaveLength(2)
		})

		it("filters by cwd", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1", { cwd: "/project-a" }))
			await index.upsert(makeEntry("task-2", { cwd: "/project-b" }))

			const entries = await index.list("/project-a")
			expect(entries).toHaveLength(1)
			expect(entries[0]!.taskId).toBe("task-1")
		})
	})

	describe("pin/unpin", () => {
		it("pins a task", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1"))
			const result = await index.pin("task-1")
			expect(result).toBe(true)

			const entry = await index.get("task-1")
			expect(entry?.pinned).toBe(true)
		})

		it("unpins a task", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1", { pinned: true }))
			// The upsert sets pinned via the entry
			await index.pin("task-1")
			const result = await index.unpin("task-1")
			expect(result).toBe(true)

			const entry = await index.get("task-1")
			expect(entry?.pinned).toBe(false)
		})

		it("pin returns false for nonexistent task", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const result = await index.pin("nonexistent")
			expect(result).toBe(false)
		})

		it("unpin returns false for nonexistent task", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const result = await index.unpin("nonexistent")
			expect(result).toBe(false)
		})
	})

	describe("remove", () => {
		it("removes an entry", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			await index.upsert(makeEntry("task-1"))
			const result = await index.remove("task-1")
			expect(result).toBe(true)

			const data = await index.read()
			expect(data.entries).toHaveLength(0)
		})

		it("returns false for nonexistent task", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			const result = await index.remove("nonexistent")
			expect(result).toBe(false)
		})
	})

	describe("corrupted index recovery", () => {
		it("recovers from corrupted file on upsert", async () => {
			const dir = await makeTempDir()
			await fs.writeFile(path.join(dir, "task-index.json"), "corrupted{{{")

			const index = new TaskIndex(dir)
			const entry = await index.upsert(makeEntry("task-1"))
			expect(entry.taskId).toBe("task-1")

			// The corrupted file should have been replaced
			const data = await index.read()
			expect(data.entries).toHaveLength(1)
		})

		it("recovers from wrong version on upsert", async () => {
			const dir = await makeTempDir()
			await fs.writeFile(path.join(dir, "task-index.json"), JSON.stringify({ version: 99 }))

			const index = new TaskIndex(dir)
			const entry = await index.upsert(makeEntry("task-1"))
			expect(entry.taskId).toBe("task-1")
		})
	})

	describe("index trimming", () => {
		it("trims to MAX_INDEX_ENTRIES, keeping pinned", async () => {
			const dir = await makeTempDir()
			const index = new TaskIndex(dir)

			// Pin one entry
			await index.upsert(makeEntry("pinned-task"))
			await index.pin("pinned-task")

			// Add MAX_INDEX_ENTRIES more unpinned entries
			for (let i = 0; i < 500; i++) {
				await index.upsert(makeEntry(`task-${i}`))
			}

			const data = await index.read()
			// Should be <= MAX_INDEX_ENTRIES
			expect(data.entries.length).toBeLessThanOrEqual(500)
			// Pinned entry should survive
			const pinnedEntry = data.entries.find((e) => e.taskId === "pinned-task")
			expect(pinnedEntry).toBeDefined()
			expect(pinnedEntry?.pinned).toBe(true)
		})
	})
})
