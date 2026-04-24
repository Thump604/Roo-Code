#!/usr/bin/env node

/**
 * Deterministic OpenAI-compatible fixture server for CLI/TUI smoke testing.
 *
 * Serves canned responses — no real inference. Supports named scenarios
 * selected by the FIXTURE_SCENARIO env var (default: "plain-text").
 *
 * Implements:
 *   GET  /v1/models             — model list
 *   POST /v1/chat/completions   — streaming SSE responses
 *
 * Binds to localhost on an ephemeral port and prints a JSON boot line to
 * stdout: {"port":<number>,"scenario":"<name>"}
 *
 * Scenarios:
 *   plain-text        — streams a normal text answer
 *   reasoning-tags    — streams <think>hidden</think>visible text
 *   tool-approval     — streams a tool_call that triggers approval
 *   slow-stream       — streams tokens at 500ms intervals (for cancel tests)
 *   malformed-stream  — sends a malformed SSE chunk partway through
 */

import http from "node:http"

const SCENARIO = process.env.FIXTURE_SCENARIO || "plain-text"
const MODEL_ID = "fixture-model"

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseChunk(id, content, finishReason) {
	const delta = {}
	if (content !== undefined) delta.content = content
	const choice = { index: 0, delta }
	if (finishReason) choice.finish_reason = finishReason
	const payload = {
		id: `chatcmpl-fixture-${id}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: MODEL_ID,
		choices: [choice],
	}
	return `data: ${JSON.stringify(payload)}\n\n`
}

function sseToolCallChunk(id, toolCallIndex, fnName, fnArgs, finishReason) {
	const delta = {}
	if (fnName !== undefined || fnArgs !== undefined) {
		delta.tool_calls = [
			{
				index: toolCallIndex,
				...(fnName !== undefined ? { id: `call_fixture_${toolCallIndex}`, type: "function", function: { name: fnName, arguments: "" } } : {}),
				...(fnArgs !== undefined ? { function: { arguments: fnArgs } } : {}),
			},
		]
	}
	const choice = { index: 0, delta }
	if (finishReason) choice.finish_reason = finishReason
	return `data: ${JSON.stringify({
		id: `chatcmpl-fixture-${id}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: MODEL_ID,
		choices: [choice],
	})}\n\n`
}

function sseDone() {
	return "data: [DONE]\n\n"
}

// ---------------------------------------------------------------------------
// Scenario handlers — each writes SSE to the response and ends it
// ---------------------------------------------------------------------------

async function scenarioPlainText(_req, res) {
	const tokens = ["Hello", " from", " the", " fixture", " server", "."]
	for (let i = 0; i < tokens.length; i++) {
		res.write(sseChunk(i, tokens[i], i === tokens.length - 1 ? "stop" : null))
	}
	res.write(sseDone())
	res.end()
}

async function scenarioReasoningTags(_req, res) {
	// Stream reasoning tags followed by visible content
	const parts = [
		{ content: "<think>" },
		{ content: "hidden reasoning content" },
		{ content: "</think>" },
		{ content: "Visible" },
		{ content: " answer" },
		{ content: " text", finish: "stop" },
	]
	for (let i = 0; i < parts.length; i++) {
		res.write(sseChunk(i, parts[i].content, parts[i].finish || null))
	}
	res.write(sseDone())
	res.end()
}

async function scenarioToolApproval(_req, res) {
	// Stream a tool call that requires manual approval.
	// Uses write_to_file which requires write permission, not auto-approved by default.
	const fnName = "write_to_file"
	const argsChunks = [
		'{"path":',
		'"/tmp/fi',
		'xture-te',
		'st.txt",',
		'"content',
		'":"fixtu',
		're test ',
		'output"}',
	]

	// First chunk: role + tool call start
	res.write(sseToolCallChunk(0, 0, fnName, undefined, null))

	// Argument chunks
	for (let i = 0; i < argsChunks.length; i++) {
		const isLast = i === argsChunks.length - 1
		res.write(sseToolCallChunk(i + 1, 0, undefined, argsChunks[i], isLast ? "tool_calls" : null))
	}

	res.write(sseDone())
	res.end()
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function scenarioSlowStream(req, res) {
	const tokens = ["Slow", " stream", " token", " one", " token", " two", " token", " three", " done"]
	for (let i = 0; i < tokens.length; i++) {
		if (res.destroyed) return
		res.write(sseChunk(i, tokens[i], i === tokens.length - 1 ? "stop" : null))
		await sleep(500)
	}
	if (!res.destroyed) {
		res.write(sseDone())
		res.end()
	}
}

async function scenarioMalformedStream(_req, res) {
	// Send a couple of valid chunks, then a malformed one, then stop
	res.write(sseChunk(0, "Good", null))
	res.write(sseChunk(1, " start", null))
	// Malformed: not valid JSON after "data: "
	res.write("data: {invalid json no closing brace\n\n")
	// One more valid chunk to see if client recovers or fails
	res.write(sseChunk(3, " after-malformed", "stop"))
	res.write(sseDone())
	res.end()
}

const SCENARIOS = {
	"plain-text": scenarioPlainText,
	"reasoning-tags": scenarioReasoningTags,
	"tool-approval": scenarioToolApproval,
	"slow-stream": scenarioSlowStream,
	"malformed-stream": scenarioMalformedStream,
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleModels(req, res) {
	res.writeHead(200, { "Content-Type": "application/json" })
	res.end(
		JSON.stringify({
			object: "list",
			data: [{ id: MODEL_ID, object: "model", created: 1700000000, owned_by: "fixture" }],
		}),
	)
}

function handleChatCompletions(req, res) {
	// Read body (we mostly ignore it, but drain it)
	let body = ""
	req.on("data", (chunk) => {
		body += chunk
	})
	req.on("end", () => {
		// Allow per-request scenario override via X-Fixture-Scenario header
		const requestScenario = req.headers["x-fixture-scenario"] || SCENARIO

		const handler = SCENARIOS[requestScenario]
		if (!handler) {
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: { message: `unknown scenario: ${requestScenario}`, type: "invalid_request_error" } }))
			return
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		})

		handler(req, res).catch((err) => {
			if (!res.destroyed) {
				res.end()
			}
		})
	})
}

function requestHandler(req, res) {
	const url = new URL(req.url, `http://${req.headers.host}`)
	const pathname = url.pathname

	if (req.method === "GET" && pathname === "/v1/models") {
		return handleModels(req, res)
	}
	if (req.method === "POST" && pathname === "/v1/chat/completions") {
		return handleChatCompletions(req, res)
	}

	res.writeHead(404, { "Content-Type": "application/json" })
	res.end(JSON.stringify({ error: { message: "not found", type: "not_found" } }))
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = http.createServer(requestHandler)

server.listen(0, "127.0.0.1", () => {
	const addr = server.address()
	const bootInfo = { port: addr.port, scenario: SCENARIO, model: MODEL_ID }
	process.stdout.write(JSON.stringify(bootInfo) + "\n")
})

// Graceful shutdown
process.on("SIGTERM", () => {
	server.close(() => process.exit(0))
})
process.on("SIGINT", () => {
	server.close(() => process.exit(0))
})
