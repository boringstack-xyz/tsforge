#!/usr/bin/env python3
"""Real-PTY e2e for model-driven delegation (the `spawn_agent` tool + live tree).

Drives the REAL tsforge REPL in a REAL pty against the deterministic stub model.
The stub plays TWO roles keyed off the system prompt: as the ORCHESTRATOR it
emits two `spawn_agent` tool calls in one turn; as a SUBAGENT (built-in explore
spec) it must investigate first (the runner forces a tool call), then answers.
We assert on the REAL byte stream that the live agent tree rendered — header,
both child rows, the focused agent's output pane — that ↑/↓ on the empty editor
input row navigate the detail pane between agents (editor-mode tree nav), and
that the orchestrator got the findings back and produced a final answer.

Run: python3 scripts/e2e-spawn-agent-pty.py
"""
import json
import os
import re
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    Checker,
    content_chunks,
    read_until,
    reap,
    sse,
    spawn_tsforge,
    start_stub_server,
)

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip(text):
    return ANSI.sub("", text)


def two_spawns():
    """One assistant turn emitting TWO parallel spawn_agent tool calls."""
    yield sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_a",
                                "type": "function",
                                "function": {
                                    "name": "spawn_agent",
                                    "arguments": json.dumps(
                                        {
                                            "subagent_type": "explore",
                                            "description": "trace scheduler",
                                            "prompt": "How does AgentScheduler cap concurrency? Cite file:line.",
                                        }
                                    ),
                                },
                            },
                            {
                                "index": 1,
                                "id": "call_b",
                                "type": "function",
                                "function": {
                                    "name": "spawn_agent",
                                    "arguments": json.dumps(
                                        {
                                            "subagent_type": "verify",
                                            "description": "check abort race",
                                            "prompt": "Is there an abort race in AgentScheduler? Cite file:line.",
                                        }
                                    ),
                                },
                            },
                        ]
                    },
                }
            ]
        }
    )


def search_call():
    yield sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_s",
                                "type": "function",
                                "function": {
                                    "name": "search",
                                    "arguments": json.dumps({"pattern": "concurrency"}),
                                },
                            }
                        ]
                    },
                }
            ]
        }
    )


def agent_result_call():
    """A subagent's structured final answer (built-in specs are outputMode:structured)."""
    yield sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_r",
                                "type": "function",
                                "function": {
                                    "name": "agent_result",
                                    "arguments": json.dumps(
                                        {
                                            "summary": "AgentScheduler caps concurrency; no abort race.",
                                            "findings": [
                                                {
                                                    "detail": "cap honored via the limiter",
                                                    "source": "agent-scheduler.ts:60",
                                                    "confidence": "high",
                                                }
                                            ],
                                        }
                                    ),
                                },
                            }
                        ]
                    },
                }
            ]
        }
    )


def _decide(messages):
    system = ""
    if messages and messages[0].get("role") == "system":
        system = messages[0].get("content") or ""
    last = messages[-1] if messages else {}
    is_orchestrator = "DELEGATION" in system

    if is_orchestrator:
        if last.get("role") == "tool":
            # Both subagents are done; the tree is on screen (both rows ✓). Hold the
            # orchestrator's final answer a few seconds so the tree stays painted
            # while the test drives ↑/↓ over it, then finish the turn.
            time.sleep(4)

            return content_chunks(
                "Both specialists confirm AgentScheduler caps concurrency and wires "
                "per-unit AbortControllers. Done."
            )
        return two_spawns()

    # A subagent (built-in explore/verify — outputMode:structured). The runner
    # forces a tool call first, so search, then finish with a STRUCTURED
    # agent_result once the tool result is back (plain text would be nudged).
    if last.get("role") == "tool":
        return agent_result_call()
    return search_call()


def main():
    srv, port = start_stub_server(_decide)
    print(f"stub model @ 127.0.0.1:{port}")
    chk = Checker()

    work = tempfile.mkdtemp(prefix="tsforge-spawn-")
    # A project folder: the PLAN chip (boot marker below) is plan-first, which
    # applies to folders with code.
    with open(os.path.join(work, "package.json"), "w") as f:
        f.write('{"name":"spawn-e2e","private":true}\n')
    home = tempfile.mkdtemp(prefix="tsforge-home-")
    # Editor mode (the default): the live agent tree renders in the pinned region.
    pid, master = spawn_tsforge(port, {}, cwd=work, home=home)
    try:
        read_until(master, lambda b: " PLAN " in b, 60)
        # Switch to normal mode (Shift+Tab, editor) so the orchestrator acts.
        os.write(master, b"\x1b[Z")
        _, buf = read_until(master, lambda b: " NORMAL " in b, 15)

        os.write(master, b"Explain how AgentScheduler caps concurrency.\r")

        # The detail pane auto-follows the newest running agent. At cap=1 (the
        # default) the two spawns run serially: explore first, then verify — so
        # auto-follow lands on `verify` (check abort race) by the time both finish.
        got, buf = read_until(master, lambda b: "↳ check abort" in strip(b), 60, buf)
        chk.check("live agent tree header rendered (● agents)", "● agents" in strip(buf))
        chk.check("tree connectors rendered", "├─" in strip(buf) or "└─" in strip(buf))
        chk.check(
            "both spawned rows shown with their labels",
            "trace scheduler" in strip(buf) and "check abort race" in strip(buf),
        )
        chk.check("detail pane auto-followed to the newest agent (verify)", got)

        # --- Editor-mode arrow navigation over the live tree --------------------
        # Auto-follow only ever moves FORWARD to the newest agent. Pressing ↑ to
        # bring focus BACK to the earlier `explore` agent is something ONLY
        # arrow-nav can produce — so a `↳ trace scheduler` header appearing in the
        # stream AFTER our keypress proves editor-mode nav works. We search only
        # the suffix that arrives after each press (buf is cumulative).
        mark = len(buf)
        os.write(master, b"\x1b[A")  # ↑ on the empty input row → tree nav
        up_ok, buf = read_until(
            master, lambda b: "↳ trace scheduler" in strip(b[mark:]), 20, buf
        )
        chk.check("↑ moved detail focus back to the explore agent", up_ok)

        mark = len(buf)
        os.write(master, b"\x1b[B")  # ↓ → forward again to verify
        down_ok, buf = read_until(
            master, lambda b: "↳ check abort" in strip(b[mark:]), 20, buf
        )
        chk.check("↓ moved detail focus forward to the verify agent", down_ok)

        # The turn still completes cleanly after arrow navigation.
        got, buf = read_until(master, lambda b: "Done." in strip(b), 30, buf)
        chk.check("orchestrator produced a final answer after delegating", got)
    finally:
        reap(pid, master)

    srv.shutdown()
    sys.exit(chk.finish())


if __name__ == "__main__":
    main()
