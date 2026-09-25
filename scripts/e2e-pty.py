#!/usr/bin/env python3
"""CI-capable reality test: drive tsforge in a REAL pseudo-terminal against a REAL
(local, deterministic) OpenAI-compatible model server, and assert on the real byte
stream. No GUI, no external model — so it runs anywhere (Linux CI included) and is
deterministic, yet it exercises the real process, the real ANSI stream, the real
policy layer, and the real tool execution — none of the in-process fakes that have
given false confidence before.

It is the headless sibling of scripts/e2e-iterm-plan-mode.py (which is the
high-fidelity GUI pass on macOS + a real model). What this CANNOT test is GUI
resize-reflow (that needs a real terminal emulator) — that stays the iTerm2 suite's job.

Scenario: the plan-first lifecycle.
  boot (plan mode default) -> ask for a write
    -> model returns a fenced JSON plan (no tools); assert NO file written (read-only)
  'approve' -> harness binds the plan; model returns a `create` tool call
    -> assert the file is written with the right content, tools were unlocked

Run: python3 scripts/e2e-pty.py
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    content_chunks,
    read_until,
    reap,
    spawn_tsforge,
    start_stub_server,
    toolcall_chunks,
)

SUM_BODY = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n"


def _decide(messages):
    """The whole scenario logic — pick the response from the conversation state."""
    last = messages[-1] if messages else {}
    if last.get("role") == "tool":
        tool_text = last.get("content") or ""
        # present_plan result — stop and wait for the human; do not create yet.
        if "Plan presented" in tool_text or "awaiting approve" in tool_text.lower():
            return content_chunks("Plan is ready — approve to build.")
        # The create already ran; end the drive loop with a plain final answer.
        return content_chunks("Done — created src/sum.ts.")

    joined = " ".join(
        m.get("content") or "" for m in messages if isinstance(m.get("content"), str)
    )
    if "plan is APPROVED" in joined:
        return toolcall_chunks("create", {"file": "src/sum.ts", "content": SUM_BODY})

    # Product path: present_plan paints the PLAN card (type approve footer).
    return toolcall_chunks(
        "present_plan",
        {
            "goal": "Add sum helper",
            "items": [
                {
                    "title": "Create src/sum.ts",
                    "detail": "Export sum(a,b) returning a+b",
                }
            ],
        },
    )


def spawn(port, extra_env):
    """Fork tsforge into a real pty pointed at the stub server."""
    work = tempfile.mkdtemp(prefix="tsforge-pty-")
    # A project folder: plan-first applies to folders with code (a folder with
    # no code — research notes — starts in normal mode).
    with open(os.path.join(work, "package.json"), "w") as f:
        f.write('{"name":"pty-e2e","private":true}\n')
    home = tempfile.mkdtemp(prefix="tsforge-home-")
    pid, master = spawn_tsforge(port, extra_env, cwd=work, home=home)
    return pid, master, work


def scenario_plan_lifecycle(port):
    """Plan-first lifecycle end to end (readline input; deterministic)."""
    print("\n# plan-first lifecycle")
    ok = True
    pid, master, work = spawn(port, {"TSFORGE_BASIC_INPUT": "1"})
    target = os.path.join(work, "src", "sum.ts")
    try:
        got, buf = read_until(
            master, lambda b: "plan mode (default)" in b or "PLAN" in b, 60
        )
        print(f"  [{'PASS' if got else 'FAIL'}] boots into plan mode by default (real pty)")
        ok &= got

        os.write(
            master,
            b"Create a new file src/sum.ts exporting a sum(a,b) that returns a+b.\r",
        )
        got, buf = read_until(
            master,
            lambda b: "type approve" in b.lower()
            or "plan is ready" in b.lower()
            or "Create src/sum.ts" in b
            or "Add sum helper" in b,
            60,
            buf,
        )
        wrote_early = os.path.exists(target)
        print(f"  [{'PASS' if got else 'FAIL'}] model returned a plan in plan mode")
        print(
            f"  [{'PASS' if not wrote_early else 'FAIL'}] NO file written during plan mode "
            f"(read-only)   file_exists={wrote_early}"
        )
        ok &= got and (not wrote_early)

        os.write(master, b"approve\r")
        got, buf = read_until(master, lambda b: "plan approved" in b.lower(), 30, buf)
        print(f"  [{'PASS' if got else 'FAIL'}] 'approve' hit the approval gate")
        ok &= got

        deadline = time.monotonic() + 30
        while not os.path.exists(target) and time.monotonic() < deadline:
            # Keep draining the stream (and preserve it in buf for debugging) while
            # we wait for the write; strings are immutable so we must reassign buf.
            _, buf = read_until(master, lambda _b: False, 0.5, buf)
        wrote = os.path.exists(target)
        print(f"  [{'PASS' if wrote else 'FAIL'}] file written AFTER approve   file_exists={wrote}")
        ok &= wrote
        if wrote:
            with open(target) as f:
                body = f.read()
            good = "function sum" in body
            print(f"  [{'PASS' if good else 'FAIL'}] implemented file contains `function sum`")
            ok &= good
    finally:
        reap(pid, master)
    return ok


def scenario_mode_cycle(port):
    """Shift+Tab cycles the mode in the REAL editor; the status bar chip flips.
    Fresh buf per wait so we detect the NEW chip, not the one already on screen."""
    print("\n# Shift+Tab mode cycling (real editor)")
    ok = True
    pid, master, _ = spawn(port, {})  # editor mode (no BASIC_INPUT)
    try:
        got, _ = read_until(master, lambda b: " PLAN " in b, 60)
        print(f"  [{'PASS' if got else 'FAIL'}] status bar shows the PLAN chip (default)")
        ok &= got

        os.write(master, b"\x1b[Z")  # Shift+Tab
        got, _ = read_until(master, lambda b: " NORMAL " in b, 15)
        print(f"  [{'PASS' if got else 'FAIL'}] Shift+Tab -> NORMAL")
        ok &= got

        os.write(master, b"\x1b[Z")  # Shift+Tab again
        got, _ = read_until(master, lambda b: " PLAN " in b, 15)
        print(f"  [{'PASS' if got else 'FAIL'}] Shift+Tab -> PLAN (cycles back)")
        ok &= got
    finally:
        reap(pid, master)
    return ok


def main():
    srv, port = start_stub_server(_decide)
    print(f"stub model @ 127.0.0.1:{port}")
    try:
        ok = scenario_plan_lifecycle(port)
        ok = scenario_mode_cycle(port) and ok
    finally:
        srv.shutdown()

    print("\n==== RESULT:", "ALL PASS" if ok else "FAILURES", "====")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
