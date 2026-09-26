/**
 * Research runs are meant to last days. Seen live: a no-gate crawl hit the
 * 1000-turn runaway backstop after ~9 hours (1,095 threads) and stopped, and
 * TypeScript stream rules ("no `as` cast") interrupted prose about guitars. The
 * backstop stays for gated builds; research sessions run uncapped unless the
 * user sets TSFORGE_MAX_TURNS.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCheckpointHook } from "../src/cli/logging";
import { flags } from "../src/config/flags";
import type {
  ICompleteOptions,
  IModelResponse,
  IProvider,
} from "../src/inference";
import { Session, type ILoopEvent } from "../src/loop";
import { LOOP_LIMITS } from "../src/loop/loop.constants";

const dirs: string[] = [];
const saved = process.env.TSFORGE_MAX_TURNS;

afterEach(async () => {
  if (saved === undefined) {
    delete process.env.TSFORGE_MAX_TURNS;
  } else {
    process.env.TSFORGE_MAX_TURNS = saved;
  }

  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tsf-long-"));

  dirs.push(d);

  return d;
}

/** Calls `note` for `turns` turns (distinct text, so no repetition guard),
 *  then answers. Records each call's options. */
function noteTaker(turns: number): {
  provider: IProvider;
  opts: (ICompleteOptions | undefined)[];
} {
  const opts: (ICompleteOptions | undefined)[] = [];

  return {
    opts,
    provider: {
      async complete(_m, o): Promise<IModelResponse> {
        opts.push(o);

        return opts.length <= turns
          ? {
              content: "",
              toolCalls: [
                {
                  id: `n${String(opts.length)}`,
                  name: "note",
                  arguments: {
                    topic: "t",
                    text: `finding ${String(opts.length)}`,
                  },
                },
              ],
            }
          : { content: "All threads are covered.", toolCalls: [] };
      },
    },
  };
}

describe("turn cap", () => {
  test("a no-gate research send runs past the runaway backstop", async () => {
    delete process.env.TSFORGE_MAX_TURNS;

    const turns = LOOP_LIMITS.runawayBackstopTurns + 5;
    const { provider } = noteTaker(turns);
    const session = await Session.create({ provider, cwd: await tempDir() });
    const result = await session.send("research until done");

    expect(result.status).toBe("responded");
    expect(result.turns).toBe(turns + 1);
  }, 120_000);

  test("TSFORGE_MAX_TURNS caps any session", async () => {
    process.env.TSFORGE_MAX_TURNS = "5";

    const events: ILoopEvent[] = [];
    const session = await Session.create({
      provider: noteTaker(50).provider,
      cwd: await tempDir(),
      report: (e) => events.push(e),
    });
    const result = await session.send("research");

    expect(result).toMatchObject({ status: "stuck", turns: 5 });
    expect(
      events.some((e) =>
        e.message.includes("hit the 5-turn runaway crash-guard")
      )
    ).toBe(true);
  });

  test("a gated build keeps the backstop", async () => {
    delete process.env.TSFORGE_MAX_TURNS;

    const cwd = await tempDir();

    await writeFile(join(cwd, "package.json"), "{}");

    const session = await Session.create({
      provider: noteTaker(5).provider,
      cwd,
      accept: "true",
      files: ["**/*"],
    });

    expect(session.turnCap()).toBe(LOOP_LIMITS.runawayBackstopTurns);
  });

  test.each([
    ["0", Number.POSITIVE_INFINITY],
    ["250", 250],
    ["-1", undefined],
    ["abc", undefined],
    ["", undefined],
  ])("TSFORGE_MAX_TURNS=%p → %p", (raw, expected) => {
    process.env.TSFORGE_MAX_TURNS = raw;
    expect(flags.maxTurns()).toBe(expected);
  });
});

describe("saving long sends", () => {
  test("the checkpoint hook fires on checkpoint events only", () => {
    const seen: string[] = [];
    let saves = 0;
    const report = withCheckpointHook(
      (e) => seen.push(e.kind),
      () => {
        saves += 1;
      }
    );

    report({ kind: "cycle", task: "s", message: "turn 1" });
    report({ kind: "checkpoint", task: "s", message: "checkpoint: turn 40" });

    expect(seen).toEqual(["cycle", "checkpoint"]);
    expect(saves).toBe(1);
  });

  test("a long send emits checkpoints the REPL saves on", async () => {
    const events: ILoopEvent[] = [];
    const session = await Session.create({
      provider: noteTaker(85).provider,
      cwd: await tempDir(),
      report: (e) => events.push(e),
    });

    await session.send("research");

    expect(
      events.filter((e) => e.kind === "checkpoint").map((e) => e.message)
    ).toEqual(["checkpoint: turn 40", "checkpoint: turn 80"]);
  });
});

const PROFILE = {
  name: "generic",
  packs: [],
  confidence: "guess" as const,
  reason: "test",
};

describe("TypeScript stream rules", () => {
  test("off while the workspace has no code, on once it does", async () => {
    const autoGate = async () => ({ command: "exit 2", stackProfile: PROFILE });
    const research = noteTaker(1);
    const notes = await Session.create({
      provider: research.provider,
      cwd: await tempDir(),
      accept: "bun eslint .",
      autoGate,
      files: ["**/*"],
    });

    await notes.send("take notes");
    expect(research.opts[0]?.ttsrManager).toBeUndefined();

    const code = await tempDir();

    await writeFile(join(code, "package.json"), "{}");
    await writeFile(join(code, "a.ts"), "export const a = 1;\n");

    const build = noteTaker(0);
    const session = await Session.create({
      provider: build.provider,
      cwd: code,
      accept: "true",
      autoGate,
      files: ["**/*"],
    });

    await session.send("hi");
    expect(build.opts[0]?.ttsrManager).toBeDefined();
  });
});
