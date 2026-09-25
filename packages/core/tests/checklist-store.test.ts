import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addItemInPlan,
  completeItemInPlan,
  focusItemInPlan,
  isChecklistComplete,
  loadPlan,
  savePlan,
  uncompleteItemInPlan,
  updateItemFieldsInPlan,
} from "../src/loop/worklist/checklist-store";
import type { IPlanDocument } from "../src/loop/worklist/checklist.types";
import {
  doTaskAdd,
  doTaskComplete,
  doTaskFocus,
  doTaskList,
  doTaskUpdate,
} from "../src/loop/tools/task-tools";
import type { IToolContext } from "../src/loop/tools/tool-context";

function samplePlan(id: string): IPlanDocument {
  return {
    schemaVersion: 2,
    id,
    goal: "ship",
    activeItemId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [
      {
        id: "parent",
        title: "Parent",
        status: "pending",
        children: [
          { id: "child-a", title: "Child A", status: "pending" },
          { id: "child-b", title: "Child B", status: "pending" },
        ],
      },
    ],
  };
}

describe("checklist-store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-plan-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("refuses parent complete while children open; auto-completes parent", () => {
    let plan = samplePlan("p1");
    const refuse = completeItemInPlan(plan, "parent");

    expect(refuse.ok).toBe(false);

    const a = completeItemInPlan(plan, "child-a");

    expect(a.ok).toBe(true);

    if (!a.ok) {
      return;
    }

    plan = a.plan;
    const b = completeItemInPlan(plan, "child-b");

    expect(b.ok).toBe(true);

    if (!b.ok) {
      return;
    }

    expect(b.plan.items[0]?.status).toBe("done");
    expect(isChecklistComplete(b.plan)).toBe(true);
  });

  test("focus + uncomplete persist via tools scoped to activePlanId", async () => {
    const plan = samplePlan("bound");

    savePlan(dir, plan);

    const reports: string[] = [];
    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: (e) => {
        if (e.kind === "tool" && typeof e.message === "string") {
          reports.push(e.message);
        }
      },
      task: "session",
      activePlanId: "bound",
      runTaskGate: async () => ({
        passed: true,
        errors: [],
        output: "",
        autoFixed: [],
        autoFixSummary: [],
        command: "true",
        packs: ["generic-ts"],
      }),
    };

    expect(doTaskList({}, ctx)).toContain("Parent");

    const focused = doTaskFocus({ id: "child-a" }, ctx);

    expect(focused).toContain("focused:");
    expect(loadPlan(dir, "bound")?.activeItemId).toBe("child-a");

    await doTaskComplete({ id: "child-a" }, ctx);
    expect(loadPlan(dir, "bound")?.items[0]?.children?.[0]?.status).toBe(
      "done"
    );
    // Human title lines — never dump the plan UUID into the TUI scrollback.
    expect(reports.some((m) => m.startsWith("done ·"))).toBe(true);
    expect(reports.some((m) => m.includes("Child A"))).toBe(true);
    expect(reports.every((m) => !m.includes("plan bound"))).toBe(true);
    expect(reports.every((m) => !/plan [0-9a-f-]{8,}/i.test(m))).toBe(true);
    expect(reports.some((m) => m.startsWith("focus ·"))).toBe(true);
    expect(reports.some((m) => m.startsWith("gate · checking"))).toBe(true);

    const other: IToolContext = { ...ctx, activePlanId: "missing" };

    expect(doTaskList({}, other)).toMatch(/no active plan|missing/i);
  });

  test("task_complete refuses when gate is red — item stays open", async () => {
    const plan = samplePlan("red");

    savePlan(dir, plan);

    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: () => undefined,
      task: "session",
      activePlanId: "red",
      runTaskGate: async () => ({
        passed: false,
        errors: [{ key: "x", message: "TS2304: Cannot find name 'x'" }],
        output: "fail",
        autoFixed: [],
        autoFixSummary: [],
        command: "bun test",
        packs: ["code-flow", "env-access"],
      }),
    };

    const out = await doTaskComplete({ id: "child-a" }, ctx);

    expect(out).toMatch(/gate RED/i);
    expect(out).toContain("Check: bun test");
    expect(out).toContain("Packs: code-flow, env-access");
    expect(loadPlan(dir, "red")?.items[0]?.children?.[0]?.status).toBe(
      "pending"
    );
  });

  test("task_complete without a gate completes the item, marked unvalidated", async () => {
    const plan = samplePlan("nogate");

    savePlan(dir, plan);

    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: () => undefined,
      task: "session",
      activePlanId: "nogate",
    };

    const out = await doTaskComplete({ id: "child-a" }, ctx);

    // No gate (a research/notes session, or an auto gate waiting for code):
    // nothing to validate against, so refusing forever just strands the plan.
    expect(out).toContain("completed: Child A");
    expect(out).toMatch(/no gate/i);
    expect(loadPlan(dir, "nogate")?.items[0]?.children?.[0]?.status).toBe(
      "done"
    );
  });

  test("focus/uncomplete helpers", () => {
    let plan = samplePlan("p2");
    const skip = focusItemInPlan(plan, "child-b");

    expect(skip.ok).toBe(false);

    if (!skip.ok) {
      expect(skip.error).toMatch(/Child A/);
    }

    const focusedA = focusItemInPlan(plan, "child-a");

    expect(focusedA.ok).toBe(true);

    if (!focusedA.ok) {
      return;
    }

    plan = focusedA.plan;
    expect(plan.activeItemId).toBe("child-a");

    const doneA = completeItemInPlan(plan, "child-a");

    expect(doneA.ok).toBe(true);

    if (!doneA.ok) {
      return;
    }

    plan = doneA.plan;
    const focusedB = focusItemInPlan(plan, "child-b");

    expect(focusedB.ok).toBe(true);

    if (!focusedB.ok) {
      return;
    }

    plan = focusedB.plan;
    expect(plan.activeItemId).toBe("child-b");

    const done = completeItemInPlan(plan, "child-b");

    expect(done.ok).toBe(true);

    if (!done.ok) {
      return;
    }

    const undone = uncompleteItemInPlan(done.plan, "child-b");

    expect(undone.ok).toBe(true);

    if (!undone.ok) {
      return;
    }

    expect(undone.plan.items[0]?.children?.[1]?.status).toBe("pending");
  });

  test("addItemInPlan appends root and nested; reopens done parent", () => {
    let plan = samplePlan("add");
    const root = addItemInPlan(
      plan,
      { title: "New root" },
      "2026-01-02T00:00:00.000Z",
      () => "new-root"
    );

    expect(root.ok).toBe(true);

    if (!root.ok) {
      return;
    }

    plan = root.plan;
    expect(plan.items.at(-1)?.id).toBe("new-root");

    const doneParent = completeItemInPlan(
      {
        ...plan,
        items: [
          {
            id: "solo",
            title: "Solo",
            status: "pending",
          },
        ],
      },
      "solo"
    );

    expect(doneParent.ok).toBe(true);

    if (!doneParent.ok) {
      return;
    }

    const nested = addItemInPlan(
      doneParent.plan,
      { title: "Child of done", parentId: "solo" },
      "2026-01-02T00:00:00.000Z",
      () => "new-child"
    );

    expect(nested.ok).toBe(true);

    if (!nested.ok) {
      return;
    }

    expect(nested.plan.items[0]?.status).toBe("pending");
    expect(nested.plan.items[0]?.children?.[0]?.id).toBe("new-child");
  });

  test("updateItemFieldsInPlan edits title and clears detail", () => {
    const plan = samplePlan("upd");
    const updated = updateItemFieldsInPlan(plan, "child-a", {
      title: "Renamed",
      detail: "",
    });

    expect(updated.ok).toBe(true);

    if (!updated.ok) {
      return;
    }

    expect(updated.plan.items[0]?.children?.[0]?.title).toBe("Renamed");
    expect(updated.plan.items[0]?.children?.[0]?.detail).toBeUndefined();
  });

  test("task_add / task_update tools persist", () => {
    const plan = samplePlan("tools-mut");

    savePlan(dir, plan);

    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: () => undefined,
      task: "session",
      activePlanId: "tools-mut",
    };

    const added = doTaskAdd(
      { title: "Discovered work", parent_id: "parent" },
      ctx
    );

    expect(added).toContain("added:");
    expect(loadPlan(dir, "tools-mut")?.items[0]?.children).toHaveLength(3);

    const updated = doTaskUpdate(
      { id: "child-a", title: "Child A revised", detail: "more" },
      ctx
    );

    expect(updated).toContain("updated:");
    expect(loadPlan(dir, "tools-mut")?.items[0]?.children?.[0]?.title).toBe(
      "Child A revised"
    );
    expect(loadPlan(dir, "tools-mut")?.items[0]?.children?.[0]?.detail).toBe(
      "more"
    );
  });
});
