/**
 * F19 enforcement: every path that can APPLY external plugin rules must re-verify
 * the frozen content first, and a drift must fail CLOSED. The unit-level freeze
 * check is covered in external-plugins.test.ts; these tests drive the real entry
 * points (write-time linter, write guard, command gate), because both original
 * criticals were swallow/caching bugs at those seams, not in the check itself.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadAndRegisterPlugins } from "../src/config/external-plugins";
import { clearExternalPacks } from "../src/rule-packs";
import { makeFileLinter } from "../src/gate";
import { commandGate } from "../src/gate/gate-runner";
import { runWriteGuard } from "../src/loop/write-guard";
import type { ILoopCtx } from "../src/loop/turn";
import { Session, type ILoopEvent } from "../src/loop";
import { TsService } from "../src/lsp";
import { call, scriptedModel } from "./helpers/scripted-model";

const dirs: string[] = [];

afterEach(async () => {
  clearExternalPacks();

  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function packSource(description: string): string {
  return `export const pack = {
  id: "freeze-pack",
  description: ${JSON.stringify(description)},
  rules: {},
  rulesConfig: {},
};
`;
}

/** A temp workspace with one registered external plugin, plus a `drift()` that
 *  rewrites the plugin on disk exactly as a mid-session edit would. */
async function workspaceWithPlugin(): Promise<{
  cwd: string;
  drift: () => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "tsforge-freeze-"));

  dirs.push(cwd);

  const entry = join(cwd, "plugin.ts");

  await writeFile(entry, packSource("strong"));
  await writeFile(join(cwd, "a.ts"), "export const a = 1;\n");
  await loadAndRegisterPlugins(
    [{ path: entry, packs: ["pack"] }],
    cwd,
    () => undefined
  );

  return { cwd, drift: () => writeFile(entry, packSource("weak")) };
}

describe("F19 enforcement: write-time linter", () => {
  test("rejects a drifted plugin instead of reporting the file clean", async () => {
    const { cwd, drift } = await workspaceWithPlugin();
    const lint = makeFileLinter("core", cwd, ["freeze-pack"]);

    await drift();

    // The linter's best-effort catch must NOT convert a drift into "no findings":
    // a clean result here is indistinguishable from a file that passed the moat.
    await expect(lint(join(cwd, "a.ts"))).rejects.toThrow(/changed on disk/);
  });

  test("re-checks the freeze on every lint, not only when the engine is built", async () => {
    const { cwd, drift } = await workspaceWithPlugin();
    const lint = makeFileLinter("core", cwd, ["freeze-pack"]);

    await lint(join(cwd, "a.ts"));
    await drift();

    // The ESLint engine is cached after the first call; if the check rides that
    // one-time branch, every mid-session edit after the first lint goes unseen.
    await expect(lint(join(cwd, "a.ts"))).rejects.toThrow(/changed on disk/);
  });
});

describe("F19 enforcement: write guard", () => {
  test("propagates plugin drift instead of swallowing it into empty feedback", async () => {
    const { cwd, drift } = await workspaceWithPlugin();

    await writeFile(
      join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["**/*.ts"],
      })
    );

    const ctx: ILoopCtx = {
      task: { id: "t", accept: "true", files: ["**/*.ts"] },
      cwd,
      tsService: new TsService(cwd),
      report: () => undefined,
      messages: [],
      tool: {},
      gate: {
        parse: undefined,
        lintFile: makeFileLinter("core", cwd, ["freeze-pack"]),
        runner: {
          run: () => Promise.resolve({ passed: true, errors: [], output: "" }),
        },
      },
    };

    await drift();

    await expect(runWriteGuard(ctx, "a.ts")).rejects.toThrow(/changed on disk/);
    // Cold work: a fresh TypeScript program + ESLint engine for a new plugin
    // workspace — ~1s locally, 5s+ on a shared CI runner (it timed out there at
    // bun's default 5s, and the late rejection then surfaced as a bogus
    // "expected promise that rejects"). Correctness test, not a perf budget.
  }, 30_000);
});

describe("F19 enforcement: the write path end to end", () => {
  test("a drift during a write stops the send instead of feeding it back", async () => {
    const { cwd, drift } = await workspaceWithPlugin();
    const events: ILoopEvent[] = [];

    await writeFile(
      join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["**/*.ts"],
      })
    );

    const session = await Session.create({
      provider: scriptedModel([
        {
          toolCalls: [
            call("create", { path: "b.ts", content: "export {};\n" }),
          ],
        },
      ]),
      cwd,
      files: ["**/*.ts"],
      accept: "true",
      lintFile: makeFileLinter("core", cwd, ["freeze-pack"]),
      report: (event) => events.push(event),
    });

    await drift();

    // `runWriteGuard` rethrowing only matters if its callers pass it on. They
    // are not in this diff, so the guarantee is theirs to prove: the send has to
    // END on the drift, not swallow it and carry on writing files under rules
    // that are no longer the ones that were loaded.
    const result = await session.send("write b.ts");

    expect(result.status).toBe("stuck");
    expect(
      events.some(
        (e) => e.kind === "stuck" && e.message.includes("changed on disk")
      )
    ).toBe(true);
    // Same cold TypeScript + ESLint start-up as the write-guard test above.
  }, 30_000);
});

describe("F19 enforcement: command gate", () => {
  test("fails closed before running the accept command", async () => {
    const { cwd, drift } = await workspaceWithPlugin();
    const gate = commandGate({ id: "t", accept: "true", files: [] }, undefined);

    await drift();

    await expect(gate.run(cwd, {})).rejects.toThrow(/changed on disk/);
  });

  test("the session's auto re-detecting gate fails closed too", async () => {
    const { cwd, drift } = await workspaceWithPlugin();
    const events: ILoopEvent[] = [];
    const session = await Session.create({
      provider: scriptedModel([
        {
          toolCalls: [
            call("create", { path: "b.ts", content: "export {};\n" }),
          ],
        },
      ]),
      cwd,
      files: ["**/*.ts"],
      autoGate: () =>
        Promise.resolve({
          command: "true",
          stackProfile: {
            name: "generic",
            packs: ["freeze-pack"],
            confidence: "guess",
            reason: "test",
          },
        }),
      report: (event) => events.push(event),
    });

    await drift();

    // `accept` is `true`, so this send passes the gate and reports success unless
    // the drift stops it: the auto gate re-resolves its command every cycle, and
    // that re-resolution must not become a way to run a cycle whose plugin
    // content was never re-verified.
    const result = await session.send("write b.ts");

    expect(result.status).toBe("stuck");
    expect(
      events.some(
        (e) => e.kind === "stuck" && e.message.includes("changed on disk")
      )
    ).toBe(true);
  });
});
