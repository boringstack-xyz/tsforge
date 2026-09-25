#!/usr/bin/env python3
"""Real-PTY coverage for the input editor itself — the surfaces that previously
had only in-process (VirtualScreen/unit) tests:

  1. Typing + backspace + multiline (Alt+Enter) render in the real input row,
     and the submitted user bubble carries exactly what was edited.
  2. A bracketed paste (ESC[200~ ... ESC[201~) with embedded CRs lands in the
     input as ONE paste — no per-line submits — and submits as one message.
  3. The `@` file picker: dropdown renders, typing filters it, Enter inserts
     the picked path into the input, and the path survives to the submit.
  4. A long line wraps without duplicating the mode chip (ghost-row bug).

Deterministic: shared stub model server, no GUI. Run: python3 scripts/e2e-editor-pty.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ptyharness import (  # noqa: E402
    Checker,
    drain,
    read_until,
    reap,
    spawn_tsforge,
    start_stub_server,
    visible_text,
)

t = Checker()

# Closed USER card top badge (render/ansi.ts userBubble) — not the old `╭─ you`.
BUBBLE_TOP = " USER "
MODE_CHIP = " PLAN "  # top-strip mode chip (default mode)


def project_dir(prefix):
    """A temp PROJECT folder (has a package.json): plan-first — and so the PLAN
    mode chip this script waits on — applies to folders with code; a folder with
    no code (research notes) starts in normal mode."""
    work = tempfile.mkdtemp(prefix=prefix)
    with open(os.path.join(work, "package.json"), "w") as f:
        f.write('{"name":"editor-e2e","private":true}\n')
    return work
ROWS, COLS = 40, 120


def last_frame(buf):
    """Visible cell grid after applying the full pane CUP paint stream."""
    return visible_text(buf, rows=ROWS, cols=COLS)


def boot(port, cwd):
    pid, m = spawn_tsforge(
        port, cwd=cwd, home=tempfile.mkdtemp(prefix="tsforge-edhome-"),
        rows=ROWS, cols=COLS,
    )
    got, buf = read_until(m, lambda b: MODE_CHIP in b, 60)
    return pid, m, got, buf


def scenario_typing(port):
    print("\n# typing + backspace + multiline (real editor)")
    work = project_dir("tsforge-ed-")
    pid, m, got, buf = boot(port, work)
    try:
        t.check("editor boots (mode chip renders)", got)

        os.write(m, b"helloX")
        _, buf = read_until(m, lambda b: "helloX" in b, 8, "")
        os.write(m, b"\x7f")  # backspace the X
        os.write(m, b" world")
        got, buf = read_until(m, lambda b: "hello world" in b, 8, "")
        t.check("backspace + typing rerenders the row ('hello world')", got)

        os.write(m, b"\x1b\r")  # Alt+Enter → newline, NOT a submit
        os.write(m, b"second line")
        got, buf = read_until(m, lambda b: "second line" in b, 8, "")
        t.check("Alt+Enter continues to a second line", got)
        t.check("newline did NOT submit (no user bubble yet)", BUBBLE_TOP not in buf)

        os.write(m, b"\r")  # submit
        got, buf = read_until(m, lambda b: BUBBLE_TOP in b, 15, "")
        t.check("Enter submits → user bubble renders", got)
        got, buf = read_until(
            m, lambda b: "hello world" in b and "second line" in b, 8, buf
        )
        t.check("bubble carries BOTH edited lines", got)
    finally:
        reap(pid, m)


def scenario_paste(port):
    print("\n# bracketed paste (real editor)")
    work = project_dir("tsforge-ed-")
    pid, m, got, buf = boot(port, work)
    try:
        t.check("editor boots (mode chip renders)", got)

        # A multi-line paste: the CRs inside the brackets must become newlines in
        # the input buffer, NOT per-line submits.
        os.write(m, b"\x1b[200~alpha one\rbeta two\x1b[201~")
        got, buf = read_until(
            m, lambda b: "alpha one" in b and "beta two" in b, 8, ""
        )
        t.check("pasted lines render in the input", got)
        buf = drain(m, 1.0, buf)  # give a would-be spurious submit time to appear
        t.check("paste did NOT submit (no user bubble)", BUBBLE_TOP not in buf)

        os.write(m, b"\r")  # submit the pasted content as ONE message
        got, buf = read_until(m, lambda b: BUBBLE_TOP in b, 15, "")
        t.check("Enter after paste submits", got)
        one_bubble = buf.count(BUBBLE_TOP) == 1
        got, buf = read_until(
            m, lambda b: "alpha one" in b and "beta two" in b, 8, buf
        )
        t.check("bubble carries the full paste (both lines)", got)
        t.check("exactly ONE bubble (single submit)", one_bubble)
    finally:
        reap(pid, m)


def scenario_at_picker(port):
    print("\n# @ file picker interaction (real editor)")
    work = project_dir("tsforge-ed-")
    # Distinct names so the filter assertion can't false-match.
    for name, body in [
        ("alpha_target.ts", "export const a = 1;\n"),
        ("beta_other.ts", "export const b = 2;\n"),
        ("notes.md", "# notes\n"),
    ]:
        with open(os.path.join(work, name), "w") as f:
            f.write(body)
    pid, m, got, buf = boot(port, work)
    try:
        t.check("editor boots (mode chip renders)", got)
        # The workspace file list loads async at boot; give it a beat.
        drain(m, 0.5)

        os.write(m, b"@")
        got, buf = read_until(m, lambda b: "alpha_target.ts" in b, 10, "")
        t.check("@ opens the dropdown (workspace files listed)", got)

        os.write(m, b"alpha")  # filter
        got, buf = read_until(
            m,
            lambda b: "alpha_target.ts" in last_frame(b)
            and "beta_other.ts" not in last_frame(b),
            8,
            "",
        )
        t.check("typing filters the dropdown (beta gone from the frame)", got)

        os.write(m, b"\r")  # accept the highlighted row
        got, buf = read_until(m, lambda b: "alpha_target.ts" in b, 8, "")
        t.check("Enter inserts the picked path into the input", got)

        os.write(m, b"\r")  # submit — the path token must survive to the message
        got, buf = read_until(
            m, lambda b: BUBBLE_TOP in b and "alpha_target.ts" in b, 15, ""
        )
        t.check("submitted bubble carries the picked path", got)
    finally:
        reap(pid, m)


def scenario_longline(port):
    print("\n# long-line wrap (real editor)")
    work = project_dir("tsforge-ed-")
    pid, m, got, buf = boot(port, work)
    try:
        t.check("editor boots (mode chip renders)", got)

        os.write(m, b"Z" * 200)  # wider than the 120-col pty → must wrap
        got, buf = read_until(m, lambda b: b.count("Z") >= 200, 10, "")
        buf = drain(m, 0.8, buf)  # let the final repaint settle
        frame = last_frame(buf)
        t.check("all 200 chars echo", got)
        t.check(
            f"exactly one status bar in the frame (saw {frame.count(MODE_CHIP)})",
            frame.count(MODE_CHIP) == 1,
        )
    finally:
        reap(pid, m)


def main():
    srv, port = start_stub_server()
    print(f"stub model @ 127.0.0.1:{port}")
    try:
        scenario_typing(port)
        scenario_paste(port)
        scenario_at_picker(port)
        scenario_longline(port)
    finally:
        srv.shutdown()
    sys.exit(t.finish())


if __name__ == "__main__":
    main()
