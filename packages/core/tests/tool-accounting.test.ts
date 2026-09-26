import { test, expect, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runToolCalls,
  countsAsMutation,
  type ILoopCtx,
  type ILoopState,
  type ILoopEvent,
} from "../src/loop";
import { TsService } from "../src/lsp";
import { TOOL_NAME, READ_ONLY_TOOL_NAMES } from "../src/agent";
import { commandGate } from "../src/gate/gate-runner";
import * as writeGuardMod from "../src/loop/write-guard";

// P1 (review): add_dependency rewrites package.json even in a narrow-scoped task
// where it isn't in the editable globs. That sanctioned manifest change MUST still
// re-gate (the supply-chain meta-rules catch unpinned/git/tarball deps) — so the
// mutation predicate exempts package.json from the scope check, but nothing else.
test("countsAsMutation: package.json always counts; other out-of-scope paths don't", () => {
  expect(countsAsMutation("package.json", ["src/**"])).toBe(true);
  expect(countsAsMutation("src/a.ts", ["src/**"])).toBe(true);
  expect(countsAsMutation("secret.ts", ["src/**"])).toBe(false);
  expect(countsAsMutation("vendor/x.ts", ["src/**"])).toBe(false);
});

function freshState(): ILoopState {
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
  };
}

function ctxFor(cwd: string, files: string[]): ILoopCtx {
  return {
    task: { id: "t", accept: "true", files },
    cwd,
    tsService: null,
    report: () => undefined,
    messages: [],
    tool: {},
    gate: {
      parse: undefined,
      runner: commandGate({ id: "t", accept: "true", files }, undefined),
    },
  };
}

// P2: an edit/create is counted only when it actually wrote — not pre-counted
// from the tool name (which inflated churn and re-gated after no-op failures).
test("a successful in-scope create counts as one edit and re-gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "create",
          arguments: { file: "x.ts", content: "export const x = 1;\n" },
        },
      ],
      ctxFor(dir, ["**/*"]),
      state
    );

    expect(touched).toBe(true);
    expect(state.edits).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Critical (PR #50 review): ONE `script` call can write MANY files via its
// edit/create stubs. runToolCalls tracked a single `wrote.path` and overwrote it
// per event, so every file but the LAST skipped the write-guard AND `touched`
// (which drives change-scoped rules like test-sibling-required). All written
// files must be recorded + counted.
test("a script that writes several files records ALL of them in touched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-script-"));

  try {
    const ctx: ILoopCtx = {
      ...ctxFor(dir, ["**/*"]),
      tool: { touched: new Set() },
    };
    const state = freshState();
    const code = [
      'import { create } from "./tsforge-tools";',
      'await create({ file: "a.ts", content: "export const a = 1;\\n" });',
      'await create({ file: "b.ts", content: "export const b = 2;\\n" });',
      'await create({ file: "c.ts", content: "export const c = 3;\\n" });',
      'console.log("done");',
    ].join("\n");

    const touched = await runToolCalls(
      [{ name: TOOL_NAME.script, arguments: { code } }],
      ctx,
      state
    );

    expect(touched).toBe(true);
    // All three writes counted (not just the last), and all three recorded.
    expect(state.edits).toBe(3);
    expect([...(ctx.tool.touched ?? [])].sort()).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    expect(await Bun.file(join(dir, "a.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "c.ts")).exists()).toBe(true);
    // The per-run temp dir is cleaned up (no `.tsforge-script-*` left behind).
    const leftovers = [...new Bun.Glob(".tsforge-script-*").scanSync(dir)];

    expect(leftovers).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P2: a same-content edit (oldString === newString, or already-applied) writes
// nothing. The handler must NOT emit an edit event for it, so it neither counts
// toward `state.edits` nor re-gates — otherwise a no-op edit lets a green gate
// claim "done" though disk never changed (and can mask a spinning model).
test("a no-op edit (same content) is NOT counted and does not re-gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-noop-"));

  try {
    await Bun.write(join(dir, "x.ts"), "export const x = 1;\n");

    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "edit",
          arguments: {
            file: "x.ts",
            oldString: "const x = 1;",
            newString: "const x = 1;", // identical → no real change
          },
        },
      ],
      ctxFor(dir, ["**/*"]),
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an out-of-scope edit is NOT counted and does not re-gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "edit",
          arguments: {
            file: "secret.ts",
            oldString: "a",
            newString: "b",
          },
        },
      ],
      ctxFor(dir, ["src/**"]), // secret.ts is out of scope
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P1: move_file relocates a file AND rewrites every importer, but reports a
// `tool` event (not edit/create) so `wrote.value` stays false. It must still be
// counted as a semantic write so the gate re-runs — otherwise a move could end
// the turn as "responded" with the relocation/import-rewrites never gated.
test("a move_file re-gates even though it is not an edit/create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-move-"));

  try {
    await Bun.write(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
      })
    );
    await Bun.write(
      join(dir, "types.ts"),
      "export interface IThing {\n  value: number;\n}\n"
    );
    await Bun.write(
      join(dir, "use.ts"),
      'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
    );

    const task = { id: "t", accept: "true", files: ["**/*"] };
    const ctx: ILoopCtx = {
      task,
      cwd: dir,
      tsService: new TsService(dir),
      report: () => undefined,
      messages: [],
      tool: {},
      gate: {
        parse: undefined,
        runner: commandGate(task, undefined),
      },
    };
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "move_file",
          arguments: { from: "types.ts", to: "lib/types.ts" },
        },
      ],
      ctx,
      state
    );

    // The move actually happened...
    expect(await Bun.file(join(dir, "lib/types.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "use.ts")).text()).toContain("lib/types");
    // ...and it re-gates (this was `false` before the fix). Semantic writes
    // don't feed state.edits, so only the re-gate signal changes.
    expect(touched).toBe(true);
    // The moved file joins the change scope (so test-sibling et al. cover it).
    expect([...(ctx.tool.touched ?? [])]).toContain("lib/types.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Semantic mutations re-gate but skip the per-write guard (the model did not
// hand-write those paths — runWriteGuard is for edit/create only).
test("move_file re-gates without invoking runWriteGuard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-wg-skip-"));
  const guardSpy = spyOn(writeGuardMod, "runWriteGuard").mockResolvedValue(
    "\n[write-guard-marker]"
  );

  try {
    await Bun.write(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
      })
    );
    await Bun.write(
      join(dir, "types.ts"),
      "export interface IThing {\n  value: number;\n}\n"
    );
    await Bun.write(
      join(dir, "use.ts"),
      'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
    );

    const task = { id: "t", accept: "true", files: ["**/*"] };
    const ctx: ILoopCtx = {
      task,
      cwd: dir,
      tsService: new TsService(dir),
      report: () => undefined,
      messages: [],
      tool: {},
      gate: {
        parse: undefined,
        runner: commandGate(task, undefined),
      },
    };
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "move_file",
          arguments: { from: "types.ts", to: "lib/types.ts" },
        },
      ],
      ctx,
      state
    );

    expect(touched).toBe(true);
    expect(guardSpy.mock.calls.length).toBe(0);
  } finally {
    guardSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

// P1: a rejected (out-of-scope) move_file must NOT re-gate — the old name-based
// branch set touched:true by tool NAME, so a rejected op could let a green gate
// claim "done" though nothing moved. Now the signal is the `mutated` event, which
// a reject never emits.
test("a rejected (out-of-scope) move_file does NOT re-gate (no false 'done')", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-reject-"));

  try {
    await Bun.write(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
      })
    );
    await Bun.write(
      join(dir, "types.ts"),
      "export interface IThing {\n  value: number;\n}\n"
    );
    // use.ts imports types.ts and is OUT of editable scope → moving types.ts
    // would rewrite a read-only importer, so the move is rejected.
    await Bun.write(
      join(dir, "use.ts"),
      'import type { IThing } from "./types";\nexport const f = (t: IThing): number => t.value;\n'
    );

    const task = {
      id: "t",
      accept: "true",
      files: ["types.ts", "lib/types.ts"],
    };
    const ctx: ILoopCtx = {
      task,
      cwd: dir,
      tsService: new TsService(dir),
      report: () => undefined,
      messages: [],
      tool: {},
      gate: {
        parse: undefined,
        runner: commandGate(task, undefined),
      },
    };
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "move_file",
          arguments: { from: "types.ts", to: "lib/types.ts" },
        },
      ],
      ctx,
      state
    );

    expect(touched).toBe(false);
    // Nothing moved.
    expect(await Bun.file(join(dir, "types.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "lib/types.ts")).exists()).toBe(false);
    expect(ctx.tool.touched?.size ?? 0).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// WS1: structural meta-rules used to fire only at the end-of-turn gate. The
// single-file-safe subset now runs PER-WRITE, so a logic file created without a
// test gets the test-sibling nudge immediately in the tool result — not after the
// model has built more on top of it.
test("a created logic file without a test gets an immediate per-write nudge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-perwrite-"));

  try {
    const ctx = ctxFor(dir, ["**/*"]);
    const state = freshState();

    await runToolCalls(
      [
        {
          name: "create",
          arguments: {
            file: "calc.ts",
            content:
              "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
          },
        },
      ],
      ctx,
      state
    );

    const toolMsg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    // The structural nudge rode back on THIS write (not deferred to the gate).
    expect(toolMsg).toContain("test-sibling-required");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A co-located test means no nudge — the per-write check is satisfied immediately.
test("a created logic file WITH a co-located test gets no test nudge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-perwrite2-"));

  try {
    await Bun.write(
      join(dir, "calc.test.ts"),
      'import { test } from "bun:test";\ntest("x", () => {});\n'
    );

    const ctx = ctxFor(dir, ["**/*"]);
    const state = freshState();

    await runToolCalls(
      [
        {
          name: "create",
          arguments: {
            file: "calc.ts",
            content:
              "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
          },
        },
      ],
      ctx,
      state
    );

    const toolMsg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    expect(toolMsg).not.toContain("test-sibling-required");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed edit (oldString not found) is NOT counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    await Bun.write(join(dir, "y.ts"), "export const y = 1;\n");

    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "edit",
          arguments: {
            file: "y.ts",
            oldString: "this text is not in the file",
            newString: "z",
          },
        },
      ],
      ctxFor(dir, ["**/*"]),
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The MUTATING-TOOL ACCOUNTING CONTRACT, made structural: every registered tool is
// classified exactly once — read-only (plan-mode safe), mutating (must report a
// change so the gate re-runs), or special (run/yield, exempt with a reason). A NEW
// tool that lands in zero buckets fails here until someone decides which it is —
// the guard that would have caught scaffold_web silently mutating from day one.
const MUTATING_TOOLS = new Set<string>([
  TOOL_NAME.edit,
  TOOL_NAME.editLines,
  TOOL_NAME.create,
  TOOL_NAME.renameSymbol,
  TOOL_NAME.moveFile,
  TOOL_NAME.organizeImports,
  TOOL_NAME.addDependency,
  // Removing a file changes what compiles, so it re-gates like any scoped write.
  TOOL_NAME.deleteFile,
]);
// run = the model's raw shell (writes are its own, not scoped harness edits);
// script = runs a program whose tool calls (incl. edit/create) re-enter
// executeTool and report their OWN mutations, so the script call itself accounts
// for nothing; generate_image writes ONLY to the .tsforge/images artifact dir
// (not gated source) and reports no mutation, so it triggers no re-gate;
// check = runs the acceptance gate on demand (WS-G). The gate's autofix may
// reformat files, but check reports NO scoped mutation and returns the errors as
// its result — the loop does not re-gate off it. Not plan-mode-safe (readOnly:false)
// because that autofix touches source, so it's special-with-reason, not read-only.
const SPECIAL_TOOLS = new Set<string>([
  TOOL_NAME.run,
  TOOL_NAME.script,
  TOOL_NAME.generateImage,
  TOOL_NAME.check,
  // git_write / github_write mutate git + the GitHub remote (commit/push, PR
  // create/comment, resolve thread) — NOT gated workspace source — so they report
  // no scoped mutation and never re-gate. Side-effecting-but-unscoped, exactly
  // like `run`: special-with-reason, not mutating. (github_read is read-only.)
  TOOL_NAME.gitWrite,
  TOOL_NAME.githubWrite,
  // linear_write mutates an external tracker (create card/comment) and linear_start
  // checks out a git branch — neither writes gated workspace source, so neither
  // re-gates. Special-with-reason, like git_write. (linear_read is read-only.)
  TOOL_NAME.linearWrite,
  TOOL_NAME.linearStart,
  // Notion + Sentry writes mutate an external service (create/append page, resolve
  // an issue), not gated source → no re-gate. Special-with-reason. (Their *_read
  // verbs are read-only.)
  TOOL_NAME.notionWrite,
  TOOL_NAME.sentryWrite,
  // Checklist mutations touch plan JSON under .tsforge/, not gated source —
  // no scoped edit count / re-gate. task_list + present_plan are read-only.
  TOOL_NAME.taskFocus,
  TOOL_NAME.taskComplete,
  TOOL_NAME.taskUncomplete,
  TOOL_NAME.taskAdd,
  TOOL_NAME.taskUpdate,
  // `note` appends research notes to notes/<topic>.md — not gated source, no
  // scoped edit, no re-gate. Not plan-mode-safe (it writes to disk).
  TOOL_NAME.note,
  // `append` adds lines to a DATA file (jsonl/csv/log); code and config files are
  // refused, so it never writes gated source and needs no re-gate.
  TOOL_NAME.append,
  // `reddit_mark_read` only appends to the notes/<topic>/sources.md ledger.
  TOOL_NAME.redditMarkRead,
]);

test("every registered tool is classified read-only, mutating, or special", () => {
  for (const name of Object.values(TOOL_NAME)) {
    const buckets = [
      READ_ONLY_TOOL_NAMES.has(name),
      MUTATING_TOOLS.has(name),
      SPECIAL_TOOLS.has(name),
    ].filter(Boolean).length;

    expect({ name, buckets }).toEqual({ name, buckets: 1 });
  }
});

// ── P1/P2 contract regression tests (harness review: tools) ────────────────────

/** A report sink that records every event, plus the ctx wired to it. */
function collectingCtx(
  cwd: string,
  files: string[]
): { ctx: ILoopCtx; events: ILoopEvent[] } {
  const events: ILoopEvent[] = [];
  const task = { id: "t", accept: "true", files };
  const ctx: ILoopCtx = {
    task,
    cwd,
    tsService: null,
    report: (e) => {
      events.push(e);
    },
    messages: [],
    tool: {},
    gate: {
      parse: undefined,
      runner: commandGate(task, undefined),
    },
  };

  return { ctx, events };
}

/** True when the FS enforces a chmod 555 (root bypasses perms → caller skips). */
async function permsEnforced(dir: string): Promise<boolean> {
  try {
    await Bun.write(join(dir, ".probe"), "x");
    await rm(join(dir, ".probe"), { force: true });

    return false;
  } catch {
    return true;
  }
}

// P1: a handler that THROWS (here `create` hitting an unwritable dir → EACCES) must
// be caught at the executeTool boundary and returned as a tool-error string — never
// thrown into runToolCalls. The write didn't happen, so it isn't counted.
test("a throwing create is caught (no crash), reported FAILED, and not counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    await mkdir(join(dir, "ro"), { recursive: true });
    await chmod(join(dir, "ro"), 0o555);

    if (!(await permsEnforced(join(dir, "ro")))) {
      return; // running as root — perms not enforced
    }

    const { ctx } = collectingCtx(dir, ["**/*"]);
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "create",
          arguments: { file: "ro/x.ts", content: "export const x = 1;\n" },
        },
      ],
      ctx,
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
    const msg = ctx.messages.find((m) => m.role === "tool")?.content ?? "";

    expect(msg).toContain("FAILED");
    expect(await Bun.file(join(dir, "ro/x.ts")).exists()).toBe(false);
  } finally {
    await chmod(join(dir, "ro"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

// add_dependency validates names offline (no network) — an invalid spec rejects and
// nothing is written/counted.
test("add_dependency rejects an invalid package spec and does not mutate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ name: "t", version: "1.0.0" })
    );

    const { ctx } = collectingCtx(dir, ["**/*"]);
    const state = freshState();
    const touched = await runToolCalls(
      [{ name: "add_dependency", arguments: { packages: "../evil" } }],
      ctx,
      state
    );

    expect(touched).toBe(false);
    expect(state.edits).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The vendored "you cannot edit this file" concept was removed entirely — a model
// may now edit ANY in-scope file, including a generated `*.gen.ts` (the build
// regenerates it anyway; guidance, not a hard block, steers the model off it).
test("a generated *.gen.ts file is editable (the vendored block is gone)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-acct-"));

  try {
    const state = freshState();
    const touched = await runToolCalls(
      [
        {
          name: "create",
          arguments: {
            file: "src/routeTree.gen.ts",
            content: "export const routeTree = {};\n",
          },
        },
      ],
      ctxFor(dir, ["**/*"]),
      state
    );

    expect(touched).toBe(true);
    expect(state.edits).toBe(1);
    expect(await Bun.file(join(dir, "src/routeTree.gen.ts")).exists()).toBe(
      true
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Codex P2a + Gemini G4: `spawn_agent` calls used to be pre-run in one batch
// BEFORE the sequential loop, so an `edit`→`spawn` turn made the subagent read
// the PRE-edit workspace. Now a non-spawn tool is an ordering barrier: the edit
// applies first. Consecutive spawns still batch, and one failing spawn is
// isolated to its own reply (never sinks its sibling).
test("a preceding edit applies BEFORE a spawn (barrier); a failing spawn is isolated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-spawn-order-"));

  try {
    const seen: { markerAtSpawn: boolean; ids: string[] } = {
      markerAtSpawn: false,
      ids: [],
    };
    const ctx = ctxFor(dir, ["**/*"]);

    ctx.tool.spawnAgent = (req) => {
      // The `create` below precedes the spawns — with the barrier it has already
      // written marker.ts by the time any subagent runs.
      seen.markerAtSpawn =
        seen.markerAtSpawn || existsSync(join(dir, "marker.ts"));
      seen.ids.push(req.subagentType);

      if (req.subagentType === "boom") {
        throw new Error("kaboom");
      }

      return Promise.resolve(`[${req.subagentType}] ok`);
    };

    const ctxMessages = ctx.messages;

    await runToolCalls(
      [
        {
          name: "create",
          arguments: { file: "marker.ts", content: "export const m = 1;\n" },
        },
        {
          name: "spawn_agent",
          arguments: {
            subagent_type: "explore",
            description: "d",
            prompt: "p",
          },
        },
        {
          name: "spawn_agent",
          arguments: { subagent_type: "boom", description: "d", prompt: "p" },
        },
      ],
      ctx,
      freshState()
    );

    // Barrier: the edit ran first, so the subagent saw the created file.
    expect(seen.markerAtSpawn).toBe(true);
    // Both consecutive spawns ran (batched), in order.
    expect(seen.ids).toEqual(["explore", "boom"]);
    // Three tool replies (create + two spawns); the failing spawn is isolated.
    const toolReplies = ctxMessages.filter((m) => m.role === "tool");

    expect(toolReplies).toHaveLength(3);
    expect(toolReplies[1]?.content).toContain("[explore] ok");
    // The sibling failure is surfaced in ITS OWN reply (isolated) with the reason.
    expect(toolReplies[2]?.content).toContain("kaboom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
