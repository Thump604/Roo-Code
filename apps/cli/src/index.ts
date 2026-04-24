import { Command } from "commander"

import { DEFAULT_FLAGS } from "@/types/constants.js"
import { VERSION } from "@/lib/utils/version.js"
import {
	run,
	listCommands,
	listModes,
	listModels,
	listSessions,
	tasksList,
	tasksShow,
	tasksPin,
	tasksUnpin,
	tasksRemove,
	doctor,
	useRuntime,
	upgrade,
} from "@/commands/index.js"

const program = new Command()

program
	.name("mesa")
	.description(
		"Mesa Code CLI - local-first coding agent for self-hosted AI runtimes; use -p/--print for non-interactive output",
	)
	.version(VERSION)
	.enablePositionalOptions()
	.passThroughOptions()

program
	.argument("[prompt]", "Your prompt")
	.option("--prompt-file <path>", "Read prompt from a file instead of command line argument")
	.option("--create-with-session-id <session-id>", "Create a new task with a specific session ID (must be a UUID)")
	.option("--session-id <session-id>", "Resume a specific task by session ID")
	.option("-c, --continue", "Resume the most recent task in the current workspace", false)
	.option("-w, --workspace <path>", "Workspace directory path (defaults to current working directory)")
	.option("-p, --print", "Print response and exit (non-interactive mode)", false)
	.option(
		"--stdin-prompt-stream",
		"Read NDJSON commands from stdin (requires --print and --output-format stream-json)",
		false,
	)
	.option(
		"--signal-only-exit",
		"Do not exit from normal completion/errors; only terminate on SIGINT/SIGTERM (intended for stdin stream harnesses)",
		false,
	)
	.option("-d, --debug", "Enable debug output (includes detailed debug information)", false)
	.option("-a, --require-approval", "Require manual approval for actions", false)
	.option("-k, --api-key <key>", "API key for the LLM provider")
	.option("--provider <provider>", "API provider (openai, anthropic, openrouter, openai-native, etc.)")
	.option("--protocol <protocol>", "API standard for local/self-hosted endpoints (openai or anthropic)")
	.option("--runtime <runtime>", "Local runtime profile (llama.cpp or vllm-mlx)")
	.option("--base-url <url>", "Base URL for OpenAI- or Anthropic-compatible endpoints")
	.option("-m, --model <model>", "Model to use", DEFAULT_FLAGS.model)
	.option("--mode <mode>", "Mode to start in (code, architect, ask, debug, etc.)", DEFAULT_FLAGS.mode)
	.option("--terminal-shell <path>", "Absolute path to shell executable for inline terminal commands")
	.option(
		"-r, --reasoning-effort <effort>",
		"Reasoning effort level (unspecified, disabled, none, minimal, low, medium, high, xhigh)",
		DEFAULT_FLAGS.reasoningEffort,
	)
	.option(
		"--consecutive-mistake-limit <limit>",
		"Consecutive error/repetition limit before guidance prompt (0 disables the limit)",
		(value) => Number.parseInt(value, 10),
	)
	.option("--exit-on-error", "Exit on API request errors instead of retrying", false)
	.option("--ephemeral", "Run without persisting state (uses temporary storage)", false)
	.option("--oneshot", "Exit upon task completion", false)
	.option(
		"--output-format <format>",
		'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)',
		"text",
	)
	.action(run)

const listCommand = program
	.command("list")
	.description("List CLI-native commands, modes, models, or sessions")
	.enablePositionalOptions()
	.passThroughOptions()

const applyListOptions = (command: Command) =>
	command
		.option("-w, --workspace <path>", "Workspace directory path (defaults to current working directory)")
		.option("-k, --api-key <key>", "API key for the selected provider")
		.option("--provider <provider>", "API provider for provider-aware model listing")
		.option("--protocol <protocol>", "API standard for local/self-hosted endpoints")
		.option("--runtime <runtime>", "Local runtime profile (llama.cpp or vllm-mlx)")
		.option("--base-url <url>", "Base URL for OpenAI- or Anthropic-compatible endpoints")
		.option("--format <format>", 'Output format: "json" (default) or "text"', "json")
		.option("-d, --debug", "Enable debug output", false)

const runListAction = async (action: () => Promise<void>) => {
	try {
		await action()
		process.exit(0)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[CLI] Error: ${message}`)
		process.exit(1)
	}
}

const runUpgradeAction = async (action: () => Promise<void>) => {
	try {
		await action()
		process.exit(0)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[CLI] Error: ${message}`)
		process.exit(1)
	}
}

applyListOptions(listCommand.command("commands").description("List available slash commands")).action(
	async (options: Parameters<typeof listCommands>[0]) => {
		await runListAction(() => listCommands(options))
	},
)

applyListOptions(listCommand.command("modes").description("List available modes")).action(
	async (options: Parameters<typeof listModes>[0]) => {
		await runListAction(() => listModes(options))
	},
)

applyListOptions(
	listCommand.command("models").description("List available models for the current provider/runtime"),
).action(async (options: Parameters<typeof listModels>[0]) => {
	await runListAction(() => listModels(options))
})

applyListOptions(listCommand.command("sessions").description("List task sessions")).action(
	async (options: Parameters<typeof listSessions>[0]) => {
		await runListAction(() => listSessions(options))
	},
)

program
	.command("upgrade")
	.description("Upgrade Mesa Code CLI to the latest version")
	.action(async () => {
		await runUpgradeAction(() => upgrade())
	})

program
	.command("doctor")
	.description("Probe a local runtime profile and normalize its observability surface")
	.option("-k, --api-key <key>", "API key for the selected local endpoint")
	.option("--provider <provider>", "API provider override for protocol resolution")
	.option("--protocol <protocol>", "API standard for local/self-hosted endpoints (openai or anthropic)")
	.option("--runtime <runtime>", "Local runtime profile (llama.cpp or vllm-mlx)")
	.option("--base-url <url>", "Base URL for the local runtime endpoint")
	.option("--format <format>", 'Output format: "text" (default) or "json"', "text")
	.action(async (options: Parameters<typeof doctor>[0]) => {
		await runListAction(() => doctor(options))
	})

program
	.command("use")
	.description("Select, bootstrap, and verify a local runtime/model lane")
	.argument("[target]", "Preset alias or model identifier to activate")
	.option("-k, --api-key <key>", "API key for the selected local endpoint")
	.option("--provider <provider>", "API provider override for protocol resolution")
	.option("--protocol <protocol>", "API standard for local/self-hosted endpoints (openai or anthropic)")
	.option("--runtime <runtime>", "Local runtime profile (llama.cpp or vllm-mlx)")
	.option("--base-url <url>", "Base URL for the local runtime endpoint")
	.option("--ops-base-url <url>", "Base URL for the local ops control plane")
	.option("--preset <preset>", "Preset alias to activate through the ops control plane")
	.option("-m, --model <model>", "Model or Hugging Face repo to activate on the selected runtime")
	.option("--format <format>", 'Output format: "text" (default) or "json"', "text")
	.option("--plan", "Only print the model source and storage plan; do not save or launch anything")
	.option("--no-install-runtime", "Do not install the runtime automatically if the binary is missing")
	.option("--no-start", "Only save the profile; do not launch or swap the managed runtime")
	.option("--storage-root <path>", "Preferred storage root for planning remote model placement")
	.option(
		"--allow-external-storage",
		"Allow planning against storage that appears to be external or removable",
		false,
	)
	.option("--wait-seconds <seconds>", "How long to wait for the runtime to become ready before returning", "20")
	.action(async (target: string | undefined, options: Parameters<typeof useRuntime>[1]) => {
		await runListAction(() => useRuntime(target, options))
	})

// ---------------------------------------------------------------------------
// mesa tasks
// ---------------------------------------------------------------------------

const tasksCommand = program.command("tasks").description("Manage the local task index")

tasksCommand
	.command("list")
	.description("List recent tasks")
	.option("-w, --workspace <path>", "Workspace directory path (defaults to current working directory)")
	.option("--format <format>", 'Output format: "json" (default) or "text"', "json")
	.action(async (options: Parameters<typeof tasksList>[0]) => {
		await runListAction(() => tasksList(options))
	})

tasksCommand
	.command("show")
	.description("Show details for a specific task")
	.argument("<id>", "Task ID")
	.option("--format <format>", 'Output format: "json" (default) or "text"', "json")
	.action(async (taskId: string, options: Parameters<typeof tasksShow>[1]) => {
		await runListAction(() => tasksShow(taskId, options))
	})

tasksCommand
	.command("pin")
	.description("Pin a task to prevent it from being trimmed")
	.argument("<id>", "Task ID")
	.action(async (taskId: string) => {
		await runListAction(() => tasksPin(taskId))
	})

tasksCommand
	.command("unpin")
	.description("Unpin a task")
	.argument("<id>", "Task ID")
	.action(async (taskId: string) => {
		await runListAction(() => tasksUnpin(taskId))
	})

tasksCommand
	.command("remove")
	.description("Remove a task from the index")
	.argument("<id>", "Task ID")
	.action(async (taskId: string) => {
		await runListAction(() => tasksRemove(taskId))
	})

program.parse()
