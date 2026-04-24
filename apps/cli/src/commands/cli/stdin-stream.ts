import { createInterface } from "readline"

import {
	rooCliCommandNames,
	type RooCliCommandName,
	type RooCliInputCommand,
	type RooCliStartCommand,
	type RooCliRespondCommand,
} from "@roo-code/types"

import { isRecord } from "@/lib/utils/guards.js"
import { isValidSessionId } from "@/lib/utils/session-id.js"
import type { CliSessionController } from "@/runtime/index.js"

import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"
import { StdinStreamSession } from "./stdin-stream-session.js"
export { shouldSendMessageAsAskResponse } from "./stdin-stream-session.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StdinStreamCommandName = RooCliCommandName

export type StdinStreamCommand = RooCliInputCommand

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export const VALID_STDIN_COMMANDS = new Set<StdinStreamCommandName>(rooCliCommandNames)

export function parseStdinStreamCommand(line: string, lineNumber: number): StdinStreamCommand {
	let parsed: unknown

	try {
		parsed = JSON.parse(line)
	} catch {
		throw new Error(`stdin command line ${lineNumber}: invalid JSON`)
	}

	if (!isRecord(parsed)) {
		throw new Error(`stdin command line ${lineNumber}: expected JSON object`)
	}

	const commandRaw = parsed.command
	const requestIdRaw = parsed.requestId

	if (typeof commandRaw !== "string") {
		throw new Error(`stdin command line ${lineNumber}: missing string "command"`)
	}

	if (!VALID_STDIN_COMMANDS.has(commandRaw as StdinStreamCommandName)) {
		throw new Error(
			`stdin command line ${lineNumber}: unsupported command "${commandRaw}" (expected ${rooCliCommandNames.join("|")})`,
		)
	}

	if (typeof requestIdRaw !== "string" || requestIdRaw.trim().length === 0) {
		throw new Error(`stdin command line ${lineNumber}: missing non-empty string "requestId"`)
	}

	const command = commandRaw as StdinStreamCommandName
	const requestId = requestIdRaw.trim()

	// respond command requires a text field
	if (command === "respond") {
		const textRaw = parsed.text

		if (typeof textRaw !== "string") {
			throw new Error(`stdin command line ${lineNumber}: "respond" requires string "text"`)
		}

		return { command, requestId, text: textRaw } as RooCliRespondCommand
	}

	if (command === "start" || command === "message") {
		const promptRaw = parsed.prompt

		if (typeof promptRaw !== "string" || promptRaw.trim().length === 0) {
			throw new Error(`stdin command line ${lineNumber}: "${command}" requires non-empty string "prompt"`)
		}

		const imagesRaw = parsed.images
		let images: string[] | undefined

		if (imagesRaw !== undefined) {
			if (!Array.isArray(imagesRaw) || !imagesRaw.every((image) => typeof image === "string")) {
				throw new Error(`stdin command line ${lineNumber}: "${command}" images must be an array of strings`)
			}

			images = imagesRaw
		}

		if (command === "start") {
			const taskIdRaw = parsed.taskId
			let taskId: string | undefined

			if (taskIdRaw !== undefined) {
				if (typeof taskIdRaw !== "string" || taskIdRaw.trim().length === 0) {
					throw new Error(`stdin command line ${lineNumber}: "start" taskId must be a non-empty string`)
				}
				taskId = taskIdRaw.trim()

				if (!isValidSessionId(taskId)) {
					throw new Error(`stdin command line ${lineNumber}: "start" taskId must be a valid UUID`)
				}
			}

			if (isRecord(parsed.configuration)) {
				return {
					command,
					requestId,
					prompt: promptRaw,
					...(taskId !== undefined ? { taskId } : {}),
					...(images !== undefined ? { images } : {}),
					configuration: parsed.configuration as RooCliStartCommand["configuration"],
				}
			}

			return {
				command,
				requestId,
				prompt: promptRaw,
				...(taskId !== undefined ? { taskId } : {}),
				...(images !== undefined ? { images } : {}),
			}
		}

		return {
			command,
			requestId,
			prompt: promptRaw,
			...(images !== undefined ? { images } : {}),
		}
	}

	return { command, requestId }
}

// ---------------------------------------------------------------------------
// NDJSON stdin reader
// ---------------------------------------------------------------------------

async function* readCommandsFromStdinNdjson(): AsyncGenerator<StdinStreamCommand> {
	const lineReader = createInterface({
		input: process.stdin,
		crlfDelay: Infinity,
		terminal: false,
	})

	let lineNumber = 0

	try {
		for await (const line of lineReader) {
			lineNumber += 1
			const trimmed = line.trim()
			if (!trimmed) {
				continue
			}
			yield parseStdinStreamCommand(trimmed, lineNumber)
		}
	} finally {
		lineReader.close()
	}
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface StdinStreamModeOptions {
	sessionController: CliSessionController
	jsonEmitter: JsonEventEmitter
	setStreamRequestId: (id: string | undefined) => void
}

export async function runStdinStreamMode({
	sessionController,
	jsonEmitter,
	setStreamRequestId,
}: StdinStreamModeOptions) {
	let hasReceivedStdinCommand = false
	let shouldShutdown = false
	const streamSession = new StdinStreamSession({
		sessionController,
		jsonEmitter,
		setStreamRequestId,
		isShuttingDown: () => shouldShutdown,
	})

	const offClientError = sessionController.onError((error) => {
		streamSession.handleClientError(error)
	})

	const offRuntimeMessage = sessionController.onMessage((message) => {
		streamSession.handleRuntimeMessage(message)
	})

	const offTaskCompleted = sessionController.onTaskCompleted((event) => {
		streamSession.handleTaskCompleted(event)
	})

	try {
		for await (const stdinCommand of readCommandsFromStdinNdjson()) {
			hasReceivedStdinCommand = true

			const fatalStreamError = streamSession.getFatalError()
			if (fatalStreamError) {
				throw fatalStreamError
			}

			switch (stdinCommand.command) {
				case "start":
					await streamSession.handleStartCommand(stdinCommand)
					break

				case "message":
					await streamSession.handleMessageCommand(stdinCommand)
					break

				case "cancel":
					streamSession.handleCancelCommand(stdinCommand)
					break

				case "ping":
					jsonEmitter.emitControl({
						subtype: "ack",
						requestId: stdinCommand.requestId,
						command: "ping",
						taskId: streamSession.getLatestTaskId(),
						content: "pong",
						code: "accepted",
						success: true,
					})
					jsonEmitter.emitControl({
						subtype: "done",
						requestId: stdinCommand.requestId,
						command: "ping",
						taskId: streamSession.getLatestTaskId(),
						content: "pong",
						code: "pong",
						success: true,
					})
					break

				case "approve":
					streamSession.handleApproveCommand(stdinCommand)
					break

				case "reject":
					streamSession.handleRejectCommand(stdinCommand)
					break

				case "respond":
					streamSession.handleRespondCommand(stdinCommand)
					break

				case "shutdown":
					jsonEmitter.emitControl({
						subtype: "ack",
						requestId: stdinCommand.requestId,
						command: "shutdown",
						taskId: streamSession.getLatestTaskId(),
						content: "shutdown requested",
						code: "accepted",
						success: true,
					})
					jsonEmitter.emitControl({
						subtype: "done",
						requestId: stdinCommand.requestId,
						command: "shutdown",
						taskId: streamSession.getLatestTaskId(),
						content: "shutting down process",
						code: "shutdown_requested",
						success: true,
					})
					shouldShutdown = true
					break
			}

			if (shouldShutdown) {
				break
			}
		}

		await streamSession.finalizeAfterStdinClosed(hasReceivedStdinCommand)
	} finally {
		offClientError()
		offRuntimeMessage()
		offTaskCompleted()
	}
}
