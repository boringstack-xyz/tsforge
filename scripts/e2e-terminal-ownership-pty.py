#!/usr/bin/env python3
"""Real-PTY guard: while the pane console is up, nothing but the renderer may
reach the terminal.

This leaked three times (jsdom CSS warnings, library console.error, and stdio
MCP servers' stderr — mcp-remote's `[pid] [Local→Remote] tools/call` painted
over the UI). The unit tests cover the TerminalGuard and the static spawn
check; this drives the REAL UI with a noisy component and reads every byte the
terminal received:

  - a stdio MCP server that logs every message on stderr, called by the model
    mid-session (the exact shape of the bug);
  - the harness's own `/gate` confirmation, which used to be a raw stdout
    write under the pane and must now land in the transcript.

Run:
  python3 scripts/e2e-terminal-ownership-pty.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    Checker,
    content_chunks,
    drain,
    read_until,
    reap,
    spawn_tsforge,
    start_stub_server,
    toolcall_chunks,
    visible_text,
)

ROWS, COLS = 40, 120
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOCK_SERVER = os.path.join(ROOT, "packages", "core", "tests", "fixtures", "mock-mcp-server.ts")
NOISE = ("Local→Remote", "Local\\u2192Remote", "[4242]")


def decide(messages):
    """First turn: call the noisy MCP server's tool. After its result: finish."""
    last = messages[-1] if messages else {}
    if last.get("role") == "tool":
        return content_chunks("echo came back fine")
    return toolcall_chunks("mcp__noisy__echo", {"msg": "ping"})


def main():
    t = Checker()
    srv, port = start_stub_server(decide)
    work = tempfile.mkdtemp(prefix="tsforge-ownership-")
    home = tempfile.mkdtemp(prefix="tsforge-ownership-home-")
    trace = os.path.join(work, "trace.log")

    with open(os.path.join(work, "tsforge.config.json"), "w") as f:
        json.dump(
            {
                "mcpServers": {
                    "noisy": {
                        "command": "bun",
                        "args": [MOCK_SERVER],
                        "env": {"MOCK_MCP_STDERR": "1"},
                    }
                }
            },
            f,
        )

    pid, m = spawn_tsforge(
        port,
        extra_env={"TSFORGE_TRACE": trace},
        rows=ROWS,
        cols=COLS,
        cwd=work,
        home=home,
    )

    try:
        got, buf = read_until(m, lambda b: "TSFORGE" in b or "> " in b, 40)
        t.check("REPL boots with the noisy MCP server configured", got)

        os.write(m, b"use the echo tool\r")
        got, buf = read_until(m, lambda b: "echo came back fine" in b, 40, buf)
        t.check("the model called the noisy server and finished", got)

        # "/" opens the command palette: pick /gate (it fills the input with
        # "/gate "), then type the argument.
        os.write(m, b"/")
        _, buf = read_until(m, lambda b: "commands" in b, 10, buf)
        os.write(m, b"gate\r")
        buf = drain(m, 1.0, buf)
        os.write(m, b"npm test\r")
        buf = drain(m, 2.0, buf)

        # Every byte the terminal received, not just what is visible now: a
        # leak that a later repaint covered up still counts.
        leaked = [n for n in NOISE if n in buf]
        t.check(f"no MCP server stderr reached the terminal (found: {leaked})", not leaked)

        traced = open(trace, encoding="utf-8").read() if os.path.exists(trace) else ""
        t.check(
            "the server's stderr went to the debug trace instead",
            "[mcp:noisy]" in traced and "tools/call" in traced,
        )

        screen = visible_text(buf, rows=ROWS, cols=COLS)
        t.check("/gate's confirmation is shown in the transcript", "gate: npm test" in screen)
        # The old raw write was the bare line + newline straight onto the
        # alternate screen (the PTY turns \n into \r\n); rendered through the
        # pane it sits inside the frame, padded to the box edge.
        t.check("/gate's confirmation was not written raw over the frame", not any(raw in buf for raw in ("gate: npm test\n", "gate: npm test\r\n")))
        t.check("the pane chrome survived", "TSFORGE" in screen)
    finally:
        reap(pid, m)
        srv.shutdown()

    return t.finish()


if __name__ == "__main__":
    sys.exit(main())
