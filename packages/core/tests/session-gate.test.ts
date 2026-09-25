import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import type { IGate } from "../src/gate/gate-runner";
import { Session } from "../src/loop";
import { forcedGateInterval, resetDriveConvergence } from "../src/loop/session";
import type { ILoopState } from "../src/loop";
import type { IStackProfile } from "../src/stack-detection";

function loopState(over: Partial<ILoopState>): ILoopState {
  return {
    prevGateErrors: [],
    gateNoProgress: 0,
    bestErrorCount: Number.POSITIVE_INFINITY,
    noNewLow: 0,
    errorAge: new Map(),
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
    ttsrInterrupts: 0,
    steerLevel: 0,
    ...over,
  };
}

test("forcedGateInterval: dense gating when near-green or stalling, else the default", () => {
  // Before the first gate (lastGateCount -1) and when far from green → default (9).
  expect(forcedGateInterval(loopState({ lastGateCount: -1 }))).toBe(9);
  expect(forcedGateInterval(loopState({ lastGateCount: 20 }))).toBe(9);
  // Near-green (a small, non-zero error count) → dense (2) so the ladder can climb.
  expect(forcedGateInterval(loopState({ lastGateCount: 1 }))).toBe(2);
  expect(forcedGateInterval(loopState({ lastGateCount: 3 }))).toBe(2);
  // Already stalling (steer ladder started), even with many errors → dense (2).
  expect(
    forcedGateInterval(loopState({ lastGateCount: 20, steerLevel: 1 }))
  ).toBe(2);
});

test("resetDriveConvergence gives a revisit a fresh ladder while preserving cumulative metrics", () => {
  const state = loopState({
    prevGateErrors: [{ key: "api", message: "old API block", phase: 1 }],
    gateNoProgress: 10,
    bestErrorCount: 1,
    noNewLow: 10,
    lastGateCount: 1,
    edits: 17,
    regressions: 3,
    steerLevel: 4,
    redGates: 8,
    plateauBest: 1,
    blockFingerprint: "api",
    pendingRung: "R3",
    pendingBlockFingerprint: "api",
    triedLeversByBlock: new Map([["api", new Set(["R1", "R2", "R3"])]]),
    // WS-B is per-drive — the send-boundary reset must clear its watermark + budget too.
    nearGreenBest: 1,
    nearGreenRollbacks: 3,
    // #77: the rotation window + flag are per-drive too — a stale flag would inject the
    // completion-only steer on a fresh drive with no evidence.
    nearGreenSamples: [{ count: 1, phase: 0, sig: "a", rev: "r0" }],
    nearGreenSpikeGap: 2,
    nearGreenRotation: true,
  });

  resetDriveConvergence(state);

  expect(state.prevGateErrors).toEqual([]);
  expect(state.steerLevel).toBe(0);
  expect(state.blockFingerprint).toBe("");
  expect(state.triedLeversByBlock?.size).toBe(0);
  expect(state.plateauBest).toBeUndefined();
  expect(state.edits).toBe(17);
  expect(state.regressions).toBe(3);
  // WS-B per-drive state is cleared at the send boundary (not just in driveInner).
  expect(state.nearGreenBest).toBeUndefined();
  expect(state.nearGreenRollbacks).toBeUndefined();
  expect(state.nearGreenCheckpoint).toBeUndefined();
  // #77: the rotation window + flag + spike-gap are per-drive — cleared so they can't leak.
  expect(state.nearGreenSamples).toBeUndefined();
  expect(state.nearGreenSpikeGap).toBeUndefined();
  expect(state.nearGreenRotation).toBeUndefined();
});

test("setGate wins a race against an in-flight autoGate re-resolution (Phaser build bug)", async () => {
  // Real-world trace: a Phaser slice build calls setGate("bun run check") but the
  // model's gate run kept reporting tsforge's own auto-gate identity + a TS5058 for
  // .tsforge/tsconfig.gate.json — a file only the auto-gate's tscPart() ever writes.
  // Root cause: setGate(string) only flips `state.active` and overwrites
  // `ctx.task.accept` — it never replaces `ctx.gate.runner`, so an autoGate
  // resolution ALREADY in flight (state.active read as true before the flip) still
  // overwrites `ctx.task.accept` back to the auto-gate command once it resolves,
  // even though setGate ran in between.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-gate-race-"));

  try {
    // A build session: the folder has a project, so the auto gate is live (an
    // auto gate in a folder with no code stays dormant and never resolves).
    await writeFile(join(dir, "package.json"), "{}");

    let releaseAutoGate: () => void = () => undefined;
    const released = new Promise<void>((res) => {
      releaseAutoGate = res;
    });
    let autoGateStarted: () => void = () => undefined;
    const started = new Promise<void>((res) => {
      autoGateStarted = res;
    });
    let autoGateCalls = 0;

    const autoGate = async (): Promise<{
      command: string;
      stackProfile: IStackProfile;
    }> => {
      autoGateCalls += 1;
      autoGateStarted();
      await released; // pauses here — simulates the resolution being in flight

      return {
        command: "echo AUTO-GATE-COMMAND",
        stackProfile: {
          name: "generic",
          packs: [],
          confidence: "guess",
          reason: "test fixture",
        },
      };
    };

    let turn = 0;
    const provider: IProvider = {
      async complete() {
        turn += 1;

        if (turn === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "check", arguments: {} }],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };

    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      offerCheck: true,
      executionMode: "drive-to-green",
      autoGate,
    });

    const sendPromise = session.send("run check");

    await started; // the auto-gate resolver is now in flight, paused
    session.setGate("echo MANUAL-GATE-COMMAND"); // the race: fires WHILE resolve() is pending
    releaseAutoGate(); // let the paused resolution finish and (buggy) overwrite accept

    await sendPromise;

    expect(autoGateCalls).toBeGreaterThan(0);
    expect(
      (session as unknown as { ctx: { task: { accept: string } } }).ctx.task
        .accept
    ).toBe("echo MANUAL-GATE-COMMAND");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Session.setGate flips hasGate on and routes the gate through the loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-gate-"));

  try {
    // Provider that creates a file on first call, then yields on second.
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

    // A gate that fails once then passes, proving the loop calls the injected runner.
    let gateCalls = 0;
    const gate: IGate = {
      run: async () => {
        gateCalls += 1;

        return gateCalls === 1
          ? { passed: false, errors: [{ key: "x", message: "x" }], output: "x" }
          : { passed: true, errors: [], output: "ok" };
      },
    };

    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
    });

    session.setGate(gate);
    // After setGate, the session should route gate.run through the loop.
    // The loop will: (1) create file, (2) yield, (3) run gate (fail), (4) create turns until gate passes.
    const result = await session.send("create x.ts");

    // The gate was called at least once.
    expect(gateCalls).toBeGreaterThan(0);
    // After setGate injected a gate, the session should run it and report done
    // when the gate passes.
    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
