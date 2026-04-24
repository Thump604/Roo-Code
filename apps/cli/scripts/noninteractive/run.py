#!/usr/bin/env python3

from __future__ import annotations

import argparse
import contextlib
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path


class SmokeFailure(RuntimeError):
    pass


DEFAULT_BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8080/v1")


def resolve_default_api_key() -> str:
    candidate = os.environ.get("OPENAI_API_KEY", "").strip()
    if candidate.lower() in {"", "none", "not-needed"}:
        return "sk-local"
    return candidate


DEFAULT_API_KEY = resolve_default_api_key()


def decode_subprocess_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "ignore")
    return value


def discover_active_model(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    models_url = f"{normalized}/models"

    with urllib.request.urlopen(models_url, timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))

    data = payload.get("data")
    if not isinstance(data, list) or not data:
        raise SmokeFailure(f"model discovery returned no models from {models_url}")

    model_id = data[0].get("id")
    if not isinstance(model_id, str) or not model_id:
        raise SmokeFailure(f"model discovery returned invalid payload from {models_url}")

    return model_id


def run_streaming_baseline_case(
    context: "SmokeContext",
    case_name: str,
    prompt: str,
    expected_text: str,
    timeout: float,
) -> None:
    log_path = context.logs_root / f"{case_name}.sse.log"
    request = urllib.request.Request(
        f"{context.base_url.rstrip('/')}/chat/completions",
        data=json.dumps(
            {
                "model": context.model,
                "stream": True,
                "messages": [{"role": "user", "content": prompt}],
            }
        ).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {context.api_key}",
        },
        method="POST",
    )

    started = time.time()
    raw_lines: list[str] = []
    accumulated_content = ""

    try:
        with contextlib.closing(urllib.request.urlopen(request, timeout=timeout)) as response:
            while time.time() - started < timeout:
                line = response.readline()
                if not line:
                    break

                decoded = line.decode("utf-8", "ignore")
                raw_lines.append(decoded)
                stripped = decoded.strip()

                if not stripped or not stripped.startswith("data: "):
                    continue

                payload = stripped[6:]
                if payload == "[DONE]":
                    break

                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue

                choices = event.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue

                delta = choices[0].get("delta")
                if not isinstance(delta, dict):
                    continue

                content = delta.get("content")
                if isinstance(content, str) and content:
                    accumulated_content += content
                    if expected_text in accumulated_content:
                        log_path.write_text("".join(raw_lines), encoding="utf-8")
                        return
    except Exception as error:  # noqa: BLE001
        log_path.write_text("".join(raw_lines), encoding="utf-8")
        raise SmokeFailure(
            f"{case_name} failed during raw streaming baseline: {error}\nlog: {log_path}\n--- sse tail ---\n{''.join(raw_lines)[-2500:]}"
        ) from error

    log_path.write_text("".join(raw_lines), encoding="utf-8")
    raise SmokeFailure(
        f'{case_name} did not observe expected streamed text "{expected_text}"\nlog: {log_path}\n--- sse tail ---\n{"".join(raw_lines)[-2500:]}'
    )


@dataclass
class SmokeContext:
    cli_root: Path
    repo_root: Path
    dist_cli: Path
    base_url: str
    model: str
    api_key: str
    logs_root: Path
    timeout: float

    def build_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.setdefault("OPENAI_BASE_URL", self.base_url)
        env.setdefault("OPENAI_API_KEY", self.api_key)
        return env

    def build_cli_args(self, *extra_args: str) -> list[str]:
        return [
            "node",
            str(self.dist_cli),
            "--provider",
            "openai",
            "--base-url",
            self.base_url,
            "--api-key",
            self.api_key,
            "--model",
            self.model,
            *extra_args,
        ]


def run_print_case(context: SmokeContext, case_name: str, prompt: str, expected_text: str, timeout: float = 240.0) -> None:
    log_path = context.logs_root / f"{case_name}.log"
    try:
        proc = subprocess.run(
            context.build_cli_args("--print", "--reasoning-effort", "disabled", prompt),
            cwd=context.repo_root,
            env=context.build_env(),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        stdout = decode_subprocess_output(error.stdout)
        stderr = decode_subprocess_output(error.stderr)
        log_path.write_text(stdout + "\n--- STDERR ---\n" + stderr, encoding="utf-8")
        raise SmokeFailure(
            f"{case_name} timed out waiting for print output\nlog: {log_path}\n--- stdout tail ---\n{stdout[-2500:]}"
        ) from error

    combined = proc.stdout + "\n--- STDERR ---\n" + proc.stderr
    log_path.write_text(combined, encoding="utf-8")

    if proc.returncode != 0:
        raise SmokeFailure(
            f"{case_name} exited {proc.returncode}\nlog: {log_path}\n--- stdout tail ---\n{proc.stdout[-2500:]}\n--- stderr tail ---\n{proc.stderr[-1200:]}"
        )

    if expected_text not in proc.stdout:
        raise SmokeFailure(
            f'{case_name} did not contain expected text "{expected_text}"\nlog: {log_path}\n--- stdout tail ---\n{proc.stdout[-2500:]}'
        )


class StreamSession:
    def __init__(self, context: SmokeContext, case_name: str) -> None:
        self.context = context
        self.case_name = case_name
        self.stdout_log_path = context.logs_root / f"{case_name}.stdout.ndjson"
        self.stderr_log_path = context.logs_root / f"{case_name}.stderr.log"
        self.stdout_chunks: list[str] = []
        self.stderr_chunks: list[str] = []
        self.stdout_buffer = ""
        self.stderr_buffer = ""

        self.process = subprocess.Popen(
            context.build_cli_args(
                "--print",
                "--output-format",
                "stream-json",
                "--stdin-prompt-stream",
                "--reasoning-effort",
                "disabled",
            ),
            cwd=context.repo_root,
            env=context.build_env(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            bufsize=0,
        )

    def close(self) -> None:
        try:
            if self.process.stdin and not self.process.stdin.closed:
                self.process.stdin.close()
        except OSError:
            pass

        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)

        self.stdout_log_path.write_text("".join(self.stdout_chunks), encoding="utf-8")
        self.stderr_log_path.write_text("".join(self.stderr_chunks), encoding="utf-8")

    def __enter__(self) -> "StreamSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def send_command(self, payload: dict[str, object]) -> None:
        if not self.process.stdin:
            raise SmokeFailure("stdin stream is not available")
        self.process.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def read_events(self, timeout: float) -> list[dict[str, object]]:
        deadline = time.time() + timeout
        events: list[dict[str, object]] = []

        stdout_fd = self.process.stdout.fileno() if self.process.stdout else None
        stderr_fd = self.process.stderr.fileno() if self.process.stderr else None

        while time.time() < deadline:
            fds = [fd for fd in (stdout_fd, stderr_fd) if fd is not None]
            if not fds:
                return events

            ready, _, _ = select.select(fds, [], [], 0.2)
            if not ready:
                if self.process.poll() is not None:
                    break
                continue

            for fd in ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    continue
                if not chunk:
                    continue

                decoded = chunk.decode("utf-8", "ignore")
                if fd == stdout_fd:
                    self.stdout_chunks.append(decoded)
                    self.stdout_buffer += decoded
                    while "\n" in self.stdout_buffer:
                        line, self.stdout_buffer = self.stdout_buffer.split("\n", 1)
                        stripped = line.strip()
                        if not stripped.startswith("{"):
                            continue
                        try:
                            event = json.loads(stripped)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(event, dict):
                            events.append(event)
                else:
                    self.stderr_chunks.append(decoded)
                    self.stderr_buffer += decoded

            if self.process.poll() is not None and not ready:
                break

        return events

    def failure_message(self, message: str) -> str:
        stdout_tail = "".join(self.stdout_chunks)[-2500:]
        stderr_tail = "".join(self.stderr_chunks)[-1200:]
        return (
            f"{message}\nstdout log: {self.stdout_log_path}\nstderr log: {self.stderr_log_path}\n"
            f"--- stdout tail ---\n{stdout_tail}\n--- stderr tail ---\n{stderr_tail}"
        )


def run_stdin_stream_case(
    context: SmokeContext,
    case_name: str,
    prompt: str,
    expected_text: str,
    timeout: float = 240.0,
) -> None:
    start_request_id = f"start-{int(time.time() * 1000)}"
    shutdown_request_id = f"shutdown-{int(time.time() * 1000)}"

    saw_init = False
    saw_expected_text = False
    start_done = False
    shutdown_done = False
    shutdown_sent = False

    with StreamSession(context, case_name) as session:
        deadline = time.time() + timeout
        while time.time() < deadline:
            remaining = max(0.2, min(2.0, deadline - time.time()))
            events = session.read_events(remaining)

            if not events and session.process.poll() is not None:
                break

            for event in events:
                event_type = event.get("type")
                subtype = event.get("subtype")
                request_id = event.get("requestId")
                content = event.get("content")

                if event_type == "system" and subtype == "init" and not saw_init:
                    saw_init = True
                    session.send_command(
                        {
                            "command": "start",
                            "requestId": start_request_id,
                            "prompt": prompt,
                        }
                    )
                    continue

                if isinstance(content, str) and expected_text in content:
                    saw_expected_text = True

                if (
                    event_type == "result"
                    and event.get("done") is True
                    and request_id == start_request_id
                ):
                    start_done = True
                    if not shutdown_sent:
                        shutdown_sent = True
                        session.send_command(
                            {
                                "command": "shutdown",
                                "requestId": shutdown_request_id,
                            }
                        )
                    continue

                if (
                    event_type == "control"
                    and subtype == "done"
                    and request_id == shutdown_request_id
                ):
                    shutdown_done = True
                    break

                if event_type == "control" and subtype == "error":
                    raise SmokeFailure(
                        session.failure_message(
                            f"received control error for requestId={request_id or 'unknown'} code={event.get('code') or 'unknown'} content={content or ''}"
                        )
                    )

            if shutdown_done:
                break

        if not saw_init:
            raise SmokeFailure(session.failure_message("did not observe system:init event"))
        if not saw_expected_text:
            raise SmokeFailure(
                session.failure_message(f'did not observe expected stream content "{expected_text}"')
            )
        if not start_done:
            raise SmokeFailure(session.failure_message("did not observe completed result for start request"))
        if not shutdown_done:
            raise SmokeFailure(session.failure_message("did not observe shutdown completion"))


def case_print_live(context: SmokeContext) -> None:
    run_print_case(
        context,
        "print-live",
        "Reply with the single word PLUM and nothing else.",
        "PLUM",
        timeout=context.timeout,
    )


def case_stdin_stream_live(context: SmokeContext) -> None:
    run_stdin_stream_case(
        context,
        "stdin-stream-live",
        "Reply with the single word MANGO and nothing else.",
        "MANGO",
        timeout=context.timeout,
    )


def case_streaming_baseline_live(context: SmokeContext) -> None:
    run_streaming_baseline_case(
        context,
        "streaming-baseline-live",
        "Reply with the single word KIWI and nothing else.",
        "KIWI",
        timeout=min(20.0, context.timeout),
    )


def case_json_output_parseable(context: SmokeContext) -> None:
    """Verify that --output-format json produces valid JSON."""
    log_path = context.logs_root / "json-output-parseable.log"
    try:
        proc = subprocess.run(
            context.build_cli_args(
                "--print",
                "--output-format",
                "json",
                "--reasoning-effort",
                "disabled",
                "Reply with the single word GRAPE and nothing else.",
            ),
            cwd=context.repo_root,
            env=context.build_env(),
            capture_output=True,
            text=True,
            timeout=min(context.timeout, 120.0),
        )
    except subprocess.TimeoutExpired as error:
        stdout = decode_subprocess_output(error.stdout)
        stderr = decode_subprocess_output(error.stderr)
        log_path.write_text(stdout + "\n--- STDERR ---\n" + stderr, encoding="utf-8")
        raise SmokeFailure(
            f"json-output-parseable timed out\nlog: {log_path}\n--- stdout tail ---\n{stdout[-2500:]}"
        ) from error

    combined = proc.stdout + "\n--- STDERR ---\n" + proc.stderr
    log_path.write_text(combined, encoding="utf-8")

    if proc.returncode != 0:
        raise SmokeFailure(
            f"json-output-parseable exited {proc.returncode}\nlog: {log_path}\n--- stderr tail ---\n{proc.stderr[-1200:]}"
        )

    # Verify stdout is valid JSON
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as error:
        raise SmokeFailure(
            f"json-output-parseable stdout is not valid JSON: {error}\nlog: {log_path}\n--- stdout tail ---\n{proc.stdout[-2500:]}"
        ) from error

    # Verify the JSON contains the expected result text
    result_text = json.dumps(parsed)
    if "GRAPE" not in result_text:
        raise SmokeFailure(
            f'json-output-parseable JSON does not contain "GRAPE"\nlog: {log_path}\n--- parsed ---\n{result_text[:2500]}'
        )


def case_stdin_stream_init_and_ack(context: SmokeContext) -> None:
    """Verify stdin-stream mode emits system:init and acks start command."""
    start_request_id = f"init-ack-{int(time.time() * 1000)}"
    shutdown_request_id = f"init-ack-shutdown-{int(time.time() * 1000)}"

    with StreamSession(context, "stdin-stream-init-and-ack") as session:
        events = session.read_events(10.0)

        init_events = [e for e in events if e.get("type") == "system" and e.get("subtype") == "init"]
        if not init_events:
            raise SmokeFailure(session.failure_message("did not observe system:init event"))

        # Send start command and verify ack
        session.send_command({
            "command": "start",
            "requestId": start_request_id,
            "prompt": "Reply with HELLO",
        })

        events = session.read_events(5.0)
        ack_events = [
            e for e in events
            if e.get("type") == "control"
            and e.get("subtype") == "ack"
            and e.get("requestId") == start_request_id
        ]
        if not ack_events:
            raise SmokeFailure(session.failure_message("did not observe ack for start command"))

        # Shutdown
        session.send_command({"command": "shutdown", "requestId": shutdown_request_id})
        session.read_events(3.0)


def case_stdin_stream_wrong_approval_id(context: SmokeContext) -> None:
    """Verify that sending approve with a wrong approvalId emits approval_id_mismatch.

    SKIP: This test requires live inference to generate a tool call that
    triggers an approval_request. The deterministic fake/session controller
    path is not available in the non-interactive smoke harness.
    """
    raise SmokeFailure(
        "SKIPPED: approval-path smoke requires live inference to trigger tool "
        "calls. Use vitest unit tests for deterministic approval protocol coverage."
    )


def case_stdin_stream_cancel_no_partial(context: SmokeContext) -> None:
    """Verify that cancel during active task does not persist partial output.

    SKIP: Requires live inference and a long-running task to meaningfully
    test cancellation timing.
    """
    raise SmokeFailure(
        "SKIPPED: cancel-no-partial smoke requires a long-running task from "
        "live inference. Use vitest unit tests for deterministic coverage."
    )


def case_stdin_stream_ping_pong(context: SmokeContext) -> None:
    """Verify ping/pong roundtrip without starting a task (no inference needed)."""
    ping_request_id = f"ping-{int(time.time() * 1000)}"
    shutdown_request_id = f"ping-shutdown-{int(time.time() * 1000)}"

    with StreamSession(context, "stdin-stream-ping-pong") as session:
        events = session.read_events(10.0)

        init_events = [e for e in events if e.get("type") == "system" and e.get("subtype") == "init"]
        if not init_events:
            raise SmokeFailure(session.failure_message("did not observe system:init event"))

        # Send ping and verify pong ack + done
        session.send_command({"command": "ping", "requestId": ping_request_id})
        events = session.read_events(5.0)

        pong_ack = [
            e for e in events
            if e.get("type") == "control"
            and e.get("subtype") == "ack"
            and e.get("requestId") == ping_request_id
            and e.get("code") == "accepted"
        ]
        pong_done = [
            e for e in events
            if e.get("type") == "control"
            and e.get("subtype") == "done"
            and e.get("requestId") == ping_request_id
            and e.get("code") == "pong"
        ]
        if not pong_ack:
            raise SmokeFailure(session.failure_message("did not observe ping ack"))
        if not pong_done:
            raise SmokeFailure(session.failure_message("did not observe pong done"))

        # Shutdown
        session.send_command({"command": "shutdown", "requestId": shutdown_request_id})
        session.read_events(3.0)


def case_stdin_stream_approve_no_task(context: SmokeContext) -> None:
    """Verify approve without active task emits no_pending_approval (no inference needed)."""
    approve_request_id = f"approve-no-task-{int(time.time() * 1000)}"
    shutdown_request_id = f"approve-no-task-shutdown-{int(time.time() * 1000)}"

    with StreamSession(context, "stdin-stream-approve-no-task") as session:
        events = session.read_events(10.0)

        init_events = [e for e in events if e.get("type") == "system" and e.get("subtype") == "init"]
        if not init_events:
            raise SmokeFailure(session.failure_message("did not observe system:init event"))

        # Send approve without any pending approval
        session.send_command({
            "command": "approve",
            "requestId": approve_request_id,
            "approvalId": "approval-nonexistent",
        })
        events = session.read_events(5.0)

        error_events = [
            e for e in events
            if e.get("type") == "control"
            and e.get("subtype") == "error"
            and e.get("code") == "no_pending_approval"
        ]
        if not error_events:
            raise SmokeFailure(
                session.failure_message("did not observe no_pending_approval error for orphan approve")
            )

        # Shutdown
        session.send_command({"command": "shutdown", "requestId": shutdown_request_id})
        session.read_events(3.0)


def case_stdin_stream_shutdown_clean(context: SmokeContext) -> None:
    """Verify clean shutdown sequence: ack + done for shutdown command (no inference needed)."""
    shutdown_request_id = f"shutdown-{int(time.time() * 1000)}"

    with StreamSession(context, "stdin-stream-shutdown-clean") as session:
        events = session.read_events(10.0)

        init_events = [e for e in events if e.get("type") == "system" and e.get("subtype") == "init"]
        if not init_events:
            raise SmokeFailure(session.failure_message("did not observe system:init event"))

        session.send_command({"command": "shutdown", "requestId": shutdown_request_id})
        events = session.read_events(5.0)

        shutdown_ack = [
            e for e in events
            if e.get("type") == "control"
            and e.get("subtype") == "ack"
            and e.get("requestId") == shutdown_request_id
        ]
        shutdown_done = [
            e for e in events
            if e.get("type") == "control"
            and e.get("subtype") == "done"
            and e.get("requestId") == shutdown_request_id
            and e.get("code") == "shutdown_requested"
        ]
        if not shutdown_ack:
            raise SmokeFailure(session.failure_message("did not observe shutdown ack"))
        if not shutdown_done:
            raise SmokeFailure(session.failure_message("did not observe shutdown done"))


CASES = {
    "streaming-baseline-live": case_streaming_baseline_live,
    "print-live": case_print_live,
    "stdin-stream-live": case_stdin_stream_live,
    "json-output-parseable": case_json_output_parseable,
    "stdin-stream-init-and-ack": case_stdin_stream_init_and_ack,
    "stdin-stream-ping-pong": case_stdin_stream_ping_pong,
    "stdin-stream-approve-no-task": case_stdin_stream_approve_no_task,
    "stdin-stream-shutdown-clean": case_stdin_stream_shutdown_clean,
    "stdin-stream-wrong-approval-id": case_stdin_stream_wrong_approval_id,
    "stdin-stream-cancel-no-partial": case_stdin_stream_cancel_no_partial,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Mesa CLI non-interactive smoke tests")
    parser.add_argument("--list", action="store_true", help="List available smoke cases")
    parser.add_argument("--match", help="Only run cases containing this substring")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="OpenAI-compatible base URL to test against")
    parser.add_argument("--timeout", type=float, default=120.0, help="Per-case timeout in seconds")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cli_root = Path(__file__).resolve().parents[2]
    repo_root = cli_root.parents[1]
    logs_root = Path(tempfile.mkdtemp(prefix="mesa-noninteractive-smoke-logs-"))
    dist_cli = cli_root / "dist/index.js"

    if shutil.which("node") is None:
        raise SmokeFailure("node is required for non-interactive smoke tests")

    if not dist_cli.exists():
        raise SmokeFailure(f"CLI dist entry not found: {dist_cli}")

    context = SmokeContext(
        cli_root=cli_root,
        repo_root=repo_root,
        dist_cli=dist_cli,
        base_url=args.base_url,
        model=discover_active_model(args.base_url),
        api_key=DEFAULT_API_KEY,
        logs_root=logs_root,
        timeout=args.timeout,
    )

    selected = [
        (name, case)
        for name, case in CASES.items()
        if not args.match or args.match.lower() in name.lower()
    ]

    if not selected:
        raise SmokeFailure(f'no non-interactive smoke cases matched "{args.match}"')

    if args.list:
        print("Available non-interactive smoke cases:", flush=True)
        for name, _ in selected:
            print(f"- {name}", flush=True)
        print(f"\nBase URL: {context.base_url}", flush=True)
        print(f"Active model: {context.model}", flush=True)
        return 0

    failures: list[tuple[str, str]] = []

    print(f"Base URL: {context.base_url}", flush=True)
    print(f"Active model: {context.model}", flush=True)
    print(f"Per-case timeout: {context.timeout:.0f}s", flush=True)
    print(f"Logs: {logs_root}", flush=True)

    for name, case in selected:
        print(f"\n[RUN] {name}", flush=True)
        started = time.time()
        try:
            case(context)
        except Exception as error:  # noqa: BLE001
            failures.append((name, str(error)))
            print(f"[FAIL] {name}: {error}", flush=True)
        else:
            duration = time.time() - started
            print(f"[PASS] {name} ({duration:.1f}s)", flush=True)

    print(f"\nSummary: {len(selected) - len(failures)}/{len(selected)} passed", flush=True)
    if failures:
        print("\nFailures:", flush=True)
        for name, error in failures:
            print(f"- {name}: {error}", flush=True)
        return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeFailure as error:
        print(f"[FAIL] {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
