/**
 * Hook config discovery.
 *
 * Searches for hooks config in this order:
 *   1. .mesa/hooks.json (preferred)
 *   2. .roo/hooks.json (legacy fallback)
 *
 * If neither exists, hooks are disabled (empty config).
 */

import fs from "fs/promises"
import path from "path"

import type { HookDefinition, HooksConfig } from "./types.js"
import { VALID_HOOK_EVENT_NAMES } from "./types.js"

const MESA_HOOKS_FILE = ".mesa/hooks.json"
const LEGACY_HOOKS_FILE = ".roo/hooks.json"

/**
 * Load hooks config from the workspace directory.
 *
 * Returns an empty hooks array if no config file exists.
 * Throws on invalid JSON or schema violations.
 */
export async function loadHooksConfig(workspaceDir: string): Promise<HooksConfig> {
	const mesaPath = path.join(workspaceDir, MESA_HOOKS_FILE)
	const legacyPath = path.join(workspaceDir, LEGACY_HOOKS_FILE)

	// Try .mesa first
	let configPath: string | null = null
	try {
		await fs.access(mesaPath)
		configPath = mesaPath
	} catch {
		// .mesa/hooks.json does not exist
	}

	// Fall back to .roo
	if (!configPath) {
		try {
			await fs.access(legacyPath)
			configPath = legacyPath
		} catch {
			// Neither exists — hooks disabled
			return { hooks: [] }
		}
	}

	const raw = await fs.readFile(configPath, "utf-8")
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new Error(`invalid hooks config JSON at ${configPath}: ${err}`)
	}

	return validateHooksConfig(parsed, configPath)
}

function validateHooksConfig(data: unknown, filePath: string): HooksConfig {
	if (typeof data !== "object" || data === null || !Array.isArray((data as Record<string, unknown>).hooks)) {
		throw new Error(`hooks config at ${filePath} must have a "hooks" array`)
	}

	const hooks: HookDefinition[] = []
	const rawHooks = (data as Record<string, unknown>).hooks as unknown[]

	for (let i = 0; i < rawHooks.length; i++) {
		const hook = rawHooks[i]
		if (typeof hook !== "object" || hook === null) {
			throw new Error(`hooks[${i}] at ${filePath} must be an object`)
		}

		const h = hook as Record<string, unknown>

		if (typeof h.event !== "string") {
			throw new Error(`hooks[${i}].event must be a string at ${filePath}`)
		}
		if (!VALID_HOOK_EVENT_NAMES.has(h.event)) {
			throw new Error(
				`hooks[${i}].event "${h.event}" is not a valid hook event at ${filePath}. ` +
					`Valid events: ${[...VALID_HOOK_EVENT_NAMES].join(", ")}`,
			)
		}
		if (!Array.isArray(h.command) || h.command.length === 0 || !h.command.every((c) => typeof c === "string")) {
			throw new Error(`hooks[${i}].command must be a non-empty string array at ${filePath}`)
		}

		hooks.push({
			event: h.event as HookDefinition["event"],
			command: h.command as string[],
			timeoutMs: typeof h.timeoutMs === "number" ? h.timeoutMs : undefined,
			cwd: typeof h.cwd === "string" ? h.cwd : undefined,
			env: typeof h.env === "object" && h.env !== null ? (h.env as Record<string, string>) : undefined,
			enabled: typeof h.enabled === "boolean" ? h.enabled : undefined,
		})
	}

	return { hooks }
}
