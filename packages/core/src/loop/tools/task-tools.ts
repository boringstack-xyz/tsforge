import type {
  ChecklistItemKind,
  IPlanDocument,
} from "../worklist/checklist.types";
import {
  addItemInPlan,
  completeItemInPlan,
  findItem,
  focusItemInPlan,
  formatPlanTree,
  loadPlan,
  savePlan,
  uncompleteItemInPlan,
  updateItemFieldsInPlan,
} from "../worklist/checklist-store";
import { formatGateIdentity } from "../gate-visibility";
import { reject, str, type IToolContext } from "./tool-context";

type TaskMutateTool =
  | "task_focus"
  | "task_complete"
  | "task_uncomplete"
  | "task_add"
  | "task_update";

/** User-facing verb for settled checklist tool lines (no plan UUID). */
const TASK_REPORT_VERB: Record<TaskMutateTool, string> = {
  task_focus: "focus",
  task_complete: "done",
  task_uncomplete: "reopen",
  task_add: "add",
  task_update: "update",
};

function parseKind(raw: unknown): ChecklistItemKind | undefined {
  return raw === "investigate" ||
    raw === "create" ||
    raw === "modify" ||
    raw === "test"
    ? raw
    : undefined;
}

function parseFiles(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  if (!raw.every((f): f is string => typeof f === "string")) {
    return undefined;
  }

  return raw;
}

function requirePlan(
  ctx: IToolContext
): { ok: true; planId: string; cwd: string } | { ok: false; error: string } {
  const planId = ctx.activePlanId;

  if (typeof planId !== "string" || planId.length === 0) {
    return {
      ok: false,
      error:
        "no active plan bound to this session — approve a plan in plan mode first",
    };
  }

  return { ok: true, planId, cwd: ctx.cwd };
}

function persistAndNotify(
  ctx: IToolContext,
  plan: IPlanDocument,
  tool: TaskMutateTool,
  title: string
): void {
  savePlan(ctx.cwd, plan);
  ctx.onPlanChanged?.(plan);
  const label = title.trim().length > 0 ? title.trim() : "(untitled)";

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `${TASK_REPORT_VERB[tool]} · ${label}`,
  });
}

/** List the session-bound plan tree (status is tools-only; this is the mirror). */
export function doTaskList(
  _args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_list", bound.error);
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_list",
      `active plan file missing: ${bound.planId}`
    );
  }

  return formatPlanTree(plan);
}

/** Focus one open item (sets activeItemId + status active). */
export function doTaskFocus(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_focus", bound.error);
  }

  const id = str(args, "id").trim();

  if (id.length === 0) {
    return reject(
      ctx,
      "task_focus",
      "task_focus needs `id` (item UUID from task_list)"
    );
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_focus",
      `active plan file missing: ${bound.planId}`
    );
  }

  const result = focusItemInPlan(plan, id);

  if (!result.ok) {
    return reject(ctx, "task_focus", result.error);
  }

  const item = findItem(result.plan.items, id);

  persistAndNotify(ctx, result.plan, "task_focus", item?.title ?? id);

  return [
    `focused: ${item?.title ?? id}`,
    item?.verify !== undefined ? `verify hint: ${item.verify}` : "",
    item?.detail !== undefined ? `detail: ${item.detail}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Mark an item done ONLY when the acceptance gate is green.
 * Runs the same full evaluation as `check` / end-of-turn settle — refuses (and
 * leaves the item open) when the gate is red. The gate is the authority; the
 * checklist must not claim done ahead of it.
 */
export async function doTaskComplete(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_complete", bound.error);
  }

  const id = str(args, "id").trim();

  if (id.length === 0) {
    return reject(
      ctx,
      "task_complete",
      "task_complete needs `id` (item UUID from task_list)"
    );
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_complete",
      `active plan file missing: ${bound.planId}`
    );
  }

  // No live gate (a research/notes session, or an auto gate still waiting for
  // code): there is nothing to validate against, and refusing forever strands
  // the plan. Complete it and say it wasn't gate-checked.
  const unvalidated = ctx.runTaskGate === undefined;
  const gateError =
    ctx.runTaskGate === undefined
      ? null
      : await taskGateError(ctx, ctx.runTaskGate);

  if (gateError !== null) {
    return reject(ctx, "task_complete", gateError);
  }

  const result = completeItemInPlan(plan, id);

  if (!result.ok) {
    return reject(ctx, "task_complete", result.error);
  }

  const item = findItem(result.plan.items, id);

  persistAndNotify(ctx, result.plan, "task_complete", item?.title ?? id);

  return unvalidated
    ? `completed: ${item?.title ?? id} (no gate in this session — not gate-checked)`
    : `completed: ${item?.title ?? id}`;
}

/** Run the gate before marking an item done; the rejection text when it is red. */
async function taskGateError(
  ctx: IToolContext,
  runTaskGate: NonNullable<IToolContext["runTaskGate"]>
): Promise<string | null> {
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: "gate · checking before done",
  });

  const gate = await runTaskGate();

  if (!gate.passed) {
    const sample = gate.errors
      .slice(0, 5)
      .map((e) => e.message)
      .join("; ");
    const more =
      gate.errors.length > 5
        ? ` (+${String(gate.errors.length - 5)} more)`
        : "";
    const identity = formatGateIdentity(gate.command, gate.packs);
    const first = sample.length > 0 ? ` First: ${sample}${more}` : "";

    return `gate RED (${String(gate.errors.length)} error(s)) — item stays open. Fix, then task_complete again.${first}\n${identity}`;
  }

  return null;
}

/** Re-open a done item. */
export function doTaskUncomplete(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_uncomplete", bound.error);
  }

  const id = str(args, "id").trim();

  if (id.length === 0) {
    return reject(
      ctx,
      "task_uncomplete",
      "task_uncomplete needs `id` (item UUID from task_list)"
    );
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_uncomplete",
      `active plan file missing: ${bound.planId}`
    );
  }

  const result = uncompleteItemInPlan(plan, id);

  if (!result.ok) {
    return reject(ctx, "task_uncomplete", result.error);
  }

  const item = findItem(result.plan.items, id);

  persistAndNotify(ctx, result.plan, "task_uncomplete", item?.title ?? id);

  return `reopened: ${item?.title ?? id}`;
}

/** Append a discovered checklist item (root or under parent_id). */
export function doTaskAdd(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_add", bound.error);
  }

  const title = str(args, "title").trim();

  if (title.length === 0) {
    return reject(ctx, "task_add", "task_add needs `title`");
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(ctx, "task_add", `active plan file missing: ${bound.planId}`);
  }

  const parentRaw = str(args, "parent_id").trim();
  const files = parseFiles(args.files);
  const kind = parseKind(args.kind);
  const detail = str(args, "detail");
  const verify = str(args, "verify");
  const result = addItemInPlan(plan, {
    title,
    ...(parentRaw.length > 0 ? { parentId: parentRaw } : {}),
    ...(detail.trim().length > 0 ? { detail } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(verify.trim().length > 0 ? { verify } : {}),
    ...(kind !== undefined ? { kind } : {}),
  });

  if (!result.ok) {
    return reject(ctx, "task_add", result.error);
  }

  persistAndNotify(ctx, result.plan, "task_add", title);

  return `added: ${title} (${result.id})`;
}

/** Edit fields on an existing item (not status). */
export function doTaskUpdate(
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const bound = requirePlan(ctx);

  if (!bound.ok) {
    return reject(ctx, "task_update", bound.error);
  }

  const id = str(args, "id").trim();

  if (id.length === 0) {
    return reject(
      ctx,
      "task_update",
      "task_update needs `id` (item UUID from task_list)"
    );
  }

  const plan = loadPlan(bound.cwd, bound.planId);

  if (plan === null) {
    return reject(
      ctx,
      "task_update",
      `active plan file missing: ${bound.planId}`
    );
  }

  const hasTitle = Object.hasOwn(args, "title");
  const hasDetail = Object.hasOwn(args, "detail");
  const hasFiles = Object.hasOwn(args, "files");
  const hasVerify = Object.hasOwn(args, "verify");
  const hasKind = Object.hasOwn(args, "kind");

  if (!hasTitle && !hasDetail && !hasFiles && !hasVerify && !hasKind) {
    return reject(
      ctx,
      "task_update",
      "task_update needs at least one of title/detail/files/verify/kind"
    );
  }

  if (hasFiles && parseFiles(args.files) === undefined) {
    return reject(ctx, "task_update", "files must be an array of strings");
  }

  if (hasKind && parseKind(args.kind) === undefined) {
    return reject(
      ctx,
      "task_update",
      "kind must be investigate|create|modify|test"
    );
  }

  const result = updateItemFieldsInPlan(plan, id, {
    ...(hasTitle ? { title: str(args, "title") } : {}),
    ...(hasDetail ? { detail: str(args, "detail") } : {}),
    ...(hasFiles ? { files: parseFiles(args.files) ?? [] } : {}),
    ...(hasVerify ? { verify: str(args, "verify") } : {}),
    ...(hasKind ? { kind: parseKind(args.kind) } : {}),
  });

  if (!result.ok) {
    return reject(ctx, "task_update", result.error);
  }

  const item = findItem(result.plan.items, id);

  persistAndNotify(ctx, result.plan, "task_update", item?.title ?? id);

  return `updated: ${item?.title ?? id}`;
}
