import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ChecklistItemKind,
  ChecklistStatus,
  IChecklistItem,
  IPlanDocument,
  IPlanIndex,
  IPlanIndexEntry,
} from "./checklist.types";

const WORKLIST_DIR = ".tsforge/worklist";
const INDEX_FILE = "index.json";
const PLANS_DIR = "plans";

export function worklistRoot(cwd: string): string {
  return join(cwd, WORKLIST_DIR);
}

export function plansDir(cwd: string): string {
  return join(worklistRoot(cwd), PLANS_DIR);
}

export function planPath(cwd: string, planId: string): string {
  return join(plansDir(cwd), `${planId}.json`);
}

function indexPath(cwd: string): string {
  return join(worklistRoot(cwd), INDEX_FILE);
}

function ensureDirs(cwd: string): void {
  mkdirSync(plansDir(cwd), { recursive: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStatus(v: unknown): v is ChecklistStatus {
  return v === "pending" || v === "active" || v === "done" || v === "blocked";
}

function parseItem(raw: unknown): IChecklistItem | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }

  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    return null;
  }

  if (!isStatus(raw.status)) {
    return null;
  }

  const childrenRaw = raw.children;
  let children: IChecklistItem[] | undefined;

  if (Array.isArray(childrenRaw)) {
    children = [];

    for (const c of childrenRaw) {
      const parsed = parseItem(c);

      if (parsed === null) {
        return null;
      }

      children.push(parsed);
    }
  }

  const item: IChecklistItem = {
    id: raw.id,
    title: raw.title.trim(),
    status: raw.status,
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    ...(Array.isArray(raw.files) &&
    raw.files.every((f): f is string => typeof f === "string")
      ? { files: raw.files }
      : {}),
    ...(typeof raw.verify === "string" ? { verify: raw.verify } : {}),
    ...(typeof raw.blockedReason === "string"
      ? { blockedReason: raw.blockedReason }
      : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw.completedAt === "string"
      ? { completedAt: raw.completedAt }
      : {}),
    ...(children !== undefined && children.length > 0 ? { children } : {}),
  };

  return item;
}

function parsePlanDocument(raw: unknown): IPlanDocument | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (raw.schemaVersion !== 2) {
    return null;
  }

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }

  if (typeof raw.goal !== "string") {
    return null;
  }

  if (raw.activeItemId !== null && typeof raw.activeItemId !== "string") {
    return null;
  }

  if (typeof raw.updatedAt !== "string") {
    return null;
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return null;
  }

  const items: IChecklistItem[] = [];

  for (const item of raw.items) {
    const parsed = parseItem(item);

    if (parsed === null) {
      return null;
    }

    items.push(parsed);
  }

  return {
    schemaVersion: 2,
    id: raw.id,
    goal: raw.goal,
    activeItemId: raw.activeItemId,
    updatedAt: raw.updatedAt,
    items,
  };
}

function parseIndex(raw: unknown): IPlanIndex {
  if (!isRecord(raw) || !Array.isArray(raw.plans)) {
    return { plans: [] };
  }

  const plans: IPlanIndexEntry[] = [];

  for (const entry of raw.plans) {
    if (!isRecord(entry)) {
      continue;
    }

    if (
      typeof entry.id !== "string" ||
      typeof entry.goal !== "string" ||
      typeof entry.updatedAt !== "string"
    ) {
      continue;
    }

    plans.push({
      id: entry.id,
      goal: entry.goal,
      updatedAt: entry.updatedAt,
    });
  }

  return { plans };
}

export function loadPlanIndex(cwd: string): IPlanIndex {
  const path = indexPath(cwd);

  if (!existsSync(path)) {
    return { plans: [] };
  }

  try {
    return parseIndex(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { plans: [] };
  }
}

export function savePlanIndex(cwd: string, index: IPlanIndex): void {
  ensureDirs(cwd);
  writeFileSync(indexPath(cwd), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function loadPlan(cwd: string, planId: string): IPlanDocument | null {
  const path = planPath(cwd, planId);

  if (!existsSync(path)) {
    return null;
  }

  try {
    return parsePlanDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function savePlan(cwd: string, plan: IPlanDocument): void {
  ensureDirs(cwd);
  writeFileSync(
    planPath(cwd, plan.id),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8"
  );

  const index = loadPlanIndex(cwd);
  const entry: IPlanIndexEntry = {
    id: plan.id,
    goal: plan.goal,
    updatedAt: plan.updatedAt,
  };
  const rest = index.plans.filter((p) => p.id !== plan.id);

  savePlanIndex(cwd, { plans: [entry, ...rest] });
}

export function findItem(
  items: readonly IChecklistItem[],
  id: string
): IChecklistItem | null {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }

    if (item.children) {
      const found = findItem(item.children, id);

      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

/**
 * Depth-first first open (pending/active) item — the next thing plan order
 * requires. Used so task_focus cannot skip ahead of unfinished work.
 */
export function findItemByTitle(
  items: readonly IChecklistItem[],
  title: string
): IChecklistItem | null {
  for (const item of items) {
    if (item.title === title) {
      return item;
    }

    if (item.children) {
      const found = findItemByTitle(item.children, title);

      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

/** Focus the checklist item whose title matches, else the first open item. */
export function focusPlanItemByTitle(
  cwd: string,
  planId: string,
  title: string
): IPlanDocument | null {
  const plan = loadPlan(cwd, planId);

  if (plan === null) {
    return null;
  }

  const item = findItemByTitle(plan.items, title) ?? firstOpenItem(plan.items);

  if (item === null) {
    return null;
  }

  const focused = focusItemInPlan(plan, item.id);

  if (!focused.ok) {
    return null;
  }

  savePlan(cwd, focused.plan);

  return focused.plan;
}

export function firstOpenItem(
  items: readonly IChecklistItem[]
): IChecklistItem | null {
  for (const item of items) {
    if (item.status === "done") {
      continue;
    }

    const kids = item.children ?? [];

    if (kids.length > 0) {
      const child = firstOpenItem(kids);

      if (child !== null) {
        return child;
      }
    }

    return item;
  }

  return null;
}

export function mapItems(
  items: readonly IChecklistItem[],
  fn: (item: IChecklistItem) => IChecklistItem
): IChecklistItem[] {
  return items.map((item) => {
    const next = fn(item);
    const children = next.children
      ? mapItems(next.children, fn)
      : next.children;

    if (children === next.children) {
      return next;
    }

    return { ...next, children };
  });
}

/** Update one item by id; returns new tree or null if id missing. */
export function updateItemById(
  items: readonly IChecklistItem[],
  id: string,
  updater: (item: IChecklistItem) => IChecklistItem
): IChecklistItem[] | null {
  if (findItem(items, id) === null) {
    return null;
  }

  const walk = (nodes: readonly IChecklistItem[]): IChecklistItem[] =>
    nodes.map((item) => {
      if (item.id === id) {
        return updater(item);
      }

      if (item.children === undefined) {
        return item;
      }

      return { ...item, children: walk(item.children) };
    });

  return walk(items);
}

export function countOpen(items: readonly IChecklistItem[]): number {
  let n = 0;

  for (const item of items) {
    if (item.status !== "done") {
      n += 1;
    }

    if (item.children) {
      n += countOpen(item.children);
    }
  }

  return n;
}

export function countDone(items: readonly IChecklistItem[]): number {
  let n = 0;

  for (const item of items) {
    if (item.status === "done") {
      n += 1;
    }

    if (item.children) {
      n += countDone(item.children);
    }
  }

  return n;
}

export function isChecklistComplete(plan: IPlanDocument): boolean {
  return countOpen(plan.items) === 0;
}

function allChildrenDone(item: IChecklistItem): boolean {
  if (!item.children || item.children.length === 0) {
    return true;
  }

  return item.children.every((c) => c.status === "done");
}

/**
 * Mark an item done. Refuses if children exist and any child is not done.
 * After marking, walks up and auto-completes parents whose children are all done.
 */
export function completeItemInPlan(
  plan: IPlanDocument,
  itemId: string,
  now: string = new Date().toISOString()
): { ok: true; plan: IPlanDocument } | { ok: false; error: string } {
  const target = findItem(plan.items, itemId);

  if (target === null) {
    return { ok: false, error: `unknown item id: ${itemId}` };
  }

  if (!allChildrenDone(target)) {
    return {
      ok: false,
      error: "cannot complete parent while children remain open",
    };
  }

  let items = updateItemById(plan.items, itemId, (item) => ({
    ...item,
    status: "done" as const,
    updatedAt: now,
    completedAt: now,
  }));

  if (items === null) {
    return { ok: false, error: `unknown item id: ${itemId}` };
  }

  // Auto-complete parents when all children are done.
  let changed = true;

  while (changed) {
    changed = false;
    items = mapItems(items, (item) => {
      if (
        item.status !== "done" &&
        item.children &&
        item.children.length > 0 &&
        item.children.every((c) => c.status === "done")
      ) {
        changed = true;

        return {
          ...item,
          status: "done",
          updatedAt: now,
          completedAt: now,
        };
      }

      return item;
    });
  }

  const activeItemId = plan.activeItemId === itemId ? null : plan.activeItemId;

  return {
    ok: true,
    plan: {
      ...plan,
      items,
      activeItemId,
      updatedAt: now,
    },
  };
}

export function uncompleteItemInPlan(
  plan: IPlanDocument,
  itemId: string,
  now: string = new Date().toISOString()
): { ok: true; plan: IPlanDocument } | { ok: false; error: string } {
  const items = updateItemById(plan.items, itemId, (item) => ({
    ...item,
    status: "pending" as const,
    updatedAt: now,
    completedAt: undefined,
  }));

  if (items === null) {
    return { ok: false, error: `unknown item id: ${itemId}` };
  }

  return {
    ok: true,
    plan: {
      ...plan,
      items,
      updatedAt: now,
    },
  };
}

export interface IAddItemFields {
  readonly title: string;
  /** When set, append as a child of this item; otherwise as a new root. */
  readonly parentId?: string;
  readonly detail?: string;
  readonly files?: readonly string[];
  readonly verify?: string;
  readonly kind?: ChecklistItemKind;
}

export interface IUpdateItemFields {
  readonly title?: string;
  readonly detail?: string;
  readonly files?: readonly string[];
  readonly verify?: string;
  readonly kind?: ChecklistItemKind;
}

function optionalStrings(
  values: readonly string[] | undefined
): readonly string[] | undefined {
  if (values === undefined) {
    return undefined;
  }

  const cleaned = values.map((f) => f.trim()).filter((f) => f.length > 0);

  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Append a pending item (discovery mid-build). Optional `parentId` nests under
 * an existing node; adding under a done parent re-opens that parent.
 */
export function addItemInPlan(
  plan: IPlanDocument,
  fields: IAddItemFields,
  now: string = new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID()
):
  { ok: true; plan: IPlanDocument; id: string } | { ok: false; error: string } {
  const title = fields.title.trim();

  if (title.length === 0) {
    return { ok: false, error: "title is required" };
  }

  const id = newId();
  const files = optionalStrings(fields.files);
  const child: IChecklistItem = {
    id,
    title,
    status: "pending",
    updatedAt: now,
    ...(fields.detail !== undefined && fields.detail.trim().length > 0
      ? { detail: fields.detail.trim() }
      : {}),
    ...(files !== undefined ? { files } : {}),
    ...(fields.verify !== undefined && fields.verify.trim().length > 0
      ? { verify: fields.verify.trim() }
      : {}),
    ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
  };

  const parentId = fields.parentId?.trim() ?? "";

  if (parentId.length === 0) {
    return {
      ok: true,
      id,
      plan: {
        ...plan,
        items: [...plan.items, child],
        updatedAt: now,
      },
    };
  }

  if (findItem(plan.items, parentId) === null) {
    return { ok: false, error: `unknown parent id: ${parentId}` };
  }

  const items = updateItemById(plan.items, parentId, (parent) => {
    const kids = [...(parent.children ?? []), child];

    if (parent.status === "done") {
      return {
        ...parent,
        children: kids,
        status: "pending",
        completedAt: undefined,
        updatedAt: now,
      };
    }

    return {
      ...parent,
      children: kids,
      updatedAt: now,
    };
  });

  if (items === null) {
    return { ok: false, error: `unknown parent id: ${parentId}` };
  }

  return {
    ok: true,
    id,
    plan: {
      ...plan,
      items,
      updatedAt: now,
    },
  };
}

function withOptionalField(
  item: IChecklistItem,
  key: "detail" | "verify",
  value: string | undefined
): IChecklistItem {
  const trimmed = value?.trim() ?? "";

  if (trimmed.length === 0) {
    const { [key]: _drop, ...rest } = item;

    return rest;
  }

  return { ...item, [key]: trimmed };
}

/**
 * Edit title/detail/files/verify/kind on an existing item. Does not change
 * status — use task_complete / task_uncomplete / task_focus for that.
 */
export function updateItemFieldsInPlan(
  plan: IPlanDocument,
  itemId: string,
  fields: IUpdateItemFields,
  now: string = new Date().toISOString()
): { ok: true; plan: IPlanDocument } | { ok: false; error: string } {
  if (findItem(plan.items, itemId) === null) {
    return { ok: false, error: `unknown item id: ${itemId}` };
  }

  const titleField = fields.title;
  const detailField = fields.detail;
  const filesField = fields.files;
  const verifyField = fields.verify;
  const kindField = fields.kind;
  const hasTitle = titleField !== undefined;
  const hasDetail = detailField !== undefined;
  const hasFiles = filesField !== undefined;
  const hasVerify = verifyField !== undefined;
  const hasKind = kindField !== undefined;

  if (!hasTitle && !hasDetail && !hasFiles && !hasVerify && !hasKind) {
    return {
      ok: false,
      error: "nothing to update — pass title/detail/files/verify/kind",
    };
  }

  if (titleField?.trim().length === 0) {
    return { ok: false, error: "title cannot be empty" };
  }

  const items = updateItemById(plan.items, itemId, (item) => {
    let next: IChecklistItem = { ...item, updatedAt: now };

    if (titleField !== undefined) {
      next = { ...next, title: titleField.trim() };
    }

    if (hasDetail) {
      next = withOptionalField(next, "detail", detailField);
    }

    if (hasVerify) {
      next = withOptionalField(next, "verify", verifyField);
    }

    if (hasFiles) {
      const files = optionalStrings(filesField);

      if (files === undefined) {
        const { files: _drop, ...rest } = next;

        next = rest;
      } else {
        next = { ...next, files };
      }
    }

    if (kindField !== undefined) {
      next = { ...next, kind: kindField };
    }

    return next;
  });

  if (items === null) {
    return { ok: false, error: `unknown item id: ${itemId}` };
  }

  return {
    ok: true,
    plan: {
      ...plan,
      items,
      updatedAt: now,
    },
  };
}

export function focusItemInPlan(
  plan: IPlanDocument,
  itemId: string,
  now: string = new Date().toISOString()
): { ok: true; plan: IPlanDocument } | { ok: false; error: string } {
  const target = findItem(plan.items, itemId);

  if (target === null) {
    return { ok: false, error: `unknown item id: ${itemId}` };
  }

  if (target.status === "done") {
    return { ok: false, error: "cannot focus a done item — uncomplete first" };
  }

  // Plan order: refuse to jump ahead while an earlier open item remains.
  // Otherwise the model task_focuses "Build Today view" while "store hook"
  // stays unchecked — and never calls task_complete on the skipped work.
  const head = firstOpenItem(plan.items);

  if (head !== null && head.id !== itemId) {
    return {
      ok: false,
      error:
        `finish "${head.title}" first (task_complete when the gate is green), ` +
        "then focus this item — plan order is required",
    };
  }

  // Clear previous active → pending (unless already the target).
  let items = mapItems(plan.items, (item) => {
    if (item.status === "active" && item.id !== itemId) {
      return { ...item, status: "pending", updatedAt: now };
    }

    return item;
  });

  const focused = updateItemById(items, itemId, (item) => ({
    ...item,
    status: "active" as const,
    updatedAt: now,
  }));

  if (focused === null) {
    return { ok: false, error: `unknown item id: ${itemId}` };
  }

  items = focused;

  return {
    ok: true,
    plan: {
      ...plan,
      items,
      activeItemId: itemId,
      updatedAt: now,
    },
  };
}

/** Compact tree for turn inject / tool list. */
export function formatPlanTree(
  plan: IPlanDocument,
  opts: { maxDepth?: number; indent?: string } = {}
): string {
  const indent = opts.indent ?? "  ";
  const lines: string[] = [`goal: ${plan.goal}`];

  if (plan.activeItemId !== null) {
    const active = findItem(plan.items, plan.activeItemId);

    lines.push(
      `active: ${active !== null ? `${active.title} (${active.id})` : plan.activeItemId}`
    );
  } else {
    lines.push("active: (none)");
  }

  lines.push(
    `open: ${String(countOpen(plan.items))}  done: ${String(countDone(plan.items))}`
  );
  lines.push("items:");

  const walk = (nodes: readonly IChecklistItem[], depth: number): void => {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) {
      return;
    }

    for (const item of nodes) {
      const mark =
        item.status === "done"
          ? "[x]"
          : item.status === "active"
            ? "[>]"
            : item.status === "blocked"
              ? "[!]"
              : "[ ]";
      const pad = indent.repeat(depth);

      lines.push(`${pad}${mark} ${item.title} (${item.id})`);

      if (item.children) {
        walk(item.children, depth + 1);
      }
    }
  };

  walk(plan.items, 1);

  return lines.join("\n");
}
