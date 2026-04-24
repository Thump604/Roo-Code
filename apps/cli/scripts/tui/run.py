#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


class SmokeFailure(RuntimeError):
    pass


ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]")
DEFAULT_BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8080/v1")
READ_POLL_INTERVAL = 0.2


def resolve_default_api_key() -> str:
    candidate = os.environ.get("OPENAI_API_KEY", "").strip()
    if candidate.lower() in {"", "none", "not-needed"}:
        return "sk-local"
    return candidate


DEFAULT_API_KEY = resolve_default_api_key()


def strip_ansi(text: str) -> str:
    clean = ANSI_ESCAPE_RE.sub("", text.replace("\r", ""))
    return "".join(ch for ch in clean if ch == "\n" or ord(ch) >= 32)


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


@dataclass
class SmokeContext:
    cli_root: Path
    repo_root: Path
    dist_cli: Path
    extension_dir: Path
    base_url: str
    model: str
    api_key: str
    logs_root: Path
    seed_vscode_mock: Path | None = None

    def seed_home(self, home: Path) -> None:
        if not self.seed_vscode_mock or not self.seed_vscode_mock.exists():
            return

        destination = home / ".vscode-mock"
        if destination.exists():
            return

        shutil.copytree(self.seed_vscode_mock, destination)

    def build_env(self, home: Path) -> dict[str, str]:
        env = dict(os.environ)
        env.update(
            {
                "HOME": str(home),
                "USERPROFILE": str(home),
                "TERM": "xterm-256color",
                "COLUMNS": "120",
                "LINES": "40",
                "ROO_EXTENSION_PATH": str(self.extension_dir),
            }
        )
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


class TuiSession:
    def __init__(
        self,
        context: SmokeContext,
        case_name: str,
        home: Path,
        extra_args: list[str] | None = None,
    ) -> None:
        self.context = context
        self.case_name = case_name
        self.home = home
        self.extra_args = extra_args or []
        self.raw_chunks: list[bytes] = []
        self.text_buffer = ""
        self.raw_log_path = context.logs_root / f"{case_name}.raw.log"
        self.text_log_path = context.logs_root / f"{case_name}.txt"

        master_fd, slave_fd = pty.openpty()
        self.master_fd = master_fd
        env = context.build_env(home)

        self.process = subprocess.Popen(
            context.build_cli_args(*self.extra_args),
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=context.repo_root,
            env=env,
        )
        os.close(slave_fd)

    def close(self) -> None:
        try:
            self.send_bytes(b"\x03")
            time.sleep(0.2)
            self.send_bytes(b"\x03")
            self.read_for(0.5)
        except OSError:
            pass

        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)

        try:
            os.close(self.master_fd)
        except OSError:
            pass

        self.raw_log_path.write_bytes(b"".join(self.raw_chunks))
        self.text_log_path.write_text(self.text_buffer, encoding="utf-8")

    def __enter__(self) -> "TuiSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def send_bytes(self, data: bytes) -> None:
        os.write(self.master_fd, data)

    def send_text(self, text: str) -> None:
        self.send_bytes(text.encode("utf-8"))

    def press_enter(self) -> None:
        time.sleep(0.3)
        self.send_bytes(b"\r")

    def press_down(self) -> None:
        self.send_bytes(b"\x1b[B")

    def press_tab(self) -> None:
        self.send_bytes(b"\t")

    def press_y(self) -> None:
        self.send_bytes(b"y")

    def read_for(self, seconds: float) -> str:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.master_fd], [], [], READ_POLL_INTERVAL)
            if self.master_fd not in ready:
                continue
            try:
                chunk = os.read(self.master_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.raw_chunks.append(chunk)
            self.text_buffer += strip_ansi(chunk.decode("utf-8", "ignore"))
        return self.text_buffer

    def wait_for_text(self, text: str, timeout: float, description: str | None = None) -> None:
        self.wait_for(lambda buffer: text in buffer, timeout, description or f'text "{text}"')

    def wait_for_regex(self, pattern: str, timeout: float, description: str | None = None) -> None:
        compiled = re.compile(pattern, re.MULTILINE | re.DOTALL)
        self.wait_for(lambda buffer: compiled.search(buffer) is not None, timeout, description or f"regex /{pattern}/")

    def wait_for_assistant_reply(self, text: str, timeout: float, description: str | None = None) -> None:
        pattern = rf"Mesa said:[^\n]*\n\s*{re.escape(text)}\b"
        self.wait_for_regex(pattern, timeout, description or f'assistant reply "{text}"')

    def wait_for_assistant_contains(self, text: str, timeout: float, description: str | None = None) -> None:
        pattern = rf"Mesa said:[\s\S]*?{re.escape(text)}"
        self.wait_for_regex(pattern, timeout, description or f'assistant reply containing "{text}"')

    def submit_prompt(self, text: str, timeout: float = 20) -> None:
        self.send_text(text)
        self.read_for(0.5)
        self.press_enter()

        try:
            self.wait_for_text("You said:", min(timeout, 5), 'text "You said:" after carriage-return submit')
            return
        except SmokeFailure:
            self.send_bytes(b"\n")
            self.wait_for_text("You said:", timeout, 'text "You said:" after newline submit')

    def wait_for(self, predicate: Callable[[str], bool], timeout: float, description: str) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.read_for(1.0)
            if predicate(self.text_buffer):
                return

        raise SmokeFailure(self.failure_message(f"timed out waiting for {description}"))

    def failure_message(self, message: str) -> str:
        tail = self.text_buffer[-2500:]
        return (
            f"{message}\n"
            f"normalized log: {self.text_log_path}\n"
            f"raw log: {self.raw_log_path}\n"
            f"--- transcript tail ---\n{tail}"
        )


def case_launch_and_render(context: SmokeContext) -> None:
    with tempfile.TemporaryDirectory(prefix="mesa-tui-launch-") as home_dir:
        home = Path(home_dir)
        context.seed_home(home)
        with TuiSession(context, "launch-and-render", home) as session:
            session.wait_for_text("Mesa Code CLI", 15)
            session.wait_for_text("? for shortcuts", 15)


def case_submit_prompt_live(context: SmokeContext) -> None:
    with tempfile.TemporaryDirectory(prefix="mesa-tui-submit-") as home_dir:
        home = Path(home_dir)
        context.seed_home(home)
        with TuiSession(context, "submit-prompt-live", home, ["--reasoning-effort", "disabled"]) as session:
            session.wait_for_text("Mesa Code CLI", 15)
            token = "KIWI"
            session.submit_prompt(f"Reply with the single word {token}.")
            session.wait_for_assistant_reply(token, 120, "final assistant reply")


def case_approval_flow_live(context: SmokeContext) -> None:
    with tempfile.TemporaryDirectory(prefix="mesa-tui-approval-") as home_dir:
        home = Path(home_dir)
        context.seed_home(home)
        with TuiSession(
            context,
            "approval-flow-live",
            home,
            ["--require-approval", "--reasoning-effort", "disabled"],
        ) as session:
            session.wait_for_text("Mesa Code CLI", 15)
            session.submit_prompt("Use read_file to read AGENTS.md and reply with its first line only.")
            session.wait_for_text("readFile", 120, "tool approval request")
            session.wait_for_text("Press Y to approve, N to reject", 15)
            session.press_y()
            session.wait_for_assistant_contains("# AGENTS.md", 120, "post-approval assistant reply")


def case_autocomplete_picker_navigation(context: SmokeContext) -> None:
    with tempfile.TemporaryDirectory(prefix="mesa-tui-picker-") as home_dir:
        home = Path(home_dir)
        context.seed_home(home)
        with TuiSession(context, "autocomplete-picker-navigation", home) as session:
            session.wait_for_text("Mesa Code CLI", 15)
            session.send_text("/in")
            session.wait_for_text("/init - Analyze codebase", 15)
            session.press_tab()
            session.wait_for_text("› /init", 15)
            session.wait_for_text("? for shortcuts", 15)


def case_resume_existing_session(context: SmokeContext) -> None:
    with tempfile.TemporaryDirectory(prefix="mesa-tui-resume-") as home_dir:
        home = Path(home_dir)
        context.seed_home(home)
        seed_prompt = "Reply with the single word PEAR."

        with TuiSession(context, "resume-existing-session-seed", home, ["--reasoning-effort", "disabled"]) as session:
            session.wait_for_text("Mesa Code CLI", 15)
            session.submit_prompt(seed_prompt)
            session.wait_for_assistant_reply("PEAR", 120, "seed assistant reply")

        with TuiSession(
            context,
            "resume-existing-session",
            home,
            ["--reasoning-effort", "disabled", "--continue"],
        ) as session:
            session.wait_for_text("Mesa Code CLI", 15)
            session.read_for(5)
            session.submit_prompt("What single word did I ask you to reply with previously? Answer with that word only.")
            session.wait_for_assistant_reply("PEAR", 120, "resumed-session assistant reply")


CASES: dict[str, Callable[[SmokeContext], None]] = {
    "launch-and-render": case_launch_and_render,
    "submit-prompt-live": case_submit_prompt_live,
    "approval-flow-live": case_approval_flow_live,
    "autocomplete-picker-navigation": case_autocomplete_picker_navigation,
    "resume-existing-session": case_resume_existing_session,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Mesa CLI TUI smoke tests")
    parser.add_argument("--list", action="store_true", help="List available TUI smoke cases")
    parser.add_argument("--match", help="Only run cases containing this substring")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="OpenAI-compatible base URL to test against")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cli_root = Path(__file__).resolve().parents[2]
    repo_root = cli_root.parents[1]
    logs_root = Path(tempfile.mkdtemp(prefix="mesa-tui-smoke-logs-"))
    dist_cli = cli_root / "dist/index.js"
    extension_dir = repo_root / "src/dist"

    if shutil.which("node") is None:
        raise SmokeFailure("node is required for TUI smoke tests")

    if not dist_cli.exists():
        raise SmokeFailure(f"CLI dist entry not found: {dist_cli}")

    if not (extension_dir / "extension.js").exists():
        raise SmokeFailure(f"Extension bundle not found: {extension_dir / 'extension.js'}")

    context = SmokeContext(
        cli_root=cli_root,
        repo_root=repo_root,
        dist_cli=dist_cli,
        extension_dir=extension_dir,
        base_url=args.base_url,
        model=discover_active_model(args.base_url),
        api_key=DEFAULT_API_KEY,
        logs_root=logs_root,
        seed_vscode_mock=Path(os.environ["HOME"]) / ".vscode-mock" if "HOME" in os.environ else None,
    )

    selected = [
        (name, case)
        for name, case in CASES.items()
        if not args.match or args.match.lower() in name.lower()
    ]

    if not selected:
        raise SmokeFailure(f'no TUI smoke cases matched "{args.match}"')

    if args.list:
        print("Available TUI smoke cases:")
        for name, _ in selected:
            print(f"- {name}")
        print(f"\nBase URL: {context.base_url}")
        print(f"Active model: {context.model}")
        return 0

    failures: list[tuple[str, str]] = []

    print(f"Base URL: {context.base_url}")
    print(f"Active model: {context.model}")
    print(f"Logs: {logs_root}")

    for name, case in selected:
        print(f"\n[RUN] {name}")
        started = time.time()
        try:
            case(context)
        except Exception as error:  # noqa: BLE001
            failures.append((name, str(error)))
            print(f"[FAIL] {name}: {error}")
        else:
            duration = time.time() - started
            print(f"[PASS] {name} ({duration:.1f}s)")

    print(f"\nSummary: {len(selected) - len(failures)}/{len(selected)} passed")
    if failures:
        print("\nFailures:")
        for name, error in failures:
            print(f"- {name}: {error}")
        return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeFailure as error:
        print(f"[FAIL] {error}", file=sys.stderr)
        raise SystemExit(1)
