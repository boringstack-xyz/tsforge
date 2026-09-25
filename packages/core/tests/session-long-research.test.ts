/**
 * Long research sessions (no gate) must not end early on a model hiccup. Two
 * stops seen live on an hours-long forum crawl:
 *  - a repetition loop late in the night ended the send because the loop budget
 *    was per SEND, so three stray loops across hundreds of productive turns
 *    were fatal; and the loop text stayed in history, priming the retry.
 *  - "Let me record this thread." with no tool call ended the send as a
 *    finished answer.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ICompleteOptions,
  IModelResponse,
  IProvider,
} from "../src/inference";
import { Session } from "../src/loop";
import { announcesNextStep } from "../src/loop/next-step";
import {
  assistantMessage,
  collapseRepeatedLines,
} from "../src/loop/assistant-message";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-research-"));

  dirs.push(dir);

  return dir;
}

const LOOP: IModelResponse = {
  content:
    "Thread 9 is relevant.\nLet me record this thread.\nLet me record this thread.\nLet me record this thread.",
  toolCalls: [],
  degenerated: true,
};

function noteCall(n: number): IModelResponse {
  return {
    content: "",
    toolCalls: [
      {
        id: `n${String(n)}`,
        name: "note",
        arguments: { topic: "threads", text: `finding ${String(n)}` },
      },
    ],
  };
}

/** Replays `script`, recording each call's options; yields "done" after it. */
function scripted(script: readonly IModelResponse[]): {
  provider: IProvider;
  opts: (ICompleteOptions | undefined)[];
} {
  const opts: (ICompleteOptions | undefined)[] = [];

  return {
    provider: {
      async complete(_messages, o) {
        opts.push(o);

        return script[opts.length - 1] ?? { content: "done", toolCalls: [] };
      },
    },
    opts,
  };
}

describe("repetition loops in a long research send", () => {
  test("stray loops between productive turns never exhaust the budget", async () => {
    // Five loops in one send — more than the budget — each followed by work.
    const script = [1, 2, 3, 4, 5].flatMap((n) => [LOOP, noteCall(n)]);
    const { provider } = scripted(script);
    const session = await Session.create({ provider, cwd: await tempDir() });

    const result = await session.send("read every thread and take notes");

    expect(result.status).toBe("responded");
  });

  test("consecutive loops still stop, after a compacting last rung", async () => {
    const { provider } = scripted([LOOP, LOOP, LOOP, LOOP, LOOP]);
    const events: string[] = [];
    const session = await Session.create({
      provider,
      cwd: await tempDir(),
      report: (e) => events.push(e.message),
    });

    const result = await session.send("read every thread");

    expect(result.status).toBe("stuck");
    expect(events.some((m) => m.includes("compacting the context"))).toBe(true);
    // The rung really compacted — its result line, not just the warning.
    expect(events.some((m) => /^⊙ (compacted|pruned)/u.test(m))).toBe(true);
  });

  test("the retry after a loop samples hotter than the default", async () => {
    const { provider, opts } = scripted([LOOP, noteCall(1)]);
    const session = await Session.create({ provider, cwd: await tempDir() });

    await session.send("read the thread");

    expect(opts[1]?.temperature).toBeGreaterThan(opts[0]?.temperature ?? 1);
    expect(opts[1]?.toolChoice).toBe("required");
  });

  test("the loop text is not replayed into history verbatim", () => {
    const msg = assistantMessage(LOOP);

    expect(msg.content).toBe(
      "Thread 9 is relevant.\nLet me record this thread."
    );
  });
});

describe("announcing a next step without taking it", () => {
  test("is nudged to continue instead of ending the send", async () => {
    const { provider, opts } = scripted([
      { content: "Thread 9 covers wiring. Let me record it.", toolCalls: [] },
      noteCall(1),
    ]);
    const session = await Session.create({ provider, cwd: await tempDir() });

    const result = await session.send("read the thread and take notes");

    expect(result.status).toBe("responded");
    // The announce, the forced note, then the final answer.
    expect(opts).toHaveLength(3);
    expect(opts[1]?.toolChoice).toBe("required");
  });

  test("a real conversational ending is left alone", async () => {
    const { provider, opts } = scripted([
      {
        content: "Here is the summary. Let me know if you want more.",
        toolCalls: [],
      },
    ]);
    const session = await Session.create({ provider, cwd: await tempDir() });

    await session.send("summarize");

    expect(opts).toHaveLength(1);
  });
});

describe("announcesNextStep", () => {
  test.each([
    ["Let me record this thread.", true],
    ["Findings above.\n\nI'll open the next thread now.", true],
    ["Okay, let me save that.", true],
    ["- Next, I will read page 4", true],
    ["Let me know if you need anything else.", false],
    ["Should I continue with page 4?", false],
    ["Done — all 12 threads are in notes/threads.md.", false],
    ["Let me record it?", false],
    ["This demonstrates capacitor values. Let me record it.", true],
    ["I checked it. Here is what I found.", false],
  ])("%p → %p", (text, expected) => {
    expect(announcesNextStep(text)).toBe(expected);
  });
});

describe("collapseRepeatedLines", () => {
  test("keeps first occurrences and blank-line structure", () => {
    expect(collapseRepeatedLines("a\n\nb\nb\n\nb\na\nc")).toBe("a\n\nb\n\nc");
  });
});
