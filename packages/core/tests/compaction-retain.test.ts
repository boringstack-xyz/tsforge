import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IChatMessage,
  ICompleteOptions,
  IProvider,
} from "../src/inference";
import {
  compactConversation,
  compactSummaryLine,
  pruneOversizedToolResults,
  PRUNE_THRESHOLD_CHARS,
  RETAIN_CHARS,
  SPILL_DIR,
  SPILL_MARKER_PREFIX,
  SUMMARY_INPUT_CHARS,
  SUMMARY_MAX_TOKENS,
} from "../src/loop/context-hygiene";

const TEST_CWD = await mkdtemp(join(tmpdir(), "tsforge-compaction-test-"));

/** Everything a retained message really costs, tool-call arguments included. */
function retainedChars(messages: readonly IChatMessage[]): number {
  return messages.reduce(
    (sum, m) =>
      sum +
      m.content.length +
      (m.toolCalls?.reduce(
        (n, tc) => n + JSON.stringify(tc.arguments).length,
        0
      ) ?? 0),
    0
  );
}

/** Records how many times the summarizer was asked to run. */
function countingProvider(): { provider: IProvider; calls: () => number } {
  let calls = 0;

  return {
    provider: {
      async complete() {
        calls += 1;

        return { content: "brief summary", toolCalls: [] };
      },
    },
    calls: () => calls,
  };
}

/** Fails the test if compaction reaches the model at all. */
const refusingProvider: IProvider = {
  async complete() {
    throw new Error("summarizer must not be called");
  },
};

/** An old turn far too large to retain, then a newest step that fits — so the
 *  window must begin at that step's assistant turn and carry its result along. */
function historyWithFittingNewestStep(): IChatMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "A".repeat(100_000) },
    {
      role: "assistant",
      content: "step",
      toolCalls: [{ id: "c2", name: "read", arguments: {} }],
    },
    { role: "tool", content: "fresh result", toolCallId: "c2" },
  ];
}

/** A newest step whose own assistant turn already blows the retain budget. */
function historyWithOversizedNewestStep(): IChatMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "older turn" },
    {
      role: "assistant",
      content: "A".repeat(100_000),
      toolCalls: [{ id: "c2", name: "read", arguments: {} }],
    },
    { role: "tool", content: "fresh result", toolCallId: "c2" },
  ];
}

/** Every retained tool result still has the assistant turn that declared it. */
function hasNoOrphanToolResult(messages: readonly IChatMessage[]): boolean {
  const declared = new Set<string>();

  for (const m of messages) {
    for (const call of m.role === "assistant" ? (m.toolCalls ?? []) : []) {
      if (call.id !== undefined) {
        declared.add(call.id);
      }
    }

    if (
      m.role === "tool" &&
      m.toolCallId !== undefined &&
      !declared.has(m.toolCallId)
    ) {
      return false;
    }
  }

  return true;
}

describe("compaction retain window", () => {
  test("keeps the newest turns verbatim instead of wiping the history", async () => {
    const { provider } = countingProvider();

    const result = await compactConversation(
      historyWithFittingNewestStep(),
      provider,
      TEST_CWD
    );
    const kept = result.messages.map((m) => m.content);

    expect(kept).toContain("fresh result");
    expect(kept).toContain("step");
    expect(kept.some((c) => c.includes("brief summary"))).toBe(true);
    // The oversized older turn is gone; only the retained tail survives verbatim.
    expect(kept.some((c) => c.startsWith("A".repeat(100)))).toBe(false);
  });

  test("a retained tool result always brings its declaring turn with it", async () => {
    const { provider } = countingProvider();

    const result = await compactConversation(
      historyWithFittingNewestStep(),
      provider,
      TEST_CWD
    );

    expect(hasNoOrphanToolResult(result.messages)).toBe(true);
    // Both halves of the step are present — the pair was kept, not split.
    const kept = result.messages.map((m) => m.content);

    expect(kept).toContain("step");
    expect(kept).toContain("fresh result");
  });

  test("orders output as system, summary, then the retained tail", async () => {
    const { provider } = countingProvider();

    const result = await compactConversation(
      historyWithFittingNewestStep(),
      provider,
      TEST_CWD
    );
    const [first, second] = result.messages;

    expect(first?.role).toBe("system");
    expect(first?.content).toBe("sys");
    expect(second?.content).toContain("brief summary");
    expect(result.messages.at(-1)?.content).toBe("fresh result");
  });

  test("retains nothing rather than blowing the budget on one huge step", async () => {
    const { provider } = countingProvider();

    const result = await compactConversation(
      historyWithOversizedNewestStep(),
      provider,
      TEST_CWD
    );

    expect(hasNoOrphanToolResult(result.messages)).toBe(true);
    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
    expect(retainedChars(result.messages)).toBeLessThanOrEqual(RETAIN_CHARS);
  });

  test("counts tool-call arguments against the retain budget", async () => {
    const { provider } = countingProvider();
    // The write BODY lives in toolCall arguments, not in `content` — a budget
    // reading only `content` would score this turn at ~0 and retain it.
    const messages: IChatMessage[] = [
      { role: "user", content: "U".repeat(1000) },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "create",
            arguments: { file: "a.ts", content: "Z".repeat(80_000) },
          },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ];

    const result = await compactConversation(messages, provider, TEST_CWD);

    expect(retainedChars(result.messages)).toBeLessThanOrEqual(RETAIN_CHARS);
  });

  test("a summarizing compact actually shrinks the transcript", async () => {
    const { provider } = countingProvider();
    const messages = historyWithFittingNewestStep();
    const sizeBefore = retainedChars(messages);

    const result = await compactConversation(messages, provider, TEST_CWD);

    expect(retainedChars(result.messages)).toBeLessThan(sizeBefore / 2);
  });

  test("drops an already-orphaned tool result rather than retaining it", async () => {
    const { provider } = countingProvider();
    // Every tool result stays under the prune threshold so this exercises the
    // retain path rather than short-circuiting on a prune-only compact.
    const messages: IChatMessage[] = [
      { role: "user", content: "U".repeat(100_000) },
      { role: "tool", content: "leftover", toolCallId: "ghost" },
      {
        role: "assistant",
        content: "step",
        toolCalls: [{ id: "c1", name: "read", arguments: {} }],
      },
      { role: "tool", content: "fresh result", toolCallId: "c1" },
    ];

    const result = await compactConversation(messages, provider, TEST_CWD);

    expect(hasNoOrphanToolResult(result.messages)).toBe(true);
    // Retention still happened — the orphan was excluded, not the whole tail.
    expect(result.messages.map((m) => m.content)).toContain("fresh result");
  });
});

describe("prune before summarize", () => {
  test("a big enough prune replaces the summary call entirely", async () => {
    const messages: IChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "run", arguments: {} }],
      },
      { role: "tool", content: "X".repeat(50_000), toolCallId: "c1" },
    ];

    const result = await compactConversation(
      messages,
      refusingProvider,
      TEST_CWD
    );

    expect(result.prunedChars).toBeGreaterThan(0);
    expect(result.after).toBe(result.before);
    expect(result.messages.at(-1)?.content).toContain(SPILL_MARKER_PREFIX);
    expect(result.messages.at(-1)?.content).toContain(SPILL_DIR);
  });

  test("a prune that frees too little still summarizes in the same compact", async () => {
    const { provider, calls } = countingProvider();
    const messages: IChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "U".repeat(200_000) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "run", arguments: {} }],
      },
      { role: "tool", content: "X".repeat(10_000), toolCallId: "c1" },
    ];

    const result = await compactConversation(messages, provider, TEST_CWD);

    expect(calls()).toBe(1);
    expect(result.prunedChars).toBeUndefined();
    expect(
      result.messages.some((m) => m.content.includes("brief summary"))
    ).toBe(true);
  });

  test("pruning is spent after one pass", async () => {
    const messages: IChatMessage[] = [
      { role: "tool", content: "X".repeat(50_000), toolCallId: "c1" },
    ];

    const first = await pruneOversizedToolResults(messages, TEST_CWD);
    const second = await pruneOversizedToolResults(messages, TEST_CWD);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  test("leaves results at or under the threshold untouched", async () => {
    const content = "X".repeat(PRUNE_THRESHOLD_CHARS);
    const messages: IChatMessage[] = [
      { role: "tool", content, toolCallId: "c1" },
    ];

    expect(await pruneOversizedToolResults(messages, TEST_CWD)).toBe(0);
    expect(messages[0]?.content).toBe(content);
  });

  test("spills the full tool result to disk before truncating", async () => {
    const full = "X".repeat(50_000);
    const messages: IChatMessage[] = [
      { role: "tool", content: full, toolCallId: "spill-c1" },
    ];

    await pruneOversizedToolResults(messages, TEST_CWD);

    const relPath = join(SPILL_DIR, "spill-c1.txt");
    const spilled = await readFile(join(TEST_CWD, relPath), "utf8");

    expect(spilled).toBe(full);
    expect(messages[0]?.content).toContain(relPath);
  });

  test("falls back to the plain marker when the spill write fails", async () => {
    // A cwd that is itself a file (not a directory) makes mkdir(join(cwd,
    // SPILL_DIR)) fail with ENOTDIR — the write path a real disk-full or
    // permission error would also take.
    const brokenCwd = join(TEST_CWD, "not-a-directory");

    await writeFile(brokenCwd, "not a directory", "utf8");

    const messages: IChatMessage[] = [
      { role: "tool", content: "X".repeat(50_000), toolCallId: "c1" },
    ];

    const freed = await pruneOversizedToolResults(messages, brokenCwd);

    expect(freed).toBeGreaterThan(0);
    expect(messages[0]?.content).toContain(SPILL_MARKER_PREFIX);
    expect(messages[0]?.content).not.toContain(SPILL_DIR);
  });
});

describe("compactSummaryLine", () => {
  test("reports freed bytes when no summary was written", () => {
    expect(
      compactSummaryLine({ before: 40, after: 40, prunedChars: 51_200 })
    ).toBe("pruned 50KB of tool output — no summary needed");
  });

  test("reports the message count when a summary was written", () => {
    expect(compactSummaryLine({ before: 40, after: 3 })).toBe(
      "compacted 40 → 3 messages"
    );
  });
});

// ── D3: a NON-LEADING system message survives compaction ─────────────────────
// resumeMessages explicitly promises "a LATER persisted system instruction
// (delegation, scope notes) is preserved" — compaction deleting it silently
// removed a system-authority instruction mid-session.
test("compaction preserves system messages at index > 0", async () => {
  const provider: IProvider = {
    async complete() {
      return { content: "summary text", toolCalls: [] };
    },
  };
  const messages: IChatMessage[] = [
    { role: "system", content: "base prompt" },
    { role: "system", content: "DELEGATION: later system instruction" },
    ...Array.from({ length: 20 }, (_, i): IChatMessage[] => [
      { role: "user", content: `question ${String(i)} ${"x".repeat(200)}` },
      { role: "assistant", content: `answer ${String(i)} ${"y".repeat(200)}` },
    ]).flat(),
  ];

  const result = await compactConversation(messages, provider, TEST_CWD);
  const systems = result.messages.filter((m) => m.role === "system");

  expect(systems).toHaveLength(2);
  expect(systems[1]?.content).toContain("DELEGATION: later system instruction");
  // Still compacted: the summary landed and the transcript shrank.
  expect(result.after).toBeLessThan(result.before);
  expect(
    result.messages.some((m) => m.content.includes("[Summary of the earlier"))
  ).toBe(true);
});

/** A long research session: many user asks, each followed by a fat tool dump. */
function longResearchHistory(steps = 60): IChatMessage[] {
  const out: IChatMessage[] = [{ role: "system", content: "sys" }];

  for (let i = 0; i < steps; i += 1) {
    out.push({ role: "user", content: `ask ${String(i)}` });
    out.push({
      role: "assistant",
      content: "reading",
      toolCalls: [
        {
          id: `c${String(i)}`,
          name: "browser_read",
          arguments: { url: `https://f/${String(i)}` },
        },
      ],
    });
    out.push({
      role: "tool",
      content: "R".repeat(PRUNE_THRESHOLD_CHARS - 1),
      toolCallId: `c${String(i)}`,
    });
  }

  return out;
}

describe("compaction summary is bounded and cannot wedge the session", () => {
  test("the summarizer gets a bounded transcript and a capped reply", async () => {
    let seen = "";
    let opts: ICompleteOptions | undefined;
    const provider: IProvider = {
      async complete(messages, o) {
        seen = messages[1]?.content ?? "";
        opts = o;

        return { content: "brief", toolCalls: [] };
      },
    };

    await compactConversation(longResearchHistory(300), provider, TEST_CWD);

    // ~2.5MB of history in; the summary request must not carry it all — that
    // cold prefill is what timed out on a local server at 80% of the window.
    expect(seen.length).toBeLessThanOrEqual(SUMMARY_INPUT_CHARS + 200);
    expect(seen).toContain("ask 0");
    expect(seen).toContain("browser_read(https://f/2");
    expect(seen).toContain("older tool/assistant messages omitted");
    expect(opts?.maxTokens).toBe(SUMMARY_MAX_TOKENS);
    expect(opts?.enableThinking).toBe(false);
  });

  test("a failed summary call still shrinks the context with a model-free brief", async () => {
    const history = longResearchHistory();
    const provider: IProvider = {
      async complete() {
        throw new Error("The operation timed out.");
      },
    };

    const result = await compactConversation(history, provider, TEST_CWD);

    expect(result.summaryFailed).toBe("The operation timed out.");
    expect(result.after).toBeLessThan(result.before);
    const brief = result.messages.find((m) => m.content.startsWith("[Summary"));

    expect(brief?.content).toContain("- ask 0\n");
    expect(brief?.content).toContain("- ask 55");
    expect(hasNoOrphanToolResult(result.messages)).toBe(true);
    expect(compactSummaryLine(result)).toContain("summary unavailable");
  });

  test("the caller's own abort still propagates", async () => {
    const ctrl = new AbortController();
    const provider: IProvider = {
      async complete() {
        ctrl.abort();

        throw new Error("aborted");
      },
    };

    await expect(
      compactConversation(
        longResearchHistory(),
        provider,
        TEST_CWD,
        ctrl.signal
      )
    ).rejects.toThrow("aborted");
  });
});
