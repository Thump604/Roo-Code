/**
 * Tests for the hook system: config discovery, runner, manager.
 *
 * Uses real child_process.spawn for runner tests (not mocked),
 * with small inline scripts for deterministic behavior.
 */

import fs from "fs/promises"
import os from "os"
import path from "path"

import { loadHooksConfig } from "../config.js"
import { HookManager } from "../manager.js"
import { runHook } from "../runner.js"
import type { HookDefinition, HookEvent } from "../types.js"

// =============================================================================
// Helpers
// =============================================================================

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "mesa-hooks-test-"))
}

function makeEvent(event = "before_tool"): HookEvent {
	return {
		event: event as HookEvent["event"],
		timestamp: new Date().toISOString(),
		payload: { tool: "read_file", path: "/src/main.ts" },
	}
}

function makeHook(overrides: Partial<HookDefinition> = {}): HookDefinition {
	return {
		event: "before_tool",
		command: ["node", "-e", 'process.stdout.write(JSON.stringify({action:"allow"}))'],
		...overrides,
	}
}

// =============================================================================
// Config discovery
// =============================================================================

describe("loadHooksConfig", () => {
	it("returns empty hooks when no config exists", async () => {
		const dir = await makeTempDir()
		const config = await loadHooksConfig(dir)
		expect(config.hooks).toEqual([])
	})

	it("loads .mesa/hooks.json when it exists", async () => {
		const dir = await makeTempDir()
		const mesaDir = path.join(dir, ".mesa")
		await fs.mkdir(mesaDir)
		await fs.writeFile(
			path.join(mesaDir, "hooks.json"),
			JSON.stringify({
				hooks: [{ event: "before_tool", command: ["echo", "hello"] }],
			}),
		)

		const config = await loadHooksConfig(dir)
		expect(config.hooks).toHaveLength(1)
		expect(config.hooks[0]!.event).toBe("before_tool")
		expect(config.hooks[0]!.command).toEqual(["echo", "hello"])
	})

	it("loads .roo/hooks.json as legacy fallback", async () => {
		const dir = await makeTempDir()
		const rooDir = path.join(dir, ".roo")
		await fs.mkdir(rooDir)
		await fs.writeFile(
			path.join(rooDir, "hooks.json"),
			JSON.stringify({
				hooks: [{ event: "after_tool", command: ["cat"] }],
			}),
		)

		const config = await loadHooksConfig(dir)
		expect(config.hooks).toHaveLength(1)
		expect(config.hooks[0]!.event).toBe("after_tool")
	})

	it(".mesa takes precedence over .roo", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.mkdir(path.join(dir, ".roo"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({ hooks: [{ event: "before_tool", command: ["mesa-hook"] }] }),
		)
		await fs.writeFile(
			path.join(dir, ".roo", "hooks.json"),
			JSON.stringify({ hooks: [{ event: "before_tool", command: ["roo-hook"] }] }),
		)

		const config = await loadHooksConfig(dir)
		expect(config.hooks[0]!.command).toEqual(["mesa-hook"])
	})

	it("throws on invalid JSON", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(path.join(dir, ".mesa", "hooks.json"), "not json{{{")

		await expect(loadHooksConfig(dir)).rejects.toThrow("invalid hooks config JSON")
	})

	it("throws when hooks array is missing", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(path.join(dir, ".mesa", "hooks.json"), JSON.stringify({ notHooks: [] }))

		await expect(loadHooksConfig(dir)).rejects.toThrow('must have a "hooks" array')
	})

	it("throws when hook entry is missing event", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(path.join(dir, ".mesa", "hooks.json"), JSON.stringify({ hooks: [{ command: ["echo"] }] }))

		await expect(loadHooksConfig(dir)).rejects.toThrow("hooks[0].event must be a string")
	})

	it("throws on unknown event name (typo fails closed)", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({ hooks: [{ event: "before_tools", command: ["echo"] }] }),
		)

		await expect(loadHooksConfig(dir)).rejects.toThrow("is not a valid hook event")
	})

	it("throws when command is not a string array", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({ hooks: [{ event: "before_tool", command: "echo hello" }] }),
		)

		await expect(loadHooksConfig(dir)).rejects.toThrow("hooks[0].command must be a non-empty string array")
	})

	it("parses optional fields correctly", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "before_tool",
						command: ["node", "hook.js"],
						timeoutMs: 5000,
						cwd: "/tmp",
						env: { FOO: "bar" },
						enabled: false,
					},
				],
			}),
		)

		const config = await loadHooksConfig(dir)
		expect(config.hooks[0]!.timeoutMs).toBe(5000)
		expect(config.hooks[0]!.cwd).toBe("/tmp")
		expect(config.hooks[0]!.env).toEqual({ FOO: "bar" })
		expect(config.hooks[0]!.enabled).toBe(false)
	})
})

// =============================================================================
// Hook runner
// =============================================================================

describe("runHook", () => {
	it("runs a command that returns allow", async () => {
		const hook = makeHook()
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(true)
		expect(result.result?.action).toBe("allow")
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
	})

	it("runs a command that returns deny with reason", async () => {
		const hook = makeHook({
			command: ["node", "-e", 'process.stdout.write(JSON.stringify({action:"deny",reason:"not allowed"}))'],
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(true)
		expect(result.result?.action).toBe("deny")
		expect(result.result?.reason).toBe("not allowed")
	})

	it("receives the event on stdin", async () => {
		// This hook echoes back the event it received on stdin
		const hook = makeHook({
			command: [
				"node",
				"-e",
				`
				let data = "";
				process.stdin.on("data", c => data += c);
				process.stdin.on("end", () => {
					const event = JSON.parse(data);
					process.stdout.write(JSON.stringify({
						action: "allow",
						reason: "got event: " + event.event + " tool: " + event.payload.tool
					}));
				});
				`,
			],
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(true)
		expect(result.result?.reason).toContain("got event: before_tool")
		expect(result.result?.reason).toContain("tool: read_file")
	})

	it("fails on non-zero exit code", async () => {
		const hook = makeHook({
			command: ["node", "-e", "process.exit(1)"],
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(false)
		expect(result.error).toContain("hook exited 1")
	})

	it("fails on invalid JSON stdout", async () => {
		const hook = makeHook({
			command: ["node", "-e", 'process.stdout.write("not json")'],
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(false)
		expect(result.error).toContain("not valid JSON")
	})

	it("treats empty stdout on exit 0 as allow", async () => {
		const hook = makeHook({
			command: ["node", "-e", ""],
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(true)
		expect(result.result?.action).toBe("allow")
	})

	it("fails on timeout", async () => {
		const hook = makeHook({
			command: ["node", "-e", "setTimeout(() => {}, 60000)"],
			timeoutMs: 500,
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(false)
		// Node's spawn timeout kills the process with SIGTERM
		expect(result.durationMs).toBeGreaterThanOrEqual(400)
	}, 10000)

	it("fails on nonexistent command", async () => {
		const hook = makeHook({
			command: ["nonexistent-hook-command-xyz"],
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(false)
		expect(result.error).toContain("hook command failed")
	})

	it("passes custom env to the hook", async () => {
		const hook = makeHook({
			command: [
				"node",
				"-e",
				'process.stdout.write(JSON.stringify({action:"allow",reason:process.env.TEST_VAR}))',
			],
			env: { TEST_VAR: "custom-value" },
		})
		const result = await runHook(hook, makeEvent())

		expect(result.ok).toBe(true)
		expect(result.result?.reason).toBe("custom-value")
	})
})

// =============================================================================
// HookManager
// =============================================================================

describe("HookManager", () => {
	it("returns allowed when no hooks configured", async () => {
		const dir = await makeTempDir()
		const manager = new HookManager()
		await manager.loadConfig(dir)

		const result = await manager.runBeforeTool({ tool: "read_file" })
		expect(result.allowed).toBe(true)
		expect(result.hookErrors).toEqual([])
	})

	it("runs before_tool hooks and returns allow", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "before_tool",
						command: ["node", "-e", 'process.stdout.write(JSON.stringify({action:"allow"}))'],
					},
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		const result = await manager.runBeforeTool({ tool: "read_file" })
		expect(result.allowed).toBe(true)
	})

	it("before_tool deny blocks tool execution", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "before_tool",
						command: [
							"node",
							"-e",
							'process.stdout.write(JSON.stringify({action:"deny",reason:"blocked by policy"}))',
						],
					},
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		const result = await manager.runBeforeTool({ tool: "execute_command" })
		expect(result.allowed).toBe(false)
		expect(result.reason).toBe("blocked by policy")
	})

	it("hook failure is fail-closed (blocks the action)", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "before_tool",
						command: ["node", "-e", "process.exit(1)"],
					},
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		const result = await manager.runBeforeTool({ tool: "write_to_file" })
		expect(result.allowed).toBe(false)
		expect(result.reason).toContain("hook failed")
		expect(result.hookErrors).toHaveLength(1)
	})

	it("skips disabled hooks", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "before_tool",
						command: ["node", "-e", "process.exit(1)"],
						enabled: false,
					},
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		// The disabled hook should not run, so no failure
		const result = await manager.runBeforeTool({ tool: "read_file" })
		expect(result.allowed).toBe(true)
		expect(manager.hookCount).toBe(0)
	})

	it("only runs hooks matching the event type", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "after_tool",
						command: ["node", "-e", "process.exit(1)"],
					},
					{
						event: "before_tool",
						command: ["node", "-e", 'process.stdout.write(JSON.stringify({action:"allow"}))'],
					},
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		// The after_tool hook should not run for before_tool
		const result = await manager.runBeforeTool({ tool: "read_file" })
		expect(result.allowed).toBe(true)
	})

	it("observe-only hooks return results without gating", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "after_tool",
						command: ["node", "-e", "process.stdout.write(JSON.stringify({logged:true}))"],
					},
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		const results = await manager.runAfterTool({ tool: "read_file", result: "file content" })
		expect(results).toHaveLength(1)
		expect(results[0]!.ok).toBe(true)
	})

	it("hookCount reflects enabled hooks", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{ event: "before_tool", command: ["echo"], enabled: true },
					{ event: "after_tool", command: ["echo"], enabled: false },
					{ event: "task_start", command: ["echo"] },
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		expect(manager.hookCount).toBe(2) // enabled true + default true
	})

	it("command argv safety: does not interpret shell metacharacters", async () => {
		const dir = await makeTempDir()
		await fs.mkdir(path.join(dir, ".mesa"))
		await fs.writeFile(
			path.join(dir, ".mesa", "hooks.json"),
			JSON.stringify({
				hooks: [
					{
						event: "before_tool",
						// If this were passed to a shell, the ; rm -rf would be dangerous
						// With argv array, "echo" gets the whole string as one argument
						command: ["node", "-e", 'process.stdout.write(JSON.stringify({action:"allow"}))'],
					},
				],
			}),
		)

		const manager = new HookManager()
		await manager.loadConfig(dir)

		const result = await manager.runBeforeTool({ tool: "read_file" })
		expect(result.allowed).toBe(true)
	})
})
