import { repairArgs } from "../../agent/tool-repair";
import { writable, normalizeWorkspacePath } from "../../lib/scope";
import type { TsService } from "../../lsp";
import type { Reporter } from "../loop.types";
import type { SessionSnapshotStore } from "../../files/hashline";
import type { McpRegistry } from "../../mcp";
import type { IBrowserSession } from "../../chrome-bridge/chrome-bridge.types";
import type { PolicyMode, IPolicyRules } from "../../policy";
import type { IValidateResult } from "../../validate/validate.types";
import type { IConventionProvider } from "../conventions-provider";
import type { IPlanDocument } from "../worklist/checklist.types";
import type { IGateRailView } from "../session-gate-view";
import type { IProductPlan } from "../planning/plan-types";

/** What one on-demand gate run produced for the `check` tool: the standard
 *  validate result PLUS the files the gate's autofix reformatted/rewrote on disk
 *  this run. The model MUST re-read those before its next edit — their on-disk
 *  content (and hashline anchors) changed underneath it, exactly as `settleGate`
 *  warns via its autofix notice. */
export interface ICheckOutcome extends IValidateResult {
  autoFixed: string[];
  /** Per-file annotated one-liners ("src/a.ts (formatting, 4 lines)"), same
   *  order as `autoFixed` — what the autofix actually changed and why. */
  autoFixSummary: string[];
  /** Live gate command that produced this outcome (empty when none). */
  command: string;
  /** Pack ids the live gate / stack profile used. */
  packs: readonly string[];
}

/** Run the workspace's fast acceptance gate on demand and return its STRUCTURED
 *  result (errors as `{file,line,rule,message}` + the autofixed file list), so the
 *  `check` tool can hand the model its whole error set MID-TURN instead of only at
 *  end-of-turn. A generic injected seam (like {@link EditGuard}): the core tool
 *  knows nothing about which gate runs — a stack overlay (the boringstack build)
 *  wires the real runner. Absent ⇒ `check` reports it isn't available here. */
export type RunCheck = () => Promise<ICheckOutcome>;

/** One model-invoked delegation to a read-only specialist subagent (the
 *  `spawn_agent` tool). Wired by the CLI/session, which owns model resolution,
 *  the built-in + user specs, and the concurrency limiter; absent ⇒ delegation
 *  isn't available here (headless one-shot) and the tool says so. Emits
 *  `agent_spawned`/`agent_started`/`agent_result` via `report` so the live tree
 *  renders, tagging a UNIQUE `agentId` derived from `parentTaskId` (so two
 *  spawns of the same specialist don't collide). Resolves with the subagent's
 *  final findings as text — the tool result the orchestrator reads. */
export type SpawnAgentFn = (
  req: {
    readonly subagentType: string;
    readonly description: string;
    readonly prompt: string;
    readonly parentTaskId: string;
  },
  opts: { signal?: AbortSignal; report: Reporter }
) => Promise<string>;

/** A guard's veto of an applied edit: a stable `reason` slug (surfaced as
 *  `edit:<reason>`) and the model-facing rejection `message`. */
export interface IEditVeto {
  reason: string;
  message: string;
}

/** Inspect an edit AFTER it applied (given the file's before/after bytes) and
 *  return a veto to reject+revert it, or `null` to accept. A generic seam:
 *  the CORE edit tool knows nothing about what a guard checks — stack overlays
 *  (e.g. the boringstack build) inject domain rules here. */
export type EditGuard = (
  file: string,
  before: string,
  after: string
) => IEditVeto | null;

/** Call the registered edit guard (if any) with an edit's before/after bytes.
 *  Returns its veto, or null when no guard is set or the guard accepts. Every
 *  mutating tool (`edit`, `edit_lines`) runs this so no path bypasses the guard;
 *  the caller reverts the file on a veto. */
export function guardVeto(
  ctx: Pick<IToolContext, "editGuard">,
  file: string,
  before: string,
  after: string
): IEditVeto | null {
  return ctx.editGuard === undefined
    ? null
    : ctx.editGuard(file, before, after);
}

/** Combine several edit guards into one: run them in order and return the FIRST
 *  veto (short-circuit), or null if all accept. Lets a stack overlay stack multiple
 *  independent rules (e.g. boringstack's i18n-deletion guard AND its dual-extension
 *  guard) into the single `editGuard` slot without either knowing about the other. */
export function composeGuards(...guards: readonly EditGuard[]): EditGuard {
  return (file, before, after) => {
    for (const guard of guards) {
      const veto = guard(file, before, after);

      if (veto !== null) {
        return veto;
      }
    }

    return null;
  };
}

export interface IToolContext {
  cwd: string;
  /**
   * Extra absolute directories the model may read/search/run against, in addition
   * to `cwd`. Default (absent/`[]`): project tree only. Never include the
   * tsforge harness install path — that is what confinement blocks.
   */
  extraRoots?: readonly string[];
  /** The build ADAPTER's convention library (injected seam) — the `pull_conventions`
   *  tool reads its `guide`/`topics` from here instead of importing stack content.
   *  Absent ⇒ `pull_conventions` returns a "not configured" message. */
  conventions?: IConventionProvider;
  /** Topic ids successfully returned by `pull_conventions` this session — enforces
   *  pull-before-first-write on create/edit/edit_lines. */
  pulledTopics?: Set<string>;
  /** Editable scope — `edit`/`create` outside it are rejected. */
  files: string[];
  /** Optional edit guard: vetoes an applied edit (reverted on veto). Absent ⇒ no
   *  guard. The core tool stays domain-agnostic; overlays inject the rule. */
  editGuard?: EditGuard;
  report: Reporter;
  task: string;
  /** In-process TypeScript LanguageService — backs the semantic tools
   *  (rename/type_at/find_references/symbol_search/diagnostics/organize_imports).
   *  Null when the project has no tsconfig. */
  tsService?: TsService | null;
  /** Cancellation for the in-flight turn — passed to the `run` tool (and search)
   *  so a model-issued command is killed on Ctrl-C, not left running. */
  signal?: AbortSignal;
  /** PLAN MODE: mutating tools are rejected at dispatch and `run` only accepts
   *  read-only commands — the hard guarantee behind the filtered tool list (a
   *  salvaged/forced call could otherwise still write). */
  readOnly?: boolean;
  /** Active policy mode for the unified action-policy layer (executeTool runs
   *  every call through `evaluatePolicy` first). Absent ⇒ `"default"` (the
   *  autonomous drive-to-green default), so existing call sites are unchanged. */
  policyMode?: PolicyMode;
  /** Config-driven policy rules (deny/allow/ask), evaluated before the mode
   *  default. Absent ⇒ mode default only. */
  policyRules?: IPolicyRules;
  /** GitHub capability = consent: true only when the `gh` CLI is installed AND
   *  authenticated (and TSFORGE_NO_GITHUB is unset). The git/GitHub WRITE handlers
   *  hard-check this and reject when false — so even a salvaged/forced call can't
   *  push/comment when the capability is off (belt to the advertisement suspenders). */
  github?: boolean;
  /** Linear capability = consent: true only when a `linear` MCP server is configured
   *  AND connected (and TSFORGE_NO_LINEAR is unset). The Linear WRITE handlers
   *  (linear_write / linear_start) hard-check this and reject when false — so even a
   *  salvaged/forced call can't create a card or check out a branch when off. The
   *  Linear MCP calls route through `mcpRegistry`. */
  linear?: boolean;
  /** Notion capability = consent (a `notion` MCP server configured + connected,
   *  TSFORGE_NO_NOTION unset). The notion_write handler hard-checks it. */
  notion?: boolean;
  /** Sentry capability = consent (a `sentry` MCP server configured + connected,
   *  TSFORGE_NO_SENTRY unset). The sentry_write handler hard-checks it. */
  sentry?: boolean;
  /** Whether a real interactive per-action approval path exists. Absent/false ⇒
   *  a policy `ask` resolves to `deny` (no approval UI today). NOTE: this is a POLICY
   *  signal — it does NOT mean "a human is watching"; the REPL sets `humanPresent`, not
   *  this, precisely so co-pilot presence can't loosen policy verdicts. */
  interactive?: boolean;
  /** WS-C: a human is present to answer an `ask_user` question (the interactive REPL).
   *  Distinct from `interactive` (a policy approval path) — a human at the keyboard is
   *  NOT a per-action approval UI. Absent/false ⇒ `ask_user` proceeds without pausing so
   *  an unattended run never hangs. */
  humanPresent?: boolean;
  /** Hashline snapshot store for stale-anchor recovery (per-session, lazily initialized). */
  snapshotStore?: SessionSnapshotStore;
  /** Files the model has SUCCESSFULLY WRITTEN this session (create/edit/edit_lines
   *  on an in-scope file) — the session change-set, populated post-write, never on
   *  reads. `create` consults it to allow a full-rewrite overwrite of a file the
   *  model authored itself (vs. refusing to clobber pre-existing code). Same Set
   *  reference as the loop ctx, so writes from prior turns are visible. */
  touched?: Set<string>;
  /** Paths successfully `read` this send — used so first-time survey reads do not
   *  trip the readonly-spin park (Shiphold after /clear). */
  surveyed?: Set<string>;
  /** Connected MCP servers. When present, `mcp__<server>__<tool>` calls are routed
   *  here. These are external context/tool sources — they never touch the editable
   *  scope or the deterministic gate. Absent ⇒ no MCP configured. */
  mcpRegistry?: McpRegistry;
  /** The Chrome research bridge (TSFORGE_BROWSER). Present ⇒ the browser_* tools
   *  route through it; absent ⇒ they report the feature is off. */
  browser?: IBrowserSession;
  /** Run one read-only specialist subagent for the `spawn_agent` tool. Wired by
   *  the interactive CLI (headless one-shot leaves it absent). See {@link SpawnAgentFn}. */
  spawnAgent?: SpawnAgentFn;
  /** Render a just-generated image inline (the `generate_image` tool calls it).
   *  Wired by the interactive CLI to emit the terminal's inline-image escape above
   *  the input row; absent (headless / unsupported terminal) ⇒ the tool just
   *  reports the saved path. */
  previewImage?: (image: {
    path: string;
    base64: string;
    mimeType: string;
  }) => void;
  /** Run the fast acceptance gate on demand for the `check` tool (see {@link RunCheck}).
   *  Wired by the build overlay; absent ⇒ `check` says it isn't available here. */
  runCheck?: RunCheck;
  /**
   * Gate runner for `task_complete` — same shape as {@link RunCheck}, but a
   * separate seam so wiring a gate for checklist completion does not silently
   * enable the model's `check` tool (`offerCheck` alone owns `runCheck`).
   */
  runTaskGate?: RunCheck;
  /** Session-bound plan id under `.tsforge/worklist/plans/<id>.json`. Absent/null
   *  ⇒ task_* tools refuse (no plan approved for this session yet). */
  activePlanId?: string | null;
  /** Fired after a task_* tool persists a plan change — REPL refreshes the Tasks rail. */
  onPlanChanged?: (plan: IPlanDocument) => void;
  /** Fired when present_plan validates a proposal (pending until human approve). */
  onPlanPresented?: (plan: IPlanDocument) => void;
  /** Validate + strip a raw propose_product_plan payload against the active
   *  greenfield stack's schema/constraints. A closure `runGreenfieldPlanning`
   *  builds with the concrete stack schema in scope (Phaser/BoringStack), so
   *  this generic tool-context stays schema-agnostic — same generic/erased
   *  split `proposePlan<TUi>` already uses. Absent ⇒ propose_product_plan
   *  refuses (see offerProductPlan / Session.setGreenfieldMode). */
  productPlanValidate?: (
    raw: unknown
  ) => { ok: true; plan: IProductPlan } | { ok: false; error: string };
  /** Fired when propose_product_plan validates a proposal (pending until human
   *  approve) — awaited before the tool call returns, so the draft is on disk
   *  and the PLAN card is rendered before the model's next turn. */
  onProductPlanProposed?: (plan: IProductPlan) => Promise<void> | void;
  /** Fired after gate settle / rollback — REPL refreshes the Gate rail. */
  onGateChanged?: (view: IGateRailView) => void;
}

/** A required string arg, or "" if missing/wrong-type. */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v : "";
}

/**
 * Resolve a model-supplied path against the workspace and scope-check it, as one
 * step. Every tool that writes a single named file goes through here.
 *
 * The two must not be done separately: scope-checking the RAW argument rejects
 * in-scope files the model addressed absolutely or as `./x` (the globs are
 * workspace-relative), while normalizing without checking would let a `../` path
 * out of the workspace. `organize_imports` did the former and was the one write
 * tool that refused paths `edit`/`create`/`edit_lines` accepted.
 */
export function resolveWritable(
  ctx: IToolContext,
  file: string
): { path: string; writable: boolean } {
  const path = normalizeWorkspacePath(ctx.cwd, file);

  return { path, writable: writable(path, ctx.files) };
}

export interface IParseResult<T> {
  value: T | null;
  feedback?: string; // L3 feedback when recoverable=false
}

/**
 * Parse a tool's args, with VALIDATE-THEN-REPAIR: try the tool's own parser; if
 * it rejects, apply the repair ladder (L0→L1→L2→L3). Emits telemetry:
 *   - `repair:L0:<rule>` / `repair:L1:<rule>` / `repair:L2:<rule>` per applied rule
 *   - `repair:L3` when re-asking (feedback included in result)
 *   - `tool_input_rejected:<tool>` when (rarely) no parse succeeded
 * Returns both the parsed value and optional L3 feedback to surface to the model.
 *
 * `diagnose` (optional): field-level L3 text when repair still can't normalize —
 * prefer this over the bare `tool_input_rejected` dead-end (Shiphold burned ~50
 * turns on opaque "malformed args" retries).
 */
export function parseOrRepair<T>(
  raw: Record<string, unknown>,
  normalize: (a: Record<string, unknown>) => T | null,
  ctx: IToolContext,
  tool: string,
  diagnose?: (args: Record<string, unknown>) => string
): IParseResult<T> {
  const direct = normalize(raw);

  if (direct !== null) {
    return { value: direct };
  }

  const repair = repairArgs(raw);

  if (repair.applied.length > 0) {
    for (const rule of repair.applied) {
      ctx.report({
        kind: "repair",
        task: ctx.task,
        message: `${tool}:${rule}`,
      });
    }
  }

  const repaired = repair.applied.length > 0 ? normalize(repair.args) : null;

  if (repaired !== null) {
    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `tool_input_repaired:${tool} (${repair.applied.join(", ")})`,
    });

    return { value: repaired };
  }

  const argsForDiag = repair.applied.length > 0 ? repair.args : raw;

  // L3: repair ladder feedback, or tool-specific diagnose of the broken shape.
  if (
    !repair.recoverable &&
    repair.feedback !== undefined &&
    repair.feedback.length > 0
  ) {
    ctx.report({
      kind: "repair",
      task: ctx.task,
      message: `${tool}:L3-re-ask`,
    });

    return { value: null, feedback: repair.feedback };
  }

  if (diagnose !== undefined) {
    const feedback = diagnose(argsForDiag);

    if (feedback.length > 0) {
      ctx.report({
        kind: "repair",
        task: ctx.task,
        message: `${tool}:L3-re-ask`,
      });

      return { value: null, feedback };
    }
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `tool_input_rejected:${tool}`,
  });

  return { value: null };
}

/** Log a tool rejection (scope / size / match failure) so it's measurable. */
export function reject(
  ctx: IToolContext,
  tool: string,
  reason: string
): string {
  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `tool_rejected:${tool} (${reason})`,
  });

  return reason;
}
