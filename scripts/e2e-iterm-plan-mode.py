#!/usr/bin/env python3
"""e2e: drive REAL iTerm2 through the plan-first lifecycle against the REAL model.

  boot (default => plan mode)  -> confirm the PLAN banner
  ask a change that needs a WRITE
    -> confirm NO file is written and a plan / clarifying reply comes back (read-only)
  type 'approve'
    -> confirm the approval gate fires and the file is THEN written + correct

This is the high-fidelity pass: real GUI terminal (its own reflow), real streaming,
real policy layer, real model. It is macOS + iTerm2 + a reachable model endpoint
only — the CI-capable, deterministic sibling is scripts/e2e-pty.py.

Runs tsforge in a throwaway dir so nothing touches this repo. Run:
  python3 scripts/e2e-iterm-plan-mode.py
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from itermharness import (  # noqa: E402
    CLI,
    screen,
    send,
    wait_for_screen,
    window,
)


def boot(wid, work):
    """Launch tsforge and CONFIRM it came up. iTerm2's `write text` can race the
    shell's startup and drop/transpose the first keystrokes (seen: `cd`->`dcd`),
    which silently leaves you at a zsh prompt — so verify the banner and retry the
    launch line rather than trusting the first send."""
    booted = lambda s: "plan mode (default)" in s or "· PLAN" in s  # noqa: E731
    for attempt in range(3):
        time.sleep(1.5)  # let the shell + prompt settle before the first keystrokes
        send(wid, f"cd {work} && NO_UPDATE_NOTIFIER=1 bun {CLI} --no-gate", newline=True)
        got, _ = wait_for_screen(wid, booted, 30, f"PLAN banner (boot attempt {attempt + 1})")
        if got:
            return True
        # Mangled launch line: reset the shell line and try again.
        send(wid, "\x03")  # Ctrl-C
        time.sleep(0.5)
        send(wid, "\x15")  # Ctrl-U (clear line)
        time.sleep(0.5)
    return False


def main():
    ok = True
    work = tempfile.mkdtemp(prefix="tsforge-planmode-")
    # A project folder: plan-first applies only to folders with code.
    with open(os.path.join(work, "package.json"), "w") as f:
        f.write('{"name":"planmode-e2e","private":true}\n')
    target = os.path.join(work, "src", "sum.ts")

    with window() as wid:
        print("window:", wid, "workdir:", work)

        got = boot(wid, work)
        print(f"  [{'PASS' if got else 'FAIL'}] boots into plan mode by default")
        ok &= got
        if not got:
            print("  (tsforge never launched — aborting)")
            sys.exit(1)

        send(
            wid,
            "Create a new file src/sum.ts exporting `export function sum(a: number, "
            "b: number): number` that returns a + b.",
            newline=True,
        )

        # Post-turn checkpoint (emoji-free substring; the banner says a different thing).
        got, _ = wait_for_screen(
            wid, lambda s: "reply to refine" in s, 120, "plan-ready checkpoint"
        )
        wrote_early = os.path.exists(target)
        print(f"  [{'PASS' if got else 'FAIL'}] proposed a plan and reached the idle checkpoint")
        print(
            f"  [{'PASS' if not wrote_early else 'FAIL'}] NO file written during plan mode "
            f"(read-only)   file_exists={wrote_early}"
        )
        ok &= got and (not wrote_early)

        time.sleep(1.5)
        send(wid, "approve", newline=True)
        recog, _ = wait_for_screen(
            wid, lambda s: "plan approved" in s.lower(), 30, "'plan approved — implementing'"
        )
        print(f"  [{'PASS' if recog else 'FAIL'}] 'approve' hit the approval gate (not steered)")
        ok &= recog

        got, _ = wait_for_screen(
            wid, lambda _s: os.path.exists(target), 150, "file written after approve"
        )
        print(
            f"  [{'PASS' if got else 'FAIL'}] file written AFTER approve (tools unlocked)   "
            f"file_exists={os.path.exists(target)}"
        )
        ok &= got
        if os.path.exists(target):
            with open(target) as f:
                body = f.read()
            has_fn = "function sum" in body
            print(f"  [{'PASS' if has_fn else 'FAIL'}] implemented file contains `function sum`")
            ok &= has_fn

        print("\n=== FINAL VISIBLE SCREEN (tail) ===")
        print("\n".join(screen(wid).split("\n")[-16:]))

    print("\n==== RESULT:", "ALL PASS" if ok else "FAILURES", "====")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
