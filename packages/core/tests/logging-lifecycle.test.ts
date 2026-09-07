import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeReporter,
  observeEvents,
  outputRouter,
  isRunMeta,
} from "../src/cli/logging";
import type { ILoopEvent } from "../src/loop";

// The shared reporter (`makeReporter("")` returns the internal `render`) plus the
// module-level `outputRouter`/`observeEvents` singletons. Every test restores the
// singletons in afterEach so ordering can't leak an installed sink/observer.
const report = makeReporter("", "run-test");

afterEach(() => {
  observeEvents(null);
  outputRouter.setParentSink(null);
  outputRouter.clearAgentSink("run:explore");
});

const started = (agentId: string, label: string): ILoopEvent => ({
  kind: "agent_started",
  task: "run",
  agentId,
  message: label,
});

describe("subagent lifecycle rendering", () => {
  test("with a tree observer attached, lifecycle text is NOT routed to the agent's detail sink", () => {
    const sink: string[] = [];
    const seen: string[] = [];

    observeEvents((e) => seen.push(e.kind)); // a tree is attached
    outputRouter.setAgentSink("run:explore", (t) => sink.push(t));

    report(started("run:explore", "explore meta-rules subsystem"));

    // The observer (tree) still sees the event...
    expect(seen).toEqual(["agent_started"]);
    // ...but its label is NOT diverted into the agent's own detail pane buffer
    // (that would print the label a second time under the tree row).
    expect(sink).toEqual([]);
  });

  test("with a tree observer attached, the agent's real work (tool/token) STILL routes to its sink", () => {
    const sink: string[] = [];

    observeEvents(() => {});
    outputRouter.setAgentSink("run:explore", (t) => sink.push(t));

    report({
      kind: "tool",
      task: "run",
      agentId: "run:explore",
      message: "✎ read meta-rules.ts",
    });

    expect(sink.length).toBe(1);
    expect(sink.join("")).toContain("read meta-rules.ts");
  });

  test("the run-meta start event is NOT rendered — it addresses the ledger, not the screen", () => {
    const parent: string[] = [];

    outputRouter.setParentSink((t) => parent.push(t));

    report({
      kind: "start",
      task: "session",
      message: "model deepseek-v4-flash-vision-exp · context window 262144",
      model: "deepseek-v4-flash-vision-exp",
      contextWindow: 262_144,
    });

    // It used to print above the pane console, which then wiped it on first paint.
    expect(parent).toEqual([]);
  });

  test("suppressing the render does NOT cost the ledger its header", async () => {
    // The whole point of the run-meta event is a self-describing --log. Skipping
    // the render must not skip the record, or the analyzer loses which model the
    // metrics belong to.
    const dir = mkdtempSync(join(tmpdir(), "tsforge-ledger-"));
    const logFile = join(dir, "run.jsonl");
    const logged = makeReporter(logFile, "run-meta-test");
    const parent: string[] = [];

    outputRouter.setParentSink((t) => parent.push(t));

    logged({
      kind: "start",
      task: "session",
      message: "model deepseek-v4-flash-vision-exp · context window 262144",
      model: "deepseek-v4-flash-vision-exp",
      contextWindow: 262_144,
    });

    // The ledger writer may flush asynchronously.
    await Bun.sleep(50);

    const written = readFileSync(logFile, "utf8");

    expect(parent).toEqual([]); // nothing on screen
    expect(written).toContain("deepseek-v4-flash-vision-exp"); // everything in the log
    expect(written).toContain("262144");
  });

  test("a plain start event (no run metadata) still renders", () => {
    const parent: string[] = [];

    outputRouter.setParentSink((t) => parent.push(t));

    report({ kind: "start", task: "run", message: "building the thing" });

    expect(parent.join("")).toContain("building the thing");
  });

  test("isRunMeta keys off the analyzer fields, not the task name", () => {
    expect(
      isRunMeta({ kind: "start", task: "session", message: "m", model: "x" })
    ).toBe(true);
    expect(
      isRunMeta({ kind: "start", task: "s", message: "m", contextWindow: 1 })
    ).toBe(true);
    expect(isRunMeta({ kind: "start", task: "session", message: "m" })).toBe(
      false
    );
    // A non-start event carrying a model must not be mistaken for the header.
    expect(
      isRunMeta({ kind: "usage", task: "run", message: "u", model: "x" })
    ).toBe(false);
  });

  test("headless (no observer): lifecycle events still render as a linear-log line", () => {
    const parent: string[] = [];

    // No observeEvents() → no tree. A parent sink stands in for stdout.
    outputRouter.setParentSink((t) => parent.push(t));

    report(started("run:explore", "explore meta-rules subsystem"));

    expect(parent.join("")).toContain("explore meta-rules subsystem");
  });
});
