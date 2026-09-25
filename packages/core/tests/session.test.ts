import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session, filterGateStream } from "../src/loop";
import { isModelTimeout } from "../src/loop/session";
import { ModelRequestError, StreamInterruptedError } from "../src/inference";

/** A provider that yields immediately (no tool calls) — the "model is done" case. */
function yields(content = "ok"): IProvider {
  return {
    async complete() {
      return { content, toolCalls: [] };
    },
  };
}

test("no gate → one conversational turn, conversation retained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const session = await Session.create({
      provider: yields("hello"),
      cwd: dir,
    });
    const result = await session.send("hi");

    expect(result.status).toBe("responded");
    expect(result.turns).toBe(1);
    // system + user + assistant
    expect(session.messages.length).toBe(3);
    expect(session.messages.at(-1)?.content).toBe("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a gate does NOT fire on a pure answer (no edits) — stays conversational", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // Gate set, but the model only answers (no edits) → no gate run.
    const session = await Session.create({
      provider: yields("here is the answer"),
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("what does this do?");

    expect(result.status).toBe("responded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gate-confirms AFTER the model edits: green gate → done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // Turn 1: create a file (an edit). Turn 2: yield → gate runs (passes) → done.
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true", // a gate that always passes
      files: ["**/*"],
    });
    const result = await session.send("create x.ts");

    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The narrate-instead-of-build failure: a gated build turn where the model writes
// whole files into its message (fenced blocks) instead of calling `create`. The
// content never reaches disk, so the session must NOT accept it as "responded".
const CODE_DUMP =
  "I'll build it. First the types:\n\n```ts\nexport interface Issue { id: string }\n```\n\n" +
  "Now the component:\n\n```tsx\nexport function App() { return <div/>; }\n```\n";

test("gated build: model dumps code as prose, never acts → nudged then stuck", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        return { content: CODE_DUMP, toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("build a Linear clone");

    // Not silently "responded": nudged maxBuildNudges times, then gave up.
    expect(result.status).toBe("stuck");
    // 2 nudges + the turn that hits the cap = 3 model calls.
    expect(calls).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gated build: a code-dump nudge recovers when the model then creates files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return { content: CODE_DUMP, toolCalls: [] }; // dumps → gets nudged
        }

        if (calls === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] }; // yields → gate runs → done
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("build a Linear clone");

    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P1: a create via the `path` alias (not `file`) still WRITES the file, so the
// session must count it as an edit and run the gate — not return "responded".
test("gated build: create({ path }) alias counts as an edit and reaches the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                // `path`, not `file` — the alias the model often reaches for.
                arguments: { path: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("create x.ts");

    // The file was written AND the gate ran → done, not a silent "responded".
    expect(result.status).toBe("done");
    expect(await Bun.file(join(dir, "x.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// After the model narrates code instead of acting, the next turn must FORCE a
// tool call (tool_choice "required") — vLLM's required path follows the schema
// strictly, so it can't narrate / emit malformed tool syntax again.
test("forces tool_choice 'required' on the turn after a narration nudge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const choices: (string | undefined)[] = [];
    const thinking: (boolean | undefined)[] = [];
    let calls = 0;
    const provider: IProvider = {
      async complete(_messages, opts) {
        calls += 1;
        choices.push(opts?.toolChoice);
        thinking.push(opts?.enableThinking);

        // Turn 1: narrate code (no tool call) → triggers the build nudge.
        if (calls === 1) {
          return { content: CODE_DUMP, toolCalls: [] };
        }

        // Turn 2 (forced): create the file, then later yield → gate → done.
        if (calls === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });

    await session.send("build it");

    // Turn 1 was "auto"; the recovery turn after the nudge was "required".
    expect(choices[0]).toBe("auto");
    expect(choices[1]).toBe("required");
    // …and thinking is disabled on that forced turn (clean tool call).
    expect(thinking[1]).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Incremental check: while building, run a fast check every `checkEvery` edits
// and feed errors back EARLY (so they don't pile up). Here the check is `false`
// (always "fails") so we can see the interim feedback get injected.
test("runs the incremental check every few edits and feeds errors back early", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        // Make 3 creates (the threshold), then yield.
        if (calls <= 3) {
          return {
            content: "",
            toolCalls: [
              {
                id: String(calls),
                name: "create",
                arguments: {
                  file: `f${calls}.ts`,
                  content: `export const v${calls} = ${calls};\n`,
                },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
      incrementalCheck: "false", // a check that always reports failure
      checkEvery: 3,
    });

    await session.send("build a few files");

    // After 3 edits the interim check ran and injected its note as a user message.
    const interim = session.messages.filter(
      (m) => m.role === "user" && m.content.includes("Interim type-check")
    );

    expect(interim.length).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto-compacts before a send once context exceeds the window threshold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let compactions = 0;
    const provider: IProvider = {
      async complete(messages) {
        const system = messages[0]?.content ?? "";

        // The compaction call is distinguished by its system prompt.
        if (system.includes("compacting a coding session")) {
          compactions += 1;

          return { content: "summary", toolCalls: [] };
        }

        // A normal turn — report usage at 90% of the window so the NEXT send trips
        // the 80% auto-compact threshold.
        return {
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 90, completionTokens: 5, totalTokens: 95 },
        };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      contextWindow: 100,
      autoCompactAt: 0.8,
    });

    await session.send("first"); // records usage 90/100; nothing to compact yet
    expect(compactions).toBe(0);

    await session.send("second"); // 90% ≥ 80% → compacts before the turn
    expect(compactions).toBe(1);
    // History collapses to [system, summary, retained tail, "second", reply]:
    // the summary stands in for the older turns while the newest survive.
    expect(session.messages.length).toBeLessThanOrEqual(5);
    expect(session.messages.some((m) => m.content.includes("summary"))).toBe(
      true
    );
    expect(session.messages.some((m) => m.content.includes("second"))).toBe(
      true
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P2: a `/model` hot-swap to a smaller-window model must update auto-compaction,
// not just the status bar. setContextWindow feeds autoCompactPct; without it the
// session keeps the original (larger) window and compacts too late, overflowing
// the new model.
test("setContextWindow makes auto-compaction use the new (smaller) window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let compactions = 0;
    const provider: IProvider = {
      async complete(messages) {
        if (
          (messages[0]?.content ?? "").includes("compacting a coding session")
        ) {
          compactions += 1;

          return { content: "summary", toolCalls: [] };
        }

        // 90 tokens: 9% of the original 1000-window (safe), but 90% of a
        // hot-swapped 100-window (over the 80% threshold).
        return {
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 90, completionTokens: 5, totalTokens: 95 },
        };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      contextWindow: 1000,
      autoCompactAt: 0.8,
    });

    await session.send("first"); // 90/1000 = 9% → no compaction
    expect(compactions).toBe(0);

    session.setContextWindow(100); // swap to a smaller model

    await session.send("second"); // now 90/100 = 90% ≥ 80% → compacts
    expect(compactions).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does NOT auto-compact when no context window is configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let compactions = 0;
    const provider: IProvider = {
      async complete(messages) {
        if ((messages[0]?.content ?? "").includes("compacting a coding")) {
          compactions += 1;

          return { content: "summary", toolCalls: [] };
        }

        return {
          content: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 9999,
            completionTokens: 5,
            totalTokens: 10004,
          },
        };
      },
    };
    // No contextWindow → auto-compaction disabled regardless of usage.
    const session = await Session.create({ provider, cwd: dir });

    await session.send("first");
    await session.send("second");

    expect(compactions).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A flaky model (request timeout / connection drop) must NOT crash the process —
// send() ends the turn gracefully as `stuck` with the error logged.
// A repetition loop should trigger a bounded RECOVERY (force a concrete action),
// not immediately abandon the build.
test("recovers from a repetition loop by forcing a tool call, then proceeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const choices: (string | undefined)[] = [];
    const provider: IProvider = {
      async complete(_messages, opts) {
        calls += 1;
        choices.push(opts?.toolChoice);

        if (calls === 1) {
          return {
            content: "loop loop loop",
            toolCalls: [],
            degenerated: true,
          };
        }

        if (calls === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });

    const result = await session.send("build it");

    // Recovered (not immediately stuck): the post-loop turn was FORCED (required),
    // it then created a file and the gate confirmed.
    expect(choices[1]).toBe("required");
    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The read-only spin: the model calls read-only tools forever and never edits, so
// the gate-based progress guards (samePersist/gateStuckRepeats) never get a cycle
// to judge. Without a cross-turn guard this runs to the turn backstop. These three
// tests pin the guard: stop bounded, recover on real progress, and branch the
// re-steer message by gate presence.
test("read-only spin (gated): re-steered, then stopped well before the backstop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    await writeFile(join(dir, "seed.ts"), "export const seed = 1;\n");

    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        // Never edits — just reads the same file every turn (the spin).
        return {
          content: "",
          toolCalls: [
            { id: String(calls), name: "read", arguments: { file: "seed.ts" } },
          ],
        };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });

    const result = await session.send("update the app");

    expect(result.status).toBe("stuck");
    // Hot streak after re-steer: turn 12 resteer, 13 resteer, 14 park — far
    // below the 250-turn interactive backstop (was 36 when streak reset to 0).
    expect(result.turns).toBe(14);
    // The build-flavored re-steer fired (not the conversational one).
    expect(
      session.messages.some(
        (m) => m.role === "user" && m.content.includes("STOP READING")
      )
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only spin recovers when the model then edits → reaches done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    await writeFile(join(dir, "seed.ts"), "export const seed = 1;\n");

    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        // Spin to the first re-steer (turn 12), then make real progress.
        if (calls <= 12) {
          return {
            content: "",
            toolCalls: [
              {
                id: String(calls),
                name: "read",
                arguments: { file: "seed.ts" },
              },
            ],
          };
        }

        if (calls === 13) {
          return {
            content: "",
            toolCalls: [
              {
                id: "edit",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });

    const result = await session.send("update the app");

    // A real edit resets the streak, so the spin guard does NOT trip — the gate
    // confirms instead.
    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only spin (no gate): re-steers toward an answer, then the model replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    await writeFile(join(dir, "seed.ts"), "export const seed = 1;\n");

    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        // Read forever until the re-steer lands (turn 12), then answer.
        if (calls <= 12) {
          return {
            content: "",
            toolCalls: [
              {
                id: String(calls),
                name: "read",
                arguments: { file: "seed.ts" },
              },
            ],
          };
        }

        return { content: "here is the answer", toolCalls: [] };
      },
    };
    // No gate (no accept) → conversational session.
    const session = await Session.create({ provider, cwd: dir });

    const result = await session.send("what does this do?");

    expect(result.status).toBe("responded");
    // The conversational re-steer fired (not the build one).
    expect(
      session.messages.some(
        (m) => m.role === "user" && m.content.includes("give your answer")
      )
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a provider error ends the send as 'stuck', never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const provider: IProvider = {
      async complete() {
        throw new Error("The operation timed out.");
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    const result = await session.send("build something");

    expect(result.status).toBe("stuck");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A SINGLE request timeout mid-build must not abandon prior turns: the loop
// re-steers (forcing a small tool call) and continues, rather than going stuck.
test("recovers from one request timeout, then proceeds to done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const choices: (string | undefined)[] = [];
    const provider: IProvider = {
      async complete(_messages, opts) {
        calls += 1;
        choices.push(opts?.toolChoice);

        if (calls === 1) {
          throw Object.assign(new Error("The operation timed out."), {
            name: "TimeoutError",
          });
        }

        if (calls === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });

    const result = await session.send("build it");

    // The turn after the timeout was FORCED (required) → a small clean call, and
    // the build proceeded to green instead of abandoning on the single timeout.
    expect(choices[1]).toBe("required");
    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send returns 'interrupted' when its signal is aborted mid-turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // A provider that never resolves on its own — only the abort ends it.
    // Check `aborted` immediately: mid-drive hygiene can let abort win the race
    // before this listener is registered.
    const provider: IProvider = {
      async complete(_messages, opts) {
        const signal = opts?.signal;

        if (signal?.aborted === true) {
          throw new Error("aborted");
        }

        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      },
    };
    const session = await Session.create({ provider, cwd: dir });
    const controller = new AbortController();
    const pending = session.send("do something slow", {
      signal: controller.signal,
    });

    controller.abort();

    expect((await pending).status).toBe("interrupted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact replaces the conversation with [system, summary, retained tail]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const provider: IProvider = {
      async complete() {
        return { content: "SUMMARY", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    await session.send("do a thing");
    const before = session.messages.length; // system + user + assistant

    const result = await session.compact();

    expect(result.before).toBe(before);
    expect(session.messages.length).toBe(3); // system + summary + retained tail
    expect(session.messages[0]?.role).toBe("system");
    expect(session.messages[1]?.content).toContain("SUMMARY");
    // The newest turn survives a compact verbatim — losing it mid-task is what
    // read as the model forgetting what it was doing. (The stub answers every
    // call with "SUMMARY", so the ROLE is what distinguishes the retained
    // assistant turn from the injected user-role summary above it.)
    expect(session.messages[1]?.role).toBe("user");
    expect(session.messages[2]?.role).toBe("assistant");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("steer injects a queued message before the next turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // Turn 1 keeps working (a tool call); turn 2 yields. The steer callback
    // queues a message that should land before turn 2's model call.
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "read", arguments: { file: "x.ts" } }],
          };
        }

        return { content: "ok", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    let steerCalls = 0;

    await session.send("start", {
      steer: () => {
        steerCalls += 1;

        return steerCalls === 2 ? ["actually use Tailwind"] : [];
      },
    });

    expect(
      session.messages.some((m) => m.content === "actually use Tailwind")
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each send appends to the same persistent conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const session = await Session.create({ provider: yields(), cwd: dir });

    await session.send("first");
    const afterFirst = session.messages.length;

    await session.send("second");

    expect(session.messages.length).toBe(afterFirst + 2); // user + assistant
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("answer content streams as token events AND settles as one message event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // A streaming provider: emits the answer in two content deltas via onToken,
    // then returns the consolidated content (what a real SSE stream does).
    const provider: IProvider = {
      async complete(_messages, opts) {
        opts?.onToken?.("hello ", "content");
        opts?.onToken?.("world", "content");

        return { content: "hello world", toolCalls: [] };
      },
    };
    const events: { kind: string; message: string; channel?: string }[] = [];
    const session = await Session.create({
      provider,
      cwd: dir,
      report: (e) => {
        events.push({ kind: e.kind, message: e.message, channel: e.channel });
      },
    });

    await session.send("hi");

    const contentTokens = events.filter(
      (e) => e.kind === "token" && e.channel === "content"
    );

    expect(contentTokens.map((e) => e.message)).toEqual(["hello ", "world"]);
    // The consolidated message stays — it is the log's record of the answer.
    expect(
      events.some((e) => e.kind === "message" && e.message === "hello world")
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Captured live: the model emits a tool call as MALFORMED TEXT (the server's
// parser can't match it, salvage can't rescue it) and yields — without a nudge
// the turn ends as a fake "responded" and the build strands.
test("leaked tool-call markup in a no-tool-call yield is nudged into a real call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          // The exact degenerate shape captured live (invented tag pair).
          return {
            content: 'Scaffolding now.\n\n<files>\n["/tmp/x"]\n</files>',
            toolCalls: [],
          };
        }

        if (calls === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("build it");

    expect(result.status).toBe("done");
    // The nudge fired and the forced retry actually created the file.
    expect(
      session.messages.some(
        (m) => m.role === "user" && m.content.includes("malformed")
      )
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a plain prose answer (no markup, no dump) still ends as responded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const session = await Session.create({
      provider: yields("TypeScript adds static types to JavaScript."),
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("what is TypeScript?");

    expect(result.status).toBe("responded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// TDD is ON by default, but the interactive system prompt never carried the
// test-first guidance (only the headless build prompt did) — so the CLI agent was
// never told to write tests first. It must appear in an interactive BUILD session
// (a live gate) — and not in a plain assistant/research session, where "write
// the test first" is noise.
test("interactive build prompt includes test-first guidance when TDD is on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const build = await Session.create({
      provider: yields(),
      cwd: dir,
      accept: "true",
      executionMode: "drive-to-green",
    });

    expect(build.messages[0]?.role).toBe("system");
    expect(build.messages[0]?.content).toContain("TEST-FIRST (TDD)");

    const chat = await Session.create({ provider: yields(), cwd: dir });

    expect(chat.messages[0]?.content).not.toContain("TEST-FIRST (TDD)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TSFORGE_TDD=0 omits test-first guidance from the interactive prompt", async () => {
  process.env.TSFORGE_TDD = "0";
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const session = await Session.create({ provider: yields(), cwd: dir });

    expect(session.messages[0]?.content).not.toContain("TEST-FIRST (TDD)");
  } finally {
    delete process.env.TSFORGE_TDD;
    await rm(dir, { recursive: true, force: true });
  }
});

// The web gate runs `eslint --format json`; its single giant JSON line used to
// stream raw to the terminal at the end of every run. filterGateStream drops it
// (whole, even across chunk splits) while passing build/test progress through.
test("filterGateStream drops the eslint JSON blob but keeps build progress", async () => {
  const out: string[] = [];
  const sink = filterGateStream((t) => out.push(t));

  sink("vite v6 building for production...\n");
  sink("✓ 180 modules transformed.\n");
  // The eslint JSON, arriving split across two chunks, then its newline.
  sink('[{"filePath":"/x/a.ts","messages":[{"ruleId":"tsforge/no-jsx-comp');
  sink('utation","severity":2}],"errorCount":1}]\n');
  sink("✓ built in 1.6s\n");

  const joined = out.join("");

  expect(joined).toContain("modules transformed");
  expect(joined).toContain("built in 1.6s");
  expect(joined).not.toContain("filePath");
  expect(joined).not.toContain("no-jsx-computation");
});

// A gate process can exit with its last line un-terminated (no trailing \n).
// The buffer holds that partial to keep the JSON drop reliable, so flush() must
// emit it at stream end — otherwise the final status line is swallowed.
test("filterGateStream.flush emits a trailing newline-less line", () => {
  const out: string[] = [];
  const sink = filterGateStream((t) => out.push(t));

  sink("running gate…\n");
  sink("✗ FAILED"); // no trailing newline — process exited here
  expect(out.join("")).not.toContain("FAILED"); // still buffered

  sink.flush();

  expect(out.join("")).toContain("✗ FAILED");
});

// flush must still apply the JSON filter — a half-streamed eslint blob with no
// final newline must not leak just because the stream ended.
test("filterGateStream.flush still drops a trailing eslint JSON blob", () => {
  const out: string[] = [];
  const sink = filterGateStream((t) => out.push(t));

  sink('[{"filePath":"/x/a.ts","messages":[{"ruleId":"r","severity":2}]}]');
  sink.flush();

  expect(out.join("")).not.toContain("filePath");
});

test("a never-yielding edit loop is bounded: a gate is FORCED and the guards stop it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const gateLog = join(dir, "gate-runs.log");
    // The model NEVER yields — it churns one file it authored every single turn
    // (creates it once, then EDITs it with new content forever). Before the fix the
    // full gate only ran on yield, so it never ran → the no-progress guards never
    // ticked → it churned to the maxTurns backstop. Now a gate is FORCED after
    // FULL_GATE_EVERY edits, surfacing the failure AND advancing the guards.
    // (The churn is via `edit`, not create-overwrite — `create` no longer overwrites
    // an existing file; that whole-file-rewrite escape hatch was removed.)
    let n = 0;
    const provider: IProvider = {
      async complete() {
        n += 1;

        return n === 1
          ? {
              content: "",
              toolCalls: [
                {
                  id: "1",
                  name: "create",
                  arguments: {
                    file: "churn.ts",
                    content: "export const x = 0;\n",
                  },
                },
              ],
            }
          : {
              content: "",
              toolCalls: [
                {
                  id: String(n),
                  name: "edit",
                  arguments: {
                    file: "churn.ts",
                    oldString: `export const x = ${n - 2};`,
                    newString: `export const x = ${n - 1};`,
                  },
                },
              ],
            };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: `sh -c "echo run >> '${gateLog}'; exit 1"`, // always red; logs each run
      files: ["**/*"],
      maxTurns: 120,
    });
    const result = await session.send("keep editing churn.ts");

    const ran = (await Bun.file(gateLog).exists())
      ? (await Bun.file(gateLog).text()).trim().split("\n").length
      : 0;

    expect(ran).toBeGreaterThan(0); // a gate was forced despite the model never yielding
    expect(result.status).toBe("stuck"); // the run terminated (steered, then stopped)
    // Steering keeps a stalled run alive with escalating nudges, so a genuinely
    // hopeless churn rides the ladder and may use the full turn budget — but it is
    // STILL bounded (never an infinite loop); maxTurns is the ultimate backstop.
    expect(result.turns).toBeLessThanOrEqual(120);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("a no-gate session does NOT force a gate on edit-churn (regression: F23 must be hasGate-guarded)", async () => {
  // Codex P1: the churn force-gate fired even with no accept gate; the empty gate
  // trivially passed → send() returned {status:done} at turn 9, before the model
  // yielded its real reply. A no-gate session must run past FULL_GATE_EVERY edits
  // to the model's actual yield.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let n = 0;
    const provider: IProvider = {
      async complete() {
        n += 1;

        if (n <= 10) {
          return {
            content: "",
            toolCalls: [
              {
                id: String(n),
                name: "create",
                arguments: {
                  file: `f${n}.ts`,
                  content: `export const x${n} = ${n};\n`,
                },
              },
            ],
          };
        }

        return { content: "all ten files created", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"], // scoped so creates land — but NO accept gate (hasGate=false)
    });
    const result = await session.send("create ten files");

    expect(result.status).toBe("responded"); // NOT "done" — no gate to confirm
    expect(result.turns).toBeGreaterThan(9); // ran past FULL_GATE_EVERY, didn't stop at 9
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("assistantMessage drops partial tool_calls on a TTSR abort (no dangling tool_calls → API 400)", async () => {
  const { assistantMessage } = await import("../src/loop/assistant-message");

  // A normal turn keeps its tool_calls.
  const normal = assistantMessage({
    content: "",
    toolCalls: [{ id: "a", name: "create_file", arguments: { path: "x" } }],
  });

  expect(normal.toolCalls).toHaveLength(1);

  // A TTSR-aborted turn: the partial tool_call never executed, so it must NOT be
  // recorded (else the assistant tool_calls has no matching tool response and a strict
  // API 400s on the next request). Content is backfilled so it's never empty+tool-less.
  const aborted = assistantMessage({
    content: "",
    toolCalls: [{ id: "a", name: "create_file", arguments: { path: "x" } }],
    ttsrFired: { ruleName: "no-as-cast", guidance: "no as casts" },
  });

  expect(aborted.toolCalls).toBeUndefined();
  expect(aborted.content.length).toBeGreaterThan(0);
});

test("Session: a TTSR abort leaves NO dangling assistant tool_calls in the next request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const seen: { role: string; toolCalls?: unknown[] }[][] = [];
    let calls = 0;
    const provider: IProvider = {
      async complete(messages) {
        seen.push(
          messages.map((m) => ({ role: m.role, toolCalls: m.toolCalls }))
        );
        calls += 1;

        // Turn 1: a tool call aborted mid-stream by TTSR (partial, never executed).
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "create", arguments: { file: "x.ts" } },
            ],
            ttsrFired: { ruleName: "no-as-cast", guidance: "no as casts" },
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });

    await session.send("create x.ts");

    // The 2nd request (the TTSR retry) is where a dangling tool_calls would 400 a
    // strict API. Its history must carry NO assistant message with tool_calls — the
    // aborted partial call was dropped, only the corrective user guidance remains.
    const retryMessages = seen[1] ?? [];
    const dangling = retryMessages.filter(
      (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(dangling).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isModelTimeout matches error CLASSES, not response-body text", () => {
  const timeout = new DOMException("The operation timed out.", "TimeoutError");

  expect(isModelTimeout(timeout)).toBe(true);

  // A permanent 400 whose BODY mentions a timeout field used to be classified
  // as recoverable and re-steered MAX_TIMEOUT_RECOVERIES times.
  const permanent = new ModelRequestError(
    400,
    'invalid field "timeout": must be a number'
  );

  expect(isModelTimeout(permanent)).toBe(false);

  // A stream interrupted BY a timeout is a timeout; by a socket reset is not.
  expect(
    isModelTimeout(
      new StreamInterruptedError({ content: "x", toolCalls: [] }, timeout)
    )
  ).toBe(true);
  expect(
    isModelTimeout(
      new StreamInterruptedError(
        { content: "x", toolCalls: [] },
        new Error("socket reset")
      )
    )
  ).toBe(false);
});
