/**
 * Regression for the research-session derailment: an interactive session in a
 * folder with NO code (research notes only) got the strict TypeScript auto-gate,
 * which is red forever there ("all files are ignored"). That armed the whole
 * drive-to-green machinery — TypeScript-engineer prompt, `check`, near-green
 * banners, "you replied with text but called no tool", "STOP READING" — until
 * the model started inventing TypeScript to satisfy ESLint. The auto gate must
 * stay DORMANT until the workspace actually has code, then wake up.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider, IToolCall } from "../src/inference";
import { Session } from "../src/loop";
import type { IStackProfile } from "../src/stack-detection";

const PROFILE: IStackProfile = {
  name: "generic",
  packs: [],
  confidence: "guess",
  reason: "test",
};

interface IScript {
  provider: IProvider;
  calls: { tools: string[] }[];
}

/** A provider that plays back a list of turns and records the tools offered. */
function scripted(turns: (IToolCall[] | string)[]): IScript {
  const calls: { tools: string[] }[] = [];
  let i = 0;
  const provider: IProvider = {
    async complete(_messages, opts) {
      const offered = (opts?.tools ?? []) as { function: { name: string } }[];

      calls.push({ tools: offered.map((t) => t.function.name) });
      const turn = turns[Math.min(i, turns.length - 1)] ?? "";

      i += 1;

      return typeof turn === "string"
        ? { content: turn, toolCalls: [] }
        : { content: "", toolCalls: turn };
    },
  };

  return { provider, calls };
}

function autoGateCounter() {
  const state = { calls: 0 };

  const autoGate = async () => {
    state.calls += 1;

    // The real auto gate in a no-code folder: ESLint, red forever.
    return { command: "exit 2", stackProfile: PROFILE };
  };

  return { state, autoGate };
}

/** What the REPL's resolveGate hands Session.create as `accept` for an auto
 *  gate: the initially-resolved strict ESLint command. */
const AUTO_ACCEPT =
  "bun eslint --no-config-lookup -c strict.eslint.config.mjs .";

const browse = (n: number): IToolCall[] => [
  { id: `b${n}`, name: "browser_tabs", arguments: {} },
];

async function emptyDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsf-dormant-"));
}

function systemText(session: Session): string {
  return session.messages[0]?.content ?? "";
}

describe("auto gate is dormant in a workspace with no code", () => {
  test("research turns: no TS prompt, no check tool, no gate runs, no STOP READING, and the turn yields", async () => {
    const dir = await emptyDir();
    const { state, autoGate } = autoGateCounter();
    const turns: (IToolCall[] | string)[] = [
      ...Array.from({ length: 13 }, (_, n) => browse(n)),
      [
        {
          id: "n",
          name: "create",
          arguments: { file: "notes/forum.md", content: "# findings\n" },
        },
      ],
      "Here is what I found so far.",
    ];
    const { provider, calls } = scripted(turns);
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      executionMode: "drive-to-green",
      // The REPL passes BOTH the auto gate's initially-resolved command and the
      // resolver — mirror that wiring exactly.
      accept: AUTO_ACCEPT,
      autoGate,
    });

    expect(systemText(session)).not.toContain("expert TypeScript engineer");
    expect(systemText(session)).not.toContain("GREEN gate");
    // The assistant identity isn't "a TypeScript engineer" — research, browsing
    // and writing are first-class; TypeScript expertise applies when it's code.
    expect(systemText(session).split("\n")[0]).not.toMatch(
      /TypeScript (engineer|coding assistant)/
    );
    expect(systemText(session)).not.toContain("TEST-FIRST");

    const result = await session.send("read the forum and take notes");

    expect(state.calls).toBe(0);
    expect(calls.every((c) => !c.tools.includes("check"))).toBe(true);
    expect(calls.every((c) => !c.tools.includes("pull_conventions"))).toBe(
      true
    );

    const injected = session.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    // Neither re-steer variant: reading pages IS the work in a research session.
    expect(injected.toLowerCase()).not.toContain("stop reading");
    expect(injected).not.toContain("without answering");
    expect(injected).not.toContain("NEAR-GREEN");
    expect(injected).not.toContain("called no tool");
    expect(result.status).toBe("responded");
    expect(session.gateDormant()).toBe(true);
  });

  test("the gate wakes when code appears: TS prompt + gate runs from then on", async () => {
    const dir = await emptyDir();
    const { state, autoGate } = autoGateCounter();
    const write: IToolCall[] = [
      {
        id: "c",
        name: "create",
        arguments: { file: "src/index.ts", content: "export const x = 1;\n" },
      },
    ];
    // First write is bounced once by pull-before-first-write (guides embedded,
    // now counted as pulled) — a real model retries, so the script does too.
    const { provider, calls } = scripted([write, write, "done"]);
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      executionMode: "drive-to-green",
      // The REPL passes BOTH the auto gate's initially-resolved command and the
      // resolver — mirror that wiring exactly.
      accept: AUTO_ACCEPT,
      autoGate,
      maxTurns: 6,
    });

    expect(session.gateDormant()).toBe(true);
    await session.send("start a small TS module");

    expect(session.gateDormant()).toBe(false);
    expect(state.calls).toBeGreaterThan(0);
    expect(systemText(session)).toContain("expert TypeScript engineer");
    expect(calls.at(-1)?.tools).toContain("check");
  });

  test("a folder that already has code starts with the gate awake", async () => {
    const dir = await emptyDir();

    await writeFile(join(dir, "package.json"), "{}");
    const { autoGate } = autoGateCounter();
    const { provider } = scripted(["hi"]);
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      executionMode: "drive-to-green",
      // The REPL passes BOTH the auto gate's initially-resolved command and the
      // resolver — mirror that wiring exactly.
      accept: AUTO_ACCEPT,
      autoGate,
    });

    expect(session.gateDormant()).toBe(false);
    expect(systemText(session)).toContain("expert TypeScript engineer");
  });
});

describe("resuming an old build transcript in a no-code folder", () => {
  test("the saved TypeScript-engineer prompt is replaced by the assistant prompt", async () => {
    const codeDir = await emptyDir();

    await writeFile(join(codeDir, "package.json"), "{}");
    const { autoGate } = autoGateCounter();
    const base = {
      files: ["**/*"],
      offerCheck: true,
      executionMode: "drive-to-green" as const,
      accept: AUTO_ACCEPT,
      autoGate,
    };
    const old = await Session.create({
      ...base,
      provider: scripted(["ok"]).provider,
      cwd: codeDir,
    });

    expect(systemText(old)).toContain("expert TypeScript engineer");

    const resumed = await Session.create({
      ...base,
      provider: scripted(["ok"]).provider,
      cwd: await emptyDir(),
      history: [...old.messages],
    });

    expect(systemText(resumed)).not.toContain("expert TypeScript engineer");
    expect(resumed.gateDormant()).toBe(true);
  });
});

describe("coding discipline is unchanged when the gate is live", () => {
  test("12+ research turns without an edit still trip the readonly re-steer", async () => {
    const dir = await emptyDir();

    await writeFile(join(dir, "package.json"), "{}");
    const { autoGate } = autoGateCounter();
    const { provider } = scripted([
      ...Array.from({ length: 13 }, (_, n) => browse(n)),
      "answer",
    ]);
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      executionMode: "drive-to-green",
      // The REPL passes BOTH the auto gate's initially-resolved command and the
      // resolver — mirror that wiring exactly.
      accept: AUTO_ACCEPT,
      autoGate,
    });

    await session.send("look this up");
    const injected = session.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    expect(injected).toContain("STOP READING");
  });
});

describe("clearing the gate mid-session fully leaves build mode", () => {
  test("setGate('') swaps to the assistant prompt and withdraws check", async () => {
    const dir = await emptyDir();

    await writeFile(join(dir, "package.json"), "{}");
    const { autoGate } = autoGateCounter();
    const { provider, calls } = scripted(["ok"]);
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      executionMode: "drive-to-green",
      // The REPL passes BOTH the auto gate's initially-resolved command and the
      // resolver — mirror that wiring exactly.
      accept: AUTO_ACCEPT,
      autoGate,
    });

    session.setGate("");
    expect(systemText(session)).not.toContain("expert TypeScript engineer");
    await session.send("just fetch a page for me");
    expect(calls[0]?.tools).not.toContain("check");
  });
});

describe("repetition re-steer follows the gate", () => {
  test("with a live gate it asks for a file edit; without one it asks to save notes or move on", async () => {
    const { repetitionResteer } = await import("../src/loop/session");

    expect(repetitionResteer(true)).toContain("create or edit ONE file");
    expect(repetitionResteer(false)).not.toContain("edit ONE file");
    expect(repetitionResteer(false)).toContain("note");
    // Same lead-in, so harness-inject still classifies it as a harness message.
    expect(
      repetitionResteer(false).startsWith("You started repeating yourself")
    ).toBe(true);
  });
});

describe("a research session in a no-code folder has what it needs from turn 1", () => {
  test("note + browser tools offered, build-only tools not", async () => {
    const prev = process.env.TSFORGE_BROWSER_PORT;

    process.env.TSFORGE_BROWSER_PORT = String(
      49_000 + Math.floor(Math.random() * 10_000)
    );

    try {
      const { autoGate } = autoGateCounter();
      const { provider, calls } = scripted(["on it"]);
      const session = await Session.create({
        provider,
        cwd: await emptyDir(),
        files: ["**/*"],
        offerCheck: true,
        executionMode: "drive-to-green",
        accept: AUTO_ACCEPT,
        autoGate,
      });

      expect(await session.enableBrowser()).not.toBe("in-use");
      await session.send("read the thread in my active tab and take notes");

      const first = calls[0]?.tools ?? [];

      expect(first).toContain("note");
      expect(first).toContain("browser_read");
      expect(first).not.toContain("check");
      expect(first).not.toContain("pull_conventions");
    } finally {
      if (prev === undefined) {
        delete process.env.TSFORGE_BROWSER_PORT;
      } else {
        process.env.TSFORGE_BROWSER_PORT = prev;
      }
    }
  });
});
