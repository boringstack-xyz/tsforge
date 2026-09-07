/**
 * The interactive REPL: a persistent gate-anchored conversation. Owns the
 * pane console, the multi-line editor / readline fallback, the slash-command
 * dispatcher, plan-mode flow, and the inline overlays (palette, @ picker,
 * /config, /help). Extracted from cli.ts; the entry point stays `repl(args)`.
 */
import { writeSync } from "node:fs";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { formatHelp, takesArg } from "./commands";
import { resolveInitialPlanMode } from "./plan-default";
import { modeById, nextMode } from "./modes";
import { runConfigMenu } from "./config-menu";
import { runCapabilityMenu } from "./capability-menu";
import { openScaffoldInRepl } from "./repl-scaffold";
import { openRecipePicker } from "./repl-recipe";
import { pickCommand, type IPaletteView } from "../render/command-menu";
import {
  pickFileInline,
  filterMentionItems,
  formatCompletionRows,
  mentionInsertText,
  shouldOpenAtPicker,
  type IMentionItem,
  type IPickerView,
} from "../render/file-menu";
import { listWorkspaceFiles } from "../lib/fs";
import { basename, relative } from "node:path";
import { composeMessage } from "../loop/prompt";
import { compactSummaryLine } from "../loop/context-hygiene";
import { resolveImageInput } from "./image-input";
import { resolveImageCapabilityFlags } from "../loop/tools/image-tools";
import { resolveGithubCapability } from "../loop/tools/github-ops";
import {
  captureClipboardImageToFile,
  readClipboardText,
  discardClipboardImages,
} from "../lib/clipboard/clipboard-image";
import {
  detectImageProtocol,
  renderInlineImage,
  makeImageBudget,
} from "../render/terminal-image";
import {
  Session,
  PLAN_APPROVED_NOTE,
  isEphemeralUserInject,
  review,
  formatReviewCard,
  type Reporter,
  type ILoopEvent,
  type IReviewReport,
} from "../loop";
import type {
  IPlanConstraints,
  IProductPlan,
} from "../loop/planning/plan-types";
import { applyPlanConstraints } from "../loop/planning/propose-plan";
import { productPlanToDraft } from "../loop/planning/product-plan-ui";
import {
  readPlan,
  writePlan,
  isProductPlan,
} from "../loop/planning/plan-store";
import {
  adapterSessionExtras,
  resolveStackAdapter,
  type IStackAdapter,
} from "../loop/planning/stack-adapter";
import { boringstackStackAdapter } from "../loop/boringstack/planning";
import { phaserStackAdapter } from "../loop/phaser/planning";
import { phaserPlanSchema } from "../loop/phaser/plan-extension";
import { runPhaserBuild } from "../loop/phaser/build";
import { bunExec } from "../loop/phaser/exec";
import { PHASER_NO_DEV_DENY } from "../loop/phaser/build-config";
import { phaserHostFromSession } from "./phaser-repl-host";
import { shouldDispatchReplLine } from "./repl-line";
import { resolveChromeStatus } from "./repl-status";
import { resolveScaffoldedWorkspace } from "../scaffold/receipt";
import { loadRecipes } from "../config/recipes";
import { loadAgentSpecs } from "../config/agent-specs";
import {
  loadTsforgeConfig,
  resolveAgentConcurrency,
} from "../config/tsforge-config";
import { makeSpawnAgentFn } from "./spawn-runner";
import { scopeOf, WHOLE_REPO, resolveCliProfile, type ICliArgs } from "./args";
import { isProfileId } from "../config/profiles";
import { isPolicyMode, type PolicyMode } from "../policy";
import { startEditor, type IEditorHandle } from "../editor";
import { renderEditor } from "../editor/view";
import { flags } from "../config/flags";
import type { OpenAICompatibleProvider } from "../inference";
import type { IModelEntry } from "../models-config";
import { loadModelsConfig } from "../models-config";
import {
  renderStatus,
  userBubble,
  agentCardTop,
  agentCardBottom,
  agentCardPadRow,
  agentBar,
  agentRight,
  agentRailInnerCols,
  makeAgentRail,
  STYLE,
  paint,
  FORGE_EDITOR_GUTTER,
  renderMessage,
  inputContentCols,
  renderAgentTree,
  AgentTreeModel,
  PaneScreen,
  createMouseCsiFilter,
  RESTORE_TERMINAL,
  canUsePaneTui,
  PANE_MIN_ROWS,
  INPUT_INNER_ROWS_MAX,
  type IStatusInfo,
  type IAgentRow,
} from "../render";
import { takeOneInputSequence } from "../render/frame/input-seq";
import {
  runMemorySlashCommand,
  runRememberSlashCommand,
} from "./memory-command";
import {
  saveSession,
  latestSession,
  loadSession,
  pruneSessions,
  type ISessionRecord,
} from "../session-store";
import {
  currentVersion,
  getUpdateNotice,
  refreshUpdateCacheInBackground,
} from "../update-check";
import {
  spinner,
  outputRouter,
  makeReporter,
  resolveLogPath,
  observeEvents,
  bootWrite,
} from "./logging";
import { setMcpDiagnosticSink } from "../mcp";
import {
  modelInfo,
  detectContextWindow,
  envNumber,
  providerConfig,
  makeProvider,
  resolveReviewProviders,
  warnDefaultModelOnRemote,
  warnReviewConfigSplit,
  warnSelfReview,
  runModelCommand,
  modelForRun,
} from "./model-setup";
import { scopeLabel, planHint } from "./banner";
import { resolveGate, type AutoGateResolver } from "./gate-setup";
import {
  turnsToGreenLine,
  runMapCommand,
  runReviewCommand,
  runTraceCommand,
} from "./repl-commands";
import { openSessionsMenu } from "./session-menu";
import {
  formatWorklistLines,
  formatPlanProposal,
  worklistBadge,
  pendingPlanBadge,
  seedWorklistFromPlan,
  persistPlanDocument,
  normalizePlanDraft,
  goalFromMessages,
  loadPlan,
  firstOpenItem,
  focusPlanItemByTitle,
} from "../loop/worklist";
import type { IPlanDocument, IChecklistItemDraft } from "../loop/worklist";
import {
  formatGateLines,
  gateRailBadge,
  gateSteerText,
} from "../loop/gate/panel";
import type { IGateRailView } from "../loop/session-gate-view";
import {
  loadUserTuiKeybindings,
  matchPaneAction,
  parseProjectTuiKeybindings,
  resolveTuiKeybindings,
} from "../config/tui-keybindings";
import { formatKeymapOverlay } from "../render/keymap-overlay";
import { linkifyTranscriptLine } from "../render/osc8-link";

/** A unique-enough id for a new session (time + a little randomness). */
function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Guidance handed to the agent after `/reviewfix` seeds the worklist. Short on
 *  purpose — the task list carries the findings; this only sets the protocol. */
const REVIEWFIX_INSTRUCTION =
  "I've added the code-review findings to your task list. Work them ONE AT A TIME: `task_focus` the first open finding, address it (fix the code, or if it isn't a real problem say why in one line), then `task_complete` it — which only succeeds once the gate is green — and move to the next. Don't batch them.";

const REVIEWFIX_SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/** One worklist task per review finding, worst-severity first (the worklist enforces
 *  top-to-bottom focus order, so the highest-risk issue is worked first). Title is
 *  the claim; detail carries file:line, lens, the reason, and any suggested fix.
 *  Exported for tests. */
export function reviewFindingsToDrafts(
  report: IReviewReport
): IChecklistItemDraft[] {
  const sorted = [...report.findings].sort(
    (a, b) =>
      REVIEWFIX_SEVERITY_RANK[a.severity] - REVIEWFIX_SEVERITY_RANK[b.severity]
  );

  return sorted.map((f): IChecklistItemDraft => {
    const where = `${f.file}:${String(f.line)} [${f.lens}] (${f.severity})`;
    const detail =
      f.suggestedFix === undefined
        ? `${where}\n${f.reason}`
        : `${where}\n${f.reason}\nSuggested fix: ${f.suggestedFix}`;

    return { title: f.claim, detail, files: [f.file], kind: "modify" };
  });
}

/** Wide approval — the staged-web checkpoint explicitly prompted "type
 *  'approve'", so casual yeses count there. */
export function isApproval(line: string): boolean {
  return /^(approve|approved|ok|okay|yes|y|go|lgtm)\.?$/i.test(line.trim());
}

/** Map a human's plan-review reply to a decision. Pure + exported so the
 *  approve/cancel/revise semantics are unit-tested without the interactive prompt. */
export function parseReviewResponse(
  response: string
):
  | { action: "approve" }
  | { action: "cancel" }
  | { action: "revise"; note: string } {
  const trimmed = response.trim().toLowerCase();

  if (trimmed === "approve" || trimmed === "a" || trimmed === "y") {
    return { action: "approve" };
  }

  if (trimmed === "cancel" || trimmed === "c" || trimmed === "n") {
    return { action: "cancel" };
  }

  return { action: "revise", note: response };
}

/** The stack adapters the CLI (composition root) registers. The generic planner/CLI
 *  flow resolves the matching one per project; adding a stack is registration here,
 *  not a change to the planning logic. */
const STACK_ADAPTERS: readonly IStackAdapter[] = [
  boringstackStackAdapter,
  phaserStackAdapter,
];

/** Convention extras + context brief from the adapter that claims `dir`. */
async function stackSessionExtras(dir: string): Promise<{
  readonly conventions?: IStackAdapter["conventions"];
  readonly pullConventions?: true;
  readonly guidance?: string;
}> {
  const root = await resolveScaffoldedWorkspace(dir);

  return adapterSessionExtras(root, STACK_ADAPTERS);
}

/**
 * The greenfield-planning DECISION: which registered stack adapter (if any) should
 * intercept `dir` for planning. Returns the adapter to plan with — a stack detected the
 * project AND it has no approved plan yet — or null to proceed normally (no stack detected,
 * or already planned). Detection and the planner constraints then come from this SAME
 * returned adapter, so there is no gap. Pure + injectable (`hasApprovedPlan`) so the
 * interception rule is unit-testable without driving the REPL.
 */
export async function resolveGreenfieldStack(
  dir: string,
  adapters: readonly IStackAdapter[],
  hasApprovedPlan: (dir: string, stack: IStackAdapter) => Promise<boolean>
): Promise<IStackAdapter | null> {
  const stack = await resolveStackAdapter(dir, adapters);

  if (stack === null) {
    return null;
  }

  // hasApprovedPlan receives the RESOLVED adapter, so the approved-plan check parses through the
  // SAME stack's schema that will drive planning — no hardcoded stack.
  return (await hasApprovedPlan(dir, stack)) ? null : stack;
}

/**
 * Build the planner constraints for the greenfield flow from the RESOLVED stack adapter,
 * wiring its drop reporter to `echo` so every stripped slice is surfaced to the user. Kept
 * separate + exported so the "resolved adapter supplies the constraints, and drops reach
 * the echo sink" wiring is testable without running the whole planner.
 */
export function greenfieldConstraints(
  stack: IStackAdapter,
  echo: (s: string) => void
): IPlanConstraints {
  return stack.planConstraints((dropped) => {
    echo(
      `▸ dropped slice(s) the ${stack.id} starter already provides: ${dropped.join(", ")}\n`
    );
  });
}

/**
 * Route ONE input line: if a registered stack adapter claims the project (fresh + unplanned)
 * hand the RESOLVED adapter to `onGreenfield`; otherwise fall through to `onSend` (the normal
 * agent turn). EXACTLY ONE of the two runs. This encapsulates the interception BRANCH so its
 * behavior — the resolved stack controls the planning path, and an unmatched/already-planned
 * project falls through to the normal send — is unit-tested, not merely source-probed.
 */
export async function greenfieldOrSend(
  dir: string,
  adapters: readonly IStackAdapter[],
  hasApprovedPlan: (dir: string, stack: IStackAdapter) => Promise<boolean>,
  onGreenfield: (stack: IStackAdapter) => Promise<void>,
  onSend: () => Promise<void>
): Promise<void> {
  const stack = await resolveGreenfieldStack(dir, adapters, hasApprovedPlan);

  if (stack !== null) {
    await onGreenfield(stack);

    return;
  }

  await onSend();
}

export const PLANNER_AGENT_ID = "session:planner";
export const PLANNER_LABEL = "product planner";

/** REPL surfaces for greenfield product planning (agent tree + yellow PLAN card). */
export interface IGreenfieldPlanningUi {
  readonly report: Reporter;
  present(plan: IPlanDocument): void;
  /** Arm the tree spinner so running rows animate. */
  startLive?(): void;
  /** Stop the spinner and clear the tree — the PLAN card is the result. */
  stopLive?(): void;
  /** Human progress into the planner detail pane (slice names, not JSON). */
  note?(text: string): void;
}

/** Validated propose_product_plan payload, or a rejection the model can act on
 *  (and retry within the same turn — no more temperature-0-then-0.7 trick). */
export type ProductPlanValidation =
  { ok: true; plan: IProductPlan } | { ok: false; error: string };

/** The Session methods greenfield planning actually needs — not a second
 *  Session (phaserHostFromSession's "not a second Session" precedent).
 *  Injectable so tests drive the ask_user/propose_product_plan path without a
 *  live model. */
export interface IGreenfieldSession {
  setGreenfieldMode(
    on: boolean,
    hooks?: {
      readonly validate: (raw: unknown) => ProductPlanValidation;
      readonly onProposed: (plan: IProductPlan) => Promise<void>;
    }
  ): void;
  /** Append stack-specific planning guidance to the system prompt — the SAME
   *  `schema.system` + `constraints.guidance` text `proposePlan()` used to send
   *  as its own system message, now folded into the live session's system
   *  prompt so the model still gets stack guidance (e.g. Phaser's "playable
   *  systems, not a CRUD inventory of sprites") once planning is routed
   *  through the real turn loop instead of a one-shot completion. */
  guide(text: string): void;
  send(
    message: string,
    opts?: { signal?: AbortSignal }
  ): Promise<{ status: string; turns: number; awaitingUser?: string }>;
}

/** Draft or approved product plan on disk, or a pending PLAN card — do not re-plan. */
export async function stackHasProductPlan(
  dir: string,
  stack: IStackAdapter
): Promise<boolean> {
  return (await readPlan(dir, stack.planSchema)) !== null;
}

/** Validate a raw propose_product_plan payload against `stack`'s schema, then
 *  apply the same strip-reserved + recheck pass `proposePlan` uses
 *  (`applyPlanConstraints`) — both entry points enforce identically strict rules. */
function validateProductPlan(
  raw: unknown,
  stack: IStackAdapter,
  constraints: IPlanConstraints
): ProductPlanValidation {
  const schema = stack.planSchema;

  if (!isProductPlan(raw, schema.validateUi, schema.extraCheck)) {
    return {
      ok: false,
      error:
        "invalid plan — every slice needs entity{id,desc,fields,relationships,rules}, " +
        "a ui matching this stack's shape, and verification{mustRemainTrue,mustNotHappen,acceptanceCheck}",
    };
  }

  const result = applyPlanConstraints(raw, schema, constraints);

  if (result === null) {
    return {
      ok: false,
      error:
        "every slice was reserved/already provided by the starter, or the plan " +
        "fails the stack's cross-slice rule once reserved slices are stripped — revise and try again",
    };
  }

  return { ok: true, plan: result };
}

/** The greenfield planning flow: routes the description through the REAL
 *  agentic turn loop (ask_user + propose_product_plan) instead of a one-shot
 *  tool-less completion, so the model can ask the few clarifying questions
 *  that matter before committing to a plan — the same "plan-first" philosophy
 *  the harness already promises for normal coding sessions (plan-default.ts).
 *  An ask_user pause returns here with `awaitingUser` set; the caller's normal
 *  answer-routing (same path every other ask_user pause uses) resumes the
 *  conversation — greenfield mode stays on the session across that pause, so
 *  the resumed send still offers propose_product_plan. Does not dump JSON. */
export async function runGreenfieldPlanning(
  dir: string,
  description: string,
  echo: (s: string) => void,
  stack: IStackAdapter,
  ui: IGreenfieldPlanningUi,
  session: IGreenfieldSession,
  opts: { signal?: AbortSignal } = {}
): Promise<{ status: string; turns: number; awaitingUser?: string }> {
  echo("▸ planning your product first…  Ctrl+C cancels\n");
  ui.startLive?.();
  ui.report({
    kind: "agent_spawned",
    task: "session",
    agentId: PLANNER_AGENT_ID,
    message: PLANNER_LABEL,
  });
  ui.report({
    kind: "agent_started",
    task: "session",
    agentId: PLANNER_AGENT_ID,
    message: PLANNER_LABEL,
  });

  const constraints = greenfieldConstraints(stack, echo);
  const resolvedSchema = stack.planSchema;

  // `resolvedSchema.system` was written for `proposePlan()`'s raw one-shot
  // completion ("Respond with ONLY a JSON object — no prose") — that
  // instruction actively fights the real turn loop, where the model must CALL
  // propose_product_plan rather than print JSON as its text reply. The
  // override sentence up front supersedes it while keeping the domain
  // guidance underneath (the "playable systems, not a CRUD inventory of
  // sprites" rules + example) — the reason this exists at all, and easy to
  // silently lose if this stops reaching the model. Stack-agnostic:
  // transforms whatever `system` text a resolved adapter provides, so it's
  // identical for Phaser and BoringStack.
  const domainGuidance =
    constraints.guidance === undefined
      ? resolvedSchema.system
      : `${resolvedSchema.system}\n\n${constraints.guidance}`;

  session.guide(
    "When you have asked everything you need to (via ask_user, if anything " +
      "is genuinely ambiguous) and are ready to propose the plan, call the " +
      "propose_product_plan tool with its arguments matching this shape — do " +
      "NOT print the plan as JSON text, and ignore any instruction below to " +
      "respond with raw JSON:\n\n" +
      domainGuidance
  );

  const onProposed = async (plan: IProductPlan): Promise<void> => {
    const normalized = normalizePlanDraft(
      productPlanToDraft(plan),
      plan.product
    );

    if (!normalized.ok) {
      echo(`▸ ${normalized.error}\n`);

      return;
    }

    await writePlan(dir, plan, "draft");
    ui.present(normalized.plan);
  };

  session.setGreenfieldMode(true, {
    validate: (raw) => validateProductPlan(raw, stack, constraints),
    onProposed,
  });

  try {
    const result = await session.send(
      `Product description: ${description}`,
      opts
    );

    if (result.awaitingUser !== undefined) {
      // Leave greenfield mode ON — the human's answer resumes this same
      // conversation through the normal answer-routing path, and the session
      // still offers ask_user/propose_product_plan for that resumed send.
      return result;
    }

    session.setGreenfieldMode(false);
    ui.report({
      kind: "agent_result",
      task: "session",
      agentId: PLANNER_AGENT_ID,
      message: PLANNER_LABEL,
      passed: result.status === "done" || result.status === "responded",
    });

    // session.send() handles Ctrl+C internally (it never throws) — resolves
    // with "interrupted" instead of an AbortError, unlike the old one-shot
    // proposePlan()'s raw completion. Same user-facing message either way.
    if (result.status === "interrupted") {
      echo("▸ planner cancelled\n");
    }

    return result;
  } catch (err) {
    session.setGreenfieldMode(false);
    ui.report({
      kind: "agent_result",
      task: "session",
      agentId: PLANNER_AGENT_ID,
      message: PLANNER_LABEL,
      passed: false,
    });

    const aborted =
      (err instanceof Error && err.name === "AbortError") ||
      (err instanceof Error && /abort/i.test(err.message));

    echo(
      aborted
        ? "▸ planner cancelled\n"
        : `▸ planner failed: ${err instanceof Error ? err.message : String(err)}\n`
    );

    // Resolve, don't throw — matches the prior one-shot planner's contract
    // (it never let an exception escape) and drive()'s: it has no catch
    // around its own run(opts) call, so a throw here would skip persist()/
    // reviewAfterGreen() and propagate uncaught into the REPL's line loop.
    return {
      status: aborted ? "interrupted" : "stuck",
      turns: 0,
    };
  } finally {
    ui.stopLive?.();
  }
}

/** Narrow approval — GENERAL plan mode, where the model asks clarifying
 *  questions: a "yes" may ANSWER a question, so only unambiguous approval
 *  words exit the mode and start implementing. */
export { shouldDispatchReplLine } from "./repl-line";
export { resolveChromeStatus } from "./repl-status";

export function isPlanApproval(line: string): boolean {
  return /^(approve|approved|go|lgtm|implement)[.!]?$/i.test(line.trim());
}

/** How a free-text (non-slash) REPL line is routed. Pure so the safety-critical
 *  ORDERING is unit-testable without the readline loop. */
export type ReplRoute = "answer" | "plan-approval" | "plan-discuss" | "normal";

/** Shared gate for "this line should bind the pending plan", not chat/steer text.
 *  `hasPendingPlan` covers present_plan (including after Shift+Tab left plan mode);
 *  `planMode && planDiscussed` covers the legacy ## Plan text path. */
export function wantsPlanApproval(
  line: string,
  state: {
    readonly planMode: boolean;
    readonly planDiscussed: boolean;
    readonly awaitingAnswer: boolean;
    readonly hasPendingPlan: boolean;
  }
): boolean {
  if (state.awaitingAnswer || !isPlanApproval(line)) {
    return false;
  }

  return state.hasPendingPlan || (state.planMode && state.planDiscussed);
}

/** Peel plan-approvals out of a mid-run steer queue (pure — REPL binds after abort). */
export function peelSteerQueue(
  lines: readonly string[],
  state: {
    readonly planMode: boolean;
    readonly planDiscussed: boolean;
    readonly awaitingAnswer: boolean;
    readonly hasPendingPlan: boolean;
  }
): { readonly steer: string[]; readonly approve: boolean } {
  const steer: string[] = [];
  let approve = false;

  for (const line of lines) {
    if (wantsPlanApproval(line, state)) {
      approve = true;
      continue;
    }

    steer.push(line);
  }

  return { steer, approve };
}

/** Decide the route for a free-text line. `awaitingAnswer` (the session paused on
 *  `ask_user`) is checked FIRST and unconditionally → the line is the ANSWER, so
 *  "go"/"approve" replies to the model's question and CANNOT be mistaken for a plan
 *  approval (which would unlock mutating tools). Only after that does plan-mode routing
 *  apply. (Slash commands are handled earlier, in runLine, and are intentionally not
 *  rerouted here — a slash during a pause is a deliberate command.) */
export function classifyReplRoute(
  line: string,
  state: {
    readonly planMode: boolean;
    readonly planDiscussed: boolean;
    readonly awaitingAnswer: boolean;
    /** present_plan proposal waiting on disk-bind; optional for older call sites. */
    readonly hasPendingPlan?: boolean;
  }
): ReplRoute {
  if (state.awaitingAnswer) {
    return "answer";
  }

  if (
    wantsPlanApproval(line, {
      planMode: state.planMode,
      planDiscussed: state.planDiscussed,
      awaitingAnswer: false,
      hasPendingPlan: state.hasPendingPlan === true,
    })
  ) {
    return "plan-approval";
  }

  return state.planMode ? "plan-discuss" : "normal";
}

/** Whether the REPL is (still) awaiting an ask_user answer after a send resolves.
 *  - a NEW pause (`result.awaitingUser` set) → true;
 *  - a send that made NO progress (`turns === 0`) and failed (`interrupted`/`stuck` —
 *    Session.send catches abort/provider errors and returns exactly these with turns 0,
 *    it rarely throws) → KEEP the current flag: the answer was never processed, so the
 *    retry must still route as the answer (not a stray plan approval);
 *  - any send that ran at least one turn (`turns > 0`) CONSUMED the answer — even a
 *    later ladder-exhaustion `stuck` (turns = maxTurns) — → false. Keeping the flag
 *    then would strand plan-mode approval, routing every later free-text line as an
 *    answer until the next terminal send. */
export function nextAwaitingAnswer(
  current: boolean,
  result: {
    readonly status: string;
    readonly awaitingUser?: string;
    readonly turns?: number;
  }
): boolean {
  if (result.awaitingUser !== undefined) {
    return true;
  }

  if (
    result.turns === 0 &&
    (result.status === "interrupted" || result.status === "stuck")
  ) {
    return current;
  }

  return false;
}

/** WS-C: whether a real human is at the keyboard. Only a TTY stdin has someone who can
 *  answer an ask_user / raise-hand pause. Piped / non-TTY input (`echo "task" | tsforge`)
 *  has no human: offering ask_user there would advertise a pause nobody can resume, and
 *  EOF would end the REPL with the build parked mid-question — so `interactive` is gated on
 *  this, not hard-coded true. */
export function humanAtKeyboard(): boolean {
  // @types/node types `isTTY` as boolean, but at runtime it is `undefined` on a non-TTY
  // stream — which is falsy, so a piped REPL correctly resolves to non-interactive.
  return process.stdin.isTTY;
}

/**
 * When non-null, an interactive TTY cannot host the pane console — caller should
 * print the reason and exit. Non-TTY / pipes return null (plain path, no panes).
 */
export function paneConsoleRejectReason(opts: {
  stdinTty: boolean;
  stdoutTty: boolean;
  rows: number;
}): string | null {
  if (!opts.stdinTty || !opts.stdoutTty) {
    return null;
  }

  if (canUsePaneTui(opts.rows)) {
    return null;
  }

  return `tsforge: need a terminal at least ${String(PANE_MIN_ROWS)} rows high (got ${String(opts.rows)})`;
}

// The /help body is generated from the command registry (src/cli/commands.ts) so
// the help text and the interactive `/` palette can never drift.
const HELP = formatHelp();

/** Carry resume-only Session.create fields from a persisted record. */
function resumeCarry(resumed: ISessionRecord | null): {
  pausedWithEdit?: boolean;
  touched?: string[];
  activePlanId?: string;
} {
  if (resumed === null) {
    return {};
  }

  return {
    ...(resumed.pausedWithEdit === true ? { pausedWithEdit: true } : {}),
    ...(resumed.touched !== undefined && resumed.touched.length > 0
      ? { touched: resumed.touched }
      : {}),
    ...(typeof resumed.activePlanId === "string" &&
    resumed.activePlanId.length > 0
      ? { activePlanId: resumed.activePlanId }
      : {}),
  };
}

/** Initialize the REPL session: resolve model, gate, context window, and create
 *  the session object. Returns the session, provider, and config metadata.
 *  Extracted to reduce repl() cognitive complexity. */
async function initReplSession(args: ICliArgs): Promise<{
  session: Session;
  provider: OpenAICompatibleProvider;
  activeName: string;
  contextWindow: number;
  id: string;
  gateLabel: string;
  logFile: string;
  report: Reporter;
  resumed: ISessionRecord | null;
  files: string[];
  activeModelEntry: IModelEntry;
  autoGate?: AutoGateResolver;
}> {
  const bound = await resolveScaffoldedWorkspace(args.dir);

  if (bound !== args.dir) {
    bootWrite(`  ↳ project is ${bound}\n`);
    args.dir = bound;
    process.chdir(bound);
  }

  const activeModel = await modelForRun(args);
  const provider = makeProvider(activeModel.entry);
  const activeName = activeModel.name;

  warnDefaultModelOnRemote(activeModel.entry);

  // Best-effort cleanup of stale sessions on every launch.
  await pruneSessions();

  // --resume <id> loads a specific session; --continue the newest for this dir.
  const resumed =
    args.resumeId.length > 0
      ? await loadSession(args.resumeId)
      : args.continue
        ? await latestSession(args.dir)
        : null;

  if ((args.continue || args.resumeId.length > 0) && resumed === null) {
    bootWrite("(no matching saved session — starting fresh)\n");
  }

  // Keep the strictness a resumed build was started with: re-apply its saved `--profile`
  // so `--continue` doesn't silently drop to the default (users shouldn't have to re-pass
  // flags to keep building at the level they chose). Flows to BOTH the gate (resolveGate)
  // and the Session's rule severities (Session.create reads args.profile). An explicit
  // `--profile` THIS run still wins.
  args.profile = resumedProfileArg(args.profile, resumed);
  // Same for --strict-floor-only: an explicit flag THIS run still wins.
  args.strictFloorOnly =
    args.strictFloorOnly || resumed?.strictFloorOnly === true;

  const id = resumed?.id ?? newSessionId();
  const { accept, gateLabel, lintFile, autoGate } = await resolveGate(
    args,
    resumed
  );
  const files = resumed !== null ? resumed.files : scopeOf(args);
  const logFile = resolveLogPath(id, args.log);

  if (logFile.length > 0) {
    bootWrite(`  ↳ logging this run to ${logFile}\n`);
  }

  // Scout seeds a one-shot drive-to-green run's first prompt; interactive sessions
  // gather context conversationally, so it doesn't apply here. Say so rather than
  // silently ignore the flag.
  if (args.scout) {
    bootWrite(
      '  ↳ note: --scout applies to one-shot runs (tsforge "task" --files … --scout); ignored in interactive mode\n'
    );
  }

  const thinkingTokenBudget = envNumber("TSFORGE_THINKING_BUDGET");
  // Auto-compaction threshold (fraction of the window); session default 0.8.
  const autoCompactAt = envNumber("TSFORGE_COMPACT_AT");
  // The USABLE context window: the model entry wins, then env, then the server's
  // advertised max_model_len, then a conservative fallback. Drives the status gauge
  // AND auto-compaction (the session compacts before a send once it nears this).
  // The server's answer is the ADVERTISED maximum, which on a self-hosted box can
  // sit far past the point where prefill stops being practical — a window set too
  // high doesn't just skew the gauge, it puts the compaction threshold out of reach
  // entirely. Self-hosted entries should declare the number the hardware sustains.
  const contextWindow =
    activeModel.entry.contextWindow ??
    envNumber("TSFORGE_CONTEXT_WINDOW") ??
    (await detectContextWindow(provider.config)) ??
    32_768;
  const report = makeReporter(logFile, id, id);
  const profile = resolveCliProfile(args.profile);
  const gatedBuild = autoGate !== undefined || accept.length > 0;
  const config = {
    provider,
    cwd: args.dir,
    files,
    accept,
    contextWindow,
    report,
    // Offer `ask_user` (WS-C) only when a human is actually at the keyboard (TTY): the
    // model can pause for a bounded question and the human's next line answers it. Piped /
    // non-TTY input has no one to answer, so it stays unattended (ask_user proceeds).
    // No per-action approval UI exists yet, so `ask` must resolve to DENY with
    // an honest reason — passing `true` here kept the verdict `ask`, which
    // executeTool then rejected anyway but with a message claiming a human was
    // consulted. Flip back to humanAtKeyboard() only when a real prompt lands.
    interactive: false,
    humanPresent: humanAtKeyboard(),
    offerTaskTools: true,
    offerPresentPlan: true,
    // PER-WRITE lint moat (eslint rules per file as it's written), so violations
    // surface immediately instead of piling up at the end-of-turn gate.
    ...(lintFile === undefined ? {} : { lintFile }),
    // The DYNAMIC auto-gate: re-detects the stack every cycle so a greenfield build
    // enables framework rule-packs (React, etc.) as soon as the model writes them,
    // instead of staying on the empty-dir `generic-ts` fallback. Absent ⇒ commandGate.
    ...(autoGate === undefined ? {} : { autoGate }),
    // Gated interactive builds (auto-gate or accept) get drive-to-green + on-demand
    // `check` — DeepSeek greenfield dogfood burned turns waiting for end-of-turn settle.
    ...(gatedBuild
      ? { executionMode: "drive-to-green" as const, offerCheck: true as const }
      : {}),
    ...(resumed === null ? {} : { history: resumed.messages }),
    ...(resumed?.lastPromptTokens !== undefined
      ? { lastPromptTokens: resumed.lastPromptTokens }
      : {}),
    // Opt into the SCOPED format janitor (replaces the old whole-repo `fix`): the loop's
    // autoFixStep runs a strict eslint --fix + prettier over the files the model wrote
    // this session (ctx.tool.touched — NOT task.files, which defaults to ["**/*"] here),
    // deferring to the project's own prettier — so a build never reformats files it
    // didn't touch, and never with the wrong prettier. (A spec may still set its own
    // per-task `fix`.) MUST also be set on the /clear rebuild below.
    coreFormat: true,
    ...resumeCarry(resumed),
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
    // `--policy-mode` (validated) overrides the config file's policy.mode.
    ...(isPolicyMode(args.policyMode) ? { policyMode: args.policyMode } : {}),
    ...(profile === undefined ? {} : { profile }),
    ...(args.strictFloorOnly ? { strictFloorOnly: true as const } : {}),
    // Thinking OFF for interactive replies so they STREAM immediately instead of
    // stalling on a long hidden chain-of-thought (the local default has thinking on).
    // The session still flips thinking ON automatically while repairing gate errors.
    enableThinking: false,
    ...(await stackSessionExtras(args.dir)),
  };

  const session = await Session.create(config);

  // A self-describing run-meta line at the top of the --log so the analyzer knows
  // which model / context window the metrics are against (the thread's advice:
  // many "model failures" are really quant/config failures — record the config).
  report({
    kind: "start",
    task: "session",
    message: `model ${modelInfo(provider.config).model} · context window ${contextWindow}`,
    model: modelInfo(provider.config).model,
    contextWindow,
  });

  return {
    session,
    provider,
    activeName,
    contextWindow,
    id,
    gateLabel,
    logFile,
    report,
    resumed,
    files,
    activeModelEntry: activeModel.entry,
    ...(autoGate === undefined ? {} : { autoGate }),
  };
}

/** The `autoGate` field to spread into a rebuilt Session.create — the resolver only when
 *  it is present AND still driving (`active`). Kept module-level so the `/clear` handler
 *  stays branch-free: after a manual `/gate` override the resolver is withheld, so the
 *  rebuild never silently re-arms the auto gate over the user's command. */
/** Session settings the /clear rebuild must carry — the env-knob and
 *  --policy-mode trio that used to silently revert to defaults (D2). */
export function clearCarrySettings(policyModeArg: string): {
  thinkingTokenBudget?: number;
  autoCompactAt?: number;
  policyMode?: PolicyMode;
} {
  const thinkingTokenBudget = envNumber("TSFORGE_THINKING_BUDGET");
  const autoCompactAt = envNumber("TSFORGE_COMPACT_AT");

  return {
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
    ...(isPolicyMode(policyModeArg) ? { policyMode: policyModeArg } : {}),
  };
}

export function autoGateCarry(
  autoGate: AutoGateResolver | undefined,
  active: boolean
): { autoGate?: AutoGateResolver } {
  return autoGate !== undefined && active ? { autoGate } : {};
}

/**
 * The gate a `clearConversation` rebuild should use: the CURRENT session's gate
 * carried forward (via `autoGateCarry`) when the directory is unchanged, or a
 * FRESH resolution against the NEW directory when it changed (scaffold, `/dir`).
 *
 * A directory change must never carry the OLD auto-gate resolver forward: its
 * `tscPart()` overlay is an EPHEMERAL file written relative to whatever
 * directory it was resolved against (`.tsforge/tsconfig.gate.json`). Reusing it
 * for a session whose cwd is now a DIFFERENT directory detaches the overlay
 * from where the gate actually executes — the resolver keeps writing it under
 * the OLD dir while every gate run's relative `-p` path resolves against the
 * NEW one, so the gate fails with `TS5058: path does not exist` forever, on
 * every cycle, unfixable by the model (it is a harness artifact, not something
 * in the model's editable scope). Re-resolving fresh against the new directory
 * — exactly what a cold boot into that directory would do — is the only way to
 * keep the overlay and the execution cwd pointed at the same place.
 */
export async function reboundGateForRebuild(
  args: ICliArgs,
  dirChanged: boolean,
  current: {
    readonly accept: string;
    readonly autoGate: AutoGateResolver | undefined;
    readonly autoGateActive: boolean;
  },
  resolve: typeof resolveGate = resolveGate
): Promise<{ accept: string; autoGate?: AutoGateResolver }> {
  if (!dirChanged) {
    return {
      accept: current.accept,
      ...autoGateCarry(current.autoGate, current.autoGateActive),
    };
  }

  const resolved = await resolve(args, null);

  return {
    accept: resolved.accept,
    ...(resolved.autoGate === undefined ? {} : { autoGate: resolved.autoGate }),
  };
}

/** The effective `--profile` for a run: a resumed session's saved profile fills in when the
 *  user didn't pass one THIS run, so `--continue` keeps the strictness the build was started
 *  with. An explicit CLI `--profile` always wins. Only a VALID saved id is restored — a
 *  corrupted / hand-edited record's bad profile is ignored (never applied or re-persisted). */
export function resumedProfileArg(
  cliProfile: string,
  resumed: ISessionRecord | null
): string {
  const saved = resumed?.profile ?? "";

  return cliProfile.length === 0 && isProfileId(saved) ? saved : cliProfile;
}

/** One-line plan-mode banner for a fresh interactive session. */
function maybeWritePlanModeIntro(planMode: boolean): void {
  if (!planMode) {
    return;
  }

  const chip = paint("◆ plan mode (default)", STYLE.brand + STYLE.bold, true);
  const body = paint(
    "— I'll explore and propose a plan; reply",
    STYLE.dim,
    true
  );
  const approve = paint("approve", STYLE.green + STYLE.bold, true);
  const tail = paint("to build", STYLE.dim, true);

  bootWrite(`  ${chip} ${body} ${approve} ${tail}\n`);
}

/**
 * Wire terminal restoration for a pane-TUI session. `'exit'` covers a normal
 * return/`process.exit`. A signal the process doesn't HANDLE terminates it
 * WITHOUT firing 'exit', leaving SGR mouse tracking on — iTerm then pastes
 * `0;23;22M` into the shell on every click. SIGTERM/SIGHUP restore then re-raise.
 * Do NOT hook SIGINT: the editor owns Ctrl+C (abort vs quit). Stealing SIGINT
 * leaves the alt screen and kills Ctrl+G.
 * `writeSync` so the `'exit'` path cannot drop the bytes.
 */
function installTerminalRestore(
  paneScreen: { leave: () => void },
  getEditor: () => { close: () => void } | null
): void {
  const restore = (): void => {
    getEditor()?.close();
    paneScreen.leave();

    try {
      writeSync(1, RESTORE_TERMINAL);
    } catch {
      // stdout already gone
    }
  };

  process.on("exit", restore);

  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      restore();
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

/** Print the one-line boot notice when the git/GitHub capability is on. Kept a
 *  module helper so its branch stays out of `repl`'s cognitive-complexity budget. */
function announceGithub(on: boolean): void {
  if (on) {
    bootWrite("  ↳ github: on (git + PR review via gh)\n");
  }
}

/** Boot notice for the Linear capability. Module helper to keep its branch out of
 *  `repl`'s cognitive-complexity budget (mirrors announceGithub). */
function announceLinear(on: boolean): void {
  if (on) {
    bootWrite("  ↳ linear: on (issues + start-work via MCP)\n");
  }
}

/** Generic boot notice for a curated MCP integration (notion/sentry). Module helper
 *  so its branch stays out of `repl`'s cognitive-complexity budget. */
function announceIntegration(on: boolean, name: string, detail: string): void {
  if (on) {
    bootWrite(`  ↳ ${name}: on (${detail})\n`);
  }
}

/** Hold every boot diagnostic (the model/capability banner, MCP connect results,
 *  config warnings) until the pane console exists, so `seedPaneLanding` can put
 *  it in the scrollback. The pane's first full paint clears the screen, so
 *  anything written before that flickers once and is gone — which is how a real
 *  "MCP server failed to connect" line became invisible noise. Headless and
 *  non-TTY runs never enter the pane, so they keep writing straight out. */
function beginBootCapture(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  outputRouter.beginCapture();
  // models.json MCP diagnostics are emitted during config load, before any of
  // this is on screen; route them into the same buffer.
  setMcpDiagnosticSink(bootWrite);
}

/** Release the boot buffer to stdout — the paths where the pane never painted,
 *  so swallowing it would lose real diagnostics. */
function flushBootCaptureToStdout(): void {
  if (outputRouter.capturing) {
    process.stdout.write(outputRouter.endCapture());
    setMcpDiagnosticSink(null);
  }
}

/** Interactive REPL: a persistent gate-anchored conversation. */
export async function repl(args: ICliArgs): Promise<number> {
  // Interactive sessions get web tools ON by default (an assistant that can't look
  // things up is silly). Only a DEFAULT — an explicit TSFORGE_WEB (incl. "0") wins,
  // and one-shot/headless/eval never run this path, so they stay offline+deterministic.
  process.env.TSFORGE_WEB ??= "1";

  beginBootCapture();

  const {
    session: initialSession,
    provider,
    activeName: initialActiveName,
    contextWindow: initialContextWindow,
    id,
    gateLabel: initialGateLabel,
    logFile,
    report,
    resumed,
    activeModelEntry,
    autoGate,
  } = await initReplSession(args);

  // Reviewer model(s) for the review phase — from models.json `reviewModels` or the
  // TSFORGE_REVIEW_* envs. Empty ⇒ the main model reviews (the default). Resolved
  // once at boot so the review call sites stay synchronous.
  const modelsCfg = await loadModelsConfig();
  const reviewProviders = resolveReviewProviders(modelsCfg);

  warnReviewConfigSplit(modelsCfg);
  warnSelfReview(reviewProviders);
  const reviewStatusLabel = (): string =>
    reviewProviders.length > 1
      ? `reviewing ×${String(reviewProviders.length)}`
      : "reviewing";
  // File-level fan-out for the review. A configured panel is remote + independent
  // (e.g. OpenRouter), so it's safe to overlap several files at once (a floor of 4)
  // instead of one-at-a-time. Self-review (the main model, one endpoint) respects
  // the configured delegation cap so a serial endpoint isn't swamped.
  const reviewConcurrency = (): number =>
    reviewProviders.length > 0 ? Math.max(delegationCap, 4) : delegationCap;

  // Load delegation inputs HERE — before readline is created below. Any `await`
  // between `createInterface` and the `rl.on("line")` listener would yield the
  // event loop with readline live but unlistened, dropping the first typed line
  // (a real pty regression the e2e caught). All boot IO must finish up front.
  const agentSpecs = await loadAgentSpecs(args.dir, (m) => {
    bootWrite(`  ↳ ${m}\n`);
  });
  const delegationConfig = await loadTsforgeConfig(args.dir);
  // Which image capabilities are configured — decides whether read_image /
  // generate_image are offered and whether attached images get described.
  // Resolved up front (a boot IO), so the wiring below stays synchronous.
  const imageCaps = await resolveImageCapabilityFlags();
  // The `github` capability = the user's consent to git/GitHub operations (gh
  // installed + authenticated). Resolved once up front like the image caps.
  const githubCap = await resolveGithubCapability(undefined, args.dir);

  let session = initialSession;
  let activeName = initialActiveName;
  let contextWindow = initialContextWindow;
  // A human label for the gate (e.g. "strict TypeScript / project lint"), shown in
  // the header + /config instead of the raw multi-line command. Updated when the
  // user sets a gate via /config.
  let gateLabel = initialGateLabel;

  const writeSession = async (): Promise<void> => {
    await saveSession({
      id,
      cwd: args.dir,
      // The LIVE gate/scope — not the startup constants. /gate, /files, and a web
      // scaffold all mutate these mid-session; persisting the originals would
      // silently restore stale settings on --continue. See P2 review.
      accept: session.gate,
      // Persist whether the AUTO gate is still driving, so --continue re-attaches stack
      // re-detection for an auto session but keeps a manual override (setGate flipped it
      // false) verbatim — no silent re-arm of the auto gate on resume.
      auto: session.autoGateActive,
      // Persist the strictness (--profile) so --continue keeps it without re-passing flags.
      ...(args.profile.length > 0 ? { profile: args.profile } : {}),
      ...(args.strictFloorOnly ? { strictFloorOnly: true as const } : {}),
      files: session.scope,
      updatedAt: Date.now(),
      planMode,
      // Persist a still-pending deferred gate so --continue re-gates it (WS-C).
      pausedWithEdit: session.hasDeferredGate,
      touched: session.touchedFiles,
      activePlanId: session.getActivePlanId(),
      ...(session.lastPromptTokens > 0
        ? { lastPromptTokens: session.lastPromptTokens }
        : {}),
      messages: [...session.messages],
    });
  };

  // Debounced persistence: the save serializes + redacts the WHOLE transcript,
  // and awaiting it at turn end blocked the loop exactly when the user starts
  // typing the next prompt. Writes are serialized through one in-flight chain
  // (never two racing; last write wins), the FIRST save stays eager so the
  // session file exists early, and exits flush via persistNow(). Tradeoff: a
  // hard crash inside the debounce window loses ≤500ms of --continue state.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let persistedOnce = false;
  const PERSIST_DEBOUNCE_MS = 500;

  const persistNow = async (): Promise<void> => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }

    persistChain = persistChain.then(writeSession, writeSession);
    await persistChain;
  };

  const persist = async (): Promise<void> => {
    if (!persistedOnce) {
      persistedOnce = true;
      await persistNow();

      return;
    }

    if (persistTimer !== null) {
      return;
    }

    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, PERSIST_DEBOUNCE_MS);
  };

  // "update available" notice: read from the local cache (no network on the hot
  // path) and refresh it in the background for next time. Gated to interactive,
  // non-CI sessions inside update-check, so eval/headless runs are unaffected.
  const updateNotice = await getUpdateNotice(currentVersion());

  refreshUpdateCacheInBackground();

  // Landing is seeded into PaneScreen after enter() — never print a banner into
  // the primary buffer (it would flash, then get wiped).

  const interactiveTty = process.stdin.isTTY && process.stdout.isTTY;
  const rejectPane = paneConsoleRejectReason({
    stdinTty: process.stdin.isTTY,
    stdoutTty: process.stdout.isTTY,
    rows: process.stdout.rows > 0 ? process.stdout.rows : 0,
  });

  if (rejectPane !== null) {
    process.stderr.write(`${rejectPane}\n`);

    return 1;
  }

  // Interactive TTY always hosts the pane console (height gated above). Readline
  // does line-EDITING but must not RENDER — we paint via PaneScreen. Pipes use
  // plain stdout (no panes).
  const useInputRow = interactiveTty;

  // In editor mode, do NOT create readline — the editor owns stdin exclusively.
  // In fallback mode (non-TTY or basicInput), readline is the only consumer.
  const useEditor = useInputRow && !flags.basicInput();

  const inputSink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });

  const rl = useEditor
    ? null
    : createInterface({
        input: process.stdin,
        output: useInputRow ? inputSink : process.stdout,
        terminal: true,
      });

  // Ctrl-C: while a turn is running, abort it and return to the prompt; while
  // idle at the prompt, quit. (readline emits SIGINT on the interface, so the
  // process isn't killed — we decide what it means.)
  let active: AbortController | null = null;
  // Lines typed WHILE a run is in flight — drained at each turn boundary to steer
  // the model (see Session.send `steer`), instead of blocking until the run ends.
  const pending: string[] = [];

  if (rl !== null) {
    rl.on("SIGINT", () => {
      if (active !== null) {
        active.abort();
      } else {
        rl.close();
      }
    });
  }

  // Plan mode is the DEFAULT for a fresh interactive session (opt out with
  // `--no-plan` or an explicit non-plan `--policy-mode`/config `policy.mode`).
  // For a staged web build it pauses after the design phase to review the plan;
  // for EVERYTHING else it is the general read-only mode: the agent explores,
  // asks clarifying questions, and proposes a plan — only an explicit approval
  // unlocks tools and implements. A resumed session restores its saved mode
  // (the read-only guarantee must survive `--continue`).
  let planMode = resolveInitialPlanMode(
    args,
    resumed?.planMode,
    session.basePolicyMode
  );
  // True once a plan-mode exchange has happened, so a stray "approve" before any
  // discussion is just a message, not an approval.
  let planDiscussed = false;
  // WS-C: true when the last send paused on `ask_user`. The NEXT free-text line is the
  // ANSWER — routed to a normal send BEFORE plan-approval detection (classifyReplRoute),
  // so "go"/"approve" answers the question, not the plan (which would unlock mutations).
  // Slash commands still run (handled in runLine before dispatch) — a slash during a
  // pause is a deliberate command; and the answer goes through the normal send path
  // (@file/image expansion still apply — it is not sent byte-for-byte verbatim).
  let awaitingUserAnswer = false;
  // The current interactive mode (Shift+Tab cycles it; /plan toggles it). Kept in
  // sync with `planMode`; shown as a chip in the pane footer.
  let currentModeId = planMode ? "plan" : "normal";

  session.setPlanMode(planMode);
  maybeWritePlanModeIntro(planMode);

  // Model-driven delegation: the orchestrator can spawn read-only specialist
  // subagents via the `spawn_agent` tool — the user never names an agent.
  // Specialists ship built-in (explore/research/verify/review-lens); a
  // project/global `.tsforge/agents/*.json` extends or overrides them.
  // Build the delegation runner from the specs/config loaded up front (sync — no
  // await here, so readline's line listener attaches in the same tick as the
  // rest of the interactive setup; see the load site above).
  const delegationCap = resolveAgentConcurrency(delegationConfig);
  const spawnAgentFn = makeSpawnAgentFn({
    specs: agentSpecs,
    cwd: args.dir,
    concurrency: delegationCap,
    // Subagents auto-compact against the same window as the main loop, so a
    // long read-only investigation never overflows and 400s.
    contextWindow,
    policyMode: isPolicyMode(args.policyMode)
      ? args.policyMode
      : (delegationConfig.policy?.mode ?? "default"),
    // Read the parent's CURRENT mode at spawn time (B9): plan mode / a mid-
    // session cycle must reach the child, not the startup value.
    getPolicyMode: () => session.effectivePolicyMode,
    ...(delegationConfig.policy?.rules === undefined
      ? {}
      : { policyRules: delegationConfig.policy.rules }),
    ...(args.model.length > 0 ? { defaultModel: args.model } : {}),
    // Reuse the session's TS LanguageService across subagents (read lazily so it
    // tracks the current session after /clear) instead of building one per child.
    getTsService: () => session.tsService,
  });

  // Re-applied after `/clear` rebuilds the session (like setSetupWeb). Skipped
  // entirely under TSFORGE_NO_DELEGATION — the A/B control arm / pure single-stream.
  const delegationOff = flags.noDelegation();

  const wireDelegation = (): void => {
    if (delegationOff) {
      return;
    }

    session.setDelegation(agentSpecs, spawnAgentFn);
  };

  wireDelegation();

  // Image capabilities: offer read_image/generate_image when their backends are
  // configured, and wire the inline preview for generated images. The preview
  // emits the terminal's inline-image escape (iTerm2 today) via the pane stream
  // so it lands in scrollback; unsupported terminal → no-op (the tool still
  // reports the saved path).
  // A small budget stops a runaway loop from flooding the scrollback. Re-applied
  // after /clear (like setSetupWeb/wireDelegation) since /clear rebuilds session.
  const imageProtocol = detectImageProtocol();
  const imageBudget = makeImageBudget();
  // Absolute temp-file paths captured from the clipboard (Ctrl+V of image bytes),
  // consumed (described + cleared) on the next send by resolveImageInput.
  const pendingImages: string[] = [];

  /** Pane-console chrome facade (overlays / agent tree / input). */
  interface ILiveChrome {
    hasChrome(): boolean;
    setOverlay(lines: readonly string[]): void;
    clearOverlay(): void;
    setEditorOverlay(lines: readonly string[]): void;
    clearEditorOverlay(): void;
    setAgentTree(lines: readonly string[]): void;
    clearAgentTree(): void;
    setInput(line: string, cursor: number): void;
    setEditor(
      lines: readonly string[],
      cursorRow: number,
      cursorCol: number
    ): void;
  }

  // Assigned once PaneScreen exists; pasteFromClipboard closes over it.
  let liveChrome: ILiveChrome | null = null;

  // Ctrl+V in the editor: a clipboard IMAGE becomes a `[image #N]` chip + a pending
  // attachment (described on send); otherwise fall back to pasting clipboard text.
  // (Cmd+V is swallowed by the terminal — for text it arrives as a bracketed paste;
  // an image on the clipboard never reaches an in-terminal app, hence Ctrl+V.)
  // Uses `liveChrome` (assigned after PaneScreen exists) for the hint.
  const pasteFromClipboard = async (): Promise<string | null> => {
    // Reading the clipboard shells out (osascript can take ~1s), so show a
    // transient hint above the input so the pause reads as "working", not hung.
    // (Install `pngpaste` to make it instant — the reader prefers it.)
    const hinting = liveChrome?.hasChrome() === true;

    if (hinting) {
      liveChrome?.setEditorOverlay(["📋 reading clipboard…"]);
    }

    try {
      const captured = await captureClipboardImageToFile();

      if (captured !== null) {
        pendingImages.push(captured);

        return `[image #${String(pendingImages.length)}]`;
      }

      // Nothing to paste (empty clipboard, or only whitespace/newline — which
      // otherwise injected a blank line). Insert only when there's real content.
      const text = await readClipboardText();

      return text.trim().length > 0 ? text : null;
    } finally {
      if (hinting) {
        liveChrome?.clearEditorOverlay();
      }
    }
  };

  const previewGeneratedImage: NonNullable<
    Parameters<typeof session.setPreviewImage>[0]
  > = ({ path, base64 }) => {
    if (imageProtocol === "none" || !imageBudget.take()) {
      return;
    }

    // `name` is a human-readable filename (base64-encoded into the OSC-1337
    // params), so use the saved file's basename — not the mime type. Split on
    // both separators so a Windows path resolves too.
    const name = path.split(/[\\/]/u).pop() ?? "image";
    const escape = renderInlineImage(base64, imageProtocol, { name });

    if (escape !== null) {
      // Route through the pane stream (NOT raw stdout) so the image lands in
      // scrollback and the next paint keeps chrome intact. Bracket with newlines
      // so the image sits on its own committed lines.
      streamOut(`\n${escape}\n`);
    }
  };

  let linearOn = false;
  let notionOn = false;
  let sentryOn = false;

  const wireImages = (): void => {
    session.setImageCapabilities(imageCaps);
    session.setPreviewImage(previewGeneratedImage);
    session.setGithubCapability(githubCap);
    linearOn = session.setLinearCapability();
    notionOn = session.setNotionCapability();
    sentryOn = session.setSentryCapability();
  };

  wireImages();
  announceGithub(githubCap);
  announceLinear(linearOn);
  announceIntegration(notionOn, "notion", "pages + knowledge via MCP");
  announceIntegration(sentryOn, "sentry", "errors + fixes via MCP");

  if (imageCaps.vision || imageCaps.imageGen) {
    const on = [
      ...(imageCaps.vision ? ["read"] : []),
      ...(imageCaps.imageGen ? ["generate"] : []),
    ].join(" + ");

    bootWrite(`  ↳ image: ${on} (drag/@ to attach)\n`);
  }

  // Make the delegation setup visible so the concurrency cap is never a mystery
  // (cap 1 ⇒ subagents run serially; raise agents.concurrency to overlap them).
  if (delegationOff) {
    bootWrite("  ↳ delegation: OFF (TSFORGE_NO_DELEGATION)\n");
  } else if (agentSpecs.length > 0) {
    const names = agentSpecs.map((s) => s.id).join(", ");

    bootWrite(
      `  ↳ delegation: ${String(agentSpecs.length)} specialists (${names}) · cap ${String(delegationCap)}\n`
    );
  }

  // Last-turn summary, surfaced in the status line shown before each prompt.
  let lastTurns = 0;
  // Turns the last GREEN run took (the loop-efficiency signal shown in /metrics).
  let lastTurnsToGreen: number | null = null;
  let lastElapsedMs = 0;
  let lastStatus = "ready";
  // The last review's report (structured findings), kept so `/reviewfix` can seed
  // the worklist — one task per finding — and hand the agent a real map to work
  // through (the "offer to fix" half of report-then-fix). null ⇒ nothing to fix.
  let lastReviewReport: IReviewReport | null = null;

  // Set when the user types approve mid-turn (or it was drained from the steer
  // queue). Must NOT be injected as chat — that leaves plan mode on, withholds
  // task_* tools, and poisons the Tasks rail (seen live on Ledgerkit).
  let pendingPlanApprove = false;

  const approvalRouteState = (): {
    planMode: boolean;
    planDiscussed: boolean;
    awaitingAnswer: boolean;
    hasPendingPlan: boolean;
  } => ({
    planMode,
    planDiscussed,
    awaitingAnswer: awaitingUserAnswer,
    hasPendingPlan: session.getPendingPlan() !== null,
  });

  /** Pull queued lines for steer; peel plan-approvals out to bind after abort. */
  const drainSteerQueue = (): string[] => {
    const drained = pending.splice(0, pending.length);
    const peeled = peelSteerQueue(drained, approvalRouteState());

    if (peeled.approve) {
      pendingPlanApprove = true;
      active?.abort();
    }

    return [...peeled.steer];
  };

  // Show `● reviewing…` (spinner + live status) while `fn` runs, then restore the
  // prior status. Shared by the manual /review command and the after-green review —
  // both run AFTER the turn's spinner has stopped, so without this the bar reads
  // "done" while the model is actually reviewing.
  const withReviewingStatus = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = lastStatus;

    lastStatus = reviewStatusLabel();
    spinner.start();
    paneScreen.setStatus(statusInfo());

    try {
      return await fn();
    } finally {
      spinner.stop();
      lastStatus = prev;
      paneScreen.setStatus(statusInfo());
    }
  };

  // Post-work agent review (interactive): after a turn lands GREEN and actually
  // changed code, review THIS turn's files and surface findings the gate can't —
  // then offer `/reviewfix` to hand them to the agent (report-then-fix). Scoped to
  // the turn's new files so it doesn't re-review the whole branch each turn. Never
  // throws (a review error must not disturb the session); toggle with
  // TSFORGE_NO_REVIEW. Reads `lastReviewFindings` for the fix affordance.
  const reviewAfterGreen = async (
    status: string,
    touchedBefore: ReadonlySet<string>
  ): Promise<void> => {
    lastReviewReport = null;

    if (status !== "done" || flags.noReview()) {
      return;
    }

    const changed = session.touchedFiles.filter((f) => !touchedBefore.has(f));

    if (changed.length === 0) {
      return; // nothing this turn touched — no work to review
    }

    try {
      const result = await withReviewingStatus(() =>
        review(provider, args.dir, {
          files: changed,
          // Stream the fan-out into the live agent tree so each reviewer node
          // appears → runs → completes (visible progress, not a silent wait).
          onEvent: report,
          concurrency: reviewConcurrency(),
          contextWindow,
          ...(reviewProviders.length > 0 ? { reviewProviders } : {}),
        })
      );

      if (result.findings.length === 0) {
        return; // clean — stay quiet, don't nag on every green turn
      }

      // Display the colored, wrapped card in the pane; keep the structured report
      // so /reviewfix can seed the worklist with one task per finding.
      lastReviewReport = result;
      echo(`\n${formatReviewCard(result, transcriptCols(), true)}\n`);
      echo(
        `${paint("↳ /reviewfix", STYLE.dim, true)} to have the agent address these findings.\n`
      );
    } catch (err) {
      echo(
        `${paint("review skipped:", STYLE.dim, true)} ${err instanceof Error ? err.message : String(err)}\n`
      );
    } finally {
      // Clear the review's live nodes so they don't linger until the next turn.
      resetTree();
    }
  };

  // Run one user-driven exchange: fresh abort controller, time it, record the
  // outcome for the status line, persist. `run` gets the live signal + a steer
  // drain so in-flight user messages reach the model.
  const drive = async (
    run: (opts: { signal: AbortSignal; steer: () => string[] }) => Promise<{
      status: string;
      turns: number;
      awaitingUser?: string;
    }>
  ): Promise<void> => {
    active = new AbortController();
    const started = performance.now();
    // Snapshot the change-set BEFORE the turn so the after-green review scopes to
    // what THIS exchange touched, not the whole accumulated branch diff.
    const touchedBefore = new Set(session.touchedFiles);

    lastStatus = "working"; // reflected live on the bar (● working) during the turn
    spinner.start();

    try {
      const result = await run({
        signal: active.signal,
        steer: drainSteerQueue,
      });

      lastTurns = result.turns;

      if (result.status === "done") {
        lastTurnsToGreen = result.turns;
      }

      lastElapsedMs = performance.now() - started;
      lastStatus = result.status;
      // WS-C: track whether the NEXT user line is an ask_user answer. A FAILED answer
      // send (interrupted/stuck) KEEPS the flag so the retry is still the answer — see
      // nextAwaitingAnswer.
      awaitingUserAnswer = nextAwaitingAnswer(awaitingUserAnswer, result);
    } finally {
      spinner.stop();
      active = null;
      // Close the agent card the moment streaming ends, so any post-turn hint
      // (plan-mode notice, PLAN review, etc.) lands BELOW the card instead of
      // inside it — which would break the rail. Idempotent.
      closeAgentTurn();
      resetTree(); // clear the live agent tree once the turn's delegation is done
      // Coalescing flush guarantee: the turn's final streamed text must render
      // now, not whenever the deferred paint timer would have fired.
      paneScreen.flushPendingPaint();
    }

    await persist();
    // `lastStatus` holds this turn's terminal status here (only reached when `run`
    // resolved — a throw skips past this via the finally). Review only on green.
    await reviewAfterGreen(lastStatus, touchedBefore);
  };

  // Free-text user sends route through here: resolve `@file` mentions to inlined
  // contents (composeMessage) before handing the message to the session. The
  // plan-approval / staged-build sends call session.send directly and are not
  // touched, so only ordinary messages get mention expansion.
  const runSend = (line: string): Promise<void> =>
    drive(async (opts) => {
      // Images the user attached (dragged/quoted paths or @-mentioned image files
      // in the line, plus any clipboard captures) are sent to the vision backend
      // and their descriptions prepended as text — the primary model is text-only.
      // The image tokens are stripped from the line before @-file expansion.
      //
      // Only keep clipboard captures whose `[image #N]` chip SURVIVES in the line
      // (paste is `pendingImages[i]` ↔ chip `#${i+1}`) — a deleted chip / cleared
      // buffer must not smuggle a hidden image into a later send. Consumed and
      // dropped temp files are unlinked so tmpdir doesn't accumulate.
      const captures = pendingImages.map((path, i) => ({
        path,
        chip: `[image #${String(i + 1)}]`,
      }));

      pendingImages.length = 0;
      const kept = captures
        .filter((c) => line.includes(c.chip))
        .map((c) => c.path);
      const dropped = captures
        .filter((c) => !line.includes(c.chip))
        .map((c) => c.path);

      await discardClipboardImages(dropped);

      const { cleanedLine, contextBlock } = await resolveImageInput(
        line,
        args.dir,
        { extraPaths: kept, signal: opts.signal }
      );

      await discardClipboardImages(kept);
      const composed = await composeMessage(args.dir, cleanedLine);

      return session.send(`${contextBlock}${composed}`, opts);
    });

  const resolveApprovedPlan = (): IPlanDocument | null => {
    const pending = session.takePendingPlan();

    if (pending !== null) {
      return persistPlanDocument(args.dir, pending);
    }

    const last = session.messages.at(-1);
    const planText =
      last?.role === "assistant" && typeof last.content === "string"
        ? last.content
        : "";
    const seeded = seedWorklistFromPlan(
      args.dir,
      planText,
      goalFromMessages(session.messages)
    );

    if (!seeded.ok) {
      echo(`  ✗ ${seeded.error}\n`);

      return null;
    }

    return seeded.plan;
  };

  const approveBoundPlan = async (): Promise<void> => {
    const plan = resolveApprovedPlan();

    if (plan === null) {
      return;
    }

    session.setActivePlanId(plan.id);
    const first = firstOpenItem(plan.items);
    const focused =
      first === null
        ? null
        : focusPlanItemByTitle(args.dir, plan.id, first.title);

    syncWorklistPanel(focused ?? plan);
    planMode = false;
    planDiscussed = false;
    session.setPlanMode(false);
    setMode("normal");
    await persist();

    const stored = await readPlan(args.dir, phaserPlanSchema);

    if (stored !== null) {
      await writePlan(args.dir, stored.plan, "approved");
    }

    echo(
      `  ✓ plan saved — ${plan.id} (${String(plan.items.length)} top-level items)\n`
    );
    echo("  ✓ plan approved — implementing\n");

    if (stored !== null) {
      session.appendPolicyRules(PHASER_NO_DEV_DENY);
      await drive(async (opts) => {
        const result = await runPhaserBuild({
          cwd: args.dir,
          plan: stored.plan,
          host: phaserHostFromSession(session, {
            cwd: args.dir,
            sendOpts: () => opts,
            onPlanChanged: (plan) => {
              syncWorklistPanel(plan);
            },
          }),
          exec: bunExec,
          echo,
          signal: opts.signal,
          steer: opts.steer,
        });

        return {
          status: result.status === "done" ? "done" : "stuck",
          turns: 0,
        };
      });

      return;
    }

    await drive((opts) => session.send(PLAN_APPROVED_NOTE, opts));
  };

  /** Seed (or extend) the worklist from a review report — one task per finding —
   *  then bind + paint it (mirrors approveBoundPlan). Appends to the active plan if
   *  one is bound (keeping its focus + done items), else creates a new one. Returns
   *  the persisted plan, or null if the draft was rejected. */
  const seedReviewFixPlan = async (
    report: IReviewReport
  ): Promise<IPlanDocument | null> => {
    const goal = "Address code-review findings";
    const norm = normalizePlanDraft(
      { goal, items: reviewFindingsToDrafts(report) },
      goal
    );

    if (!norm.ok) {
      echo(`  ✗ ${norm.error}\n`);

      return null;
    }

    const activeId = session.getActivePlanId();
    const existing = activeId === null ? null : loadPlan(args.dir, activeId);
    const doc: IPlanDocument =
      existing === null
        ? norm.plan
        : { ...existing, items: [...existing.items, ...norm.plan.items] };
    const plan = persistPlanDocument(args.dir, doc);

    if (existing === null) {
      session.setActivePlanId(plan.id);
    }

    syncWorklistPanel(plan);
    await persist();

    return plan;
  };

  const discussInPlanMode = async (line: string): Promise<void> => {
    await runSend(line);
    planDiscussed = true;

    // present_plan already paints the card + approve footer mid-turn. Only
    // nudge here for the legacy ## Plan heading path (no present_plan call).
    const last = session.messages.at(-1);
    const plannedHeading =
      last?.role === "assistant" && /^##\s*plan\b/im.test(last.content);

    if (plannedHeading && session.getPendingPlan() === null) {
      const cols = panesLive()
        ? paneScreen.mainInnerCols()
        : process.stdout.columns > 0
          ? process.stdout.columns
          : 80;

      echo(`\n${planHint(true, cols)}\n`);
    }
  };

  const plannerLive: {
    start: () => void;
    stop: () => void;
    note: (text: string) => void;
  } = {
    start: () => undefined,
    stop: () => undefined,
    note: () => undefined,
  };

  const greenfieldUi: IGreenfieldPlanningUi = {
    report,
    present: (plan) => {
      session.presentHarnessPlan(plan);
    },
    startLive: () => {
      plannerLive.start();
    },
    stopLive: () => {
      plannerLive.stop();
    },
    note: (text) => {
      plannerLive.note(text);
    },
  };

  // Greenfield planning is a real turn on THIS session (not a second Session,
  // not a raw tool-less completion) — session.setGreenfieldMode/send already
  // satisfy IGreenfieldSession structurally, so it's passed straight through.
  const planProduct = (stack: IStackAdapter, line: string): Promise<void> =>
    drive((opts) =>
      runGreenfieldPlanning(
        args.dir,
        line,
        echo,
        stack,
        greenfieldUi,
        session,
        opts
      )
    );

  const dispatch = async (line: string): Promise<void> => {
    const route = classifyReplRoute(line, approvalRouteState());

    // WS-C: the previous send paused on `ask_user`, so this line is the ANSWER — send it
    // as an ordinary message BEFORE plan-approval routing, so "go"/"approve" replies to
    // the model's question instead of approving a plan (which would unlock mutations).
    // Do NOT clear awaitingUserAnswer here — `drive` clears it only after the send
    // resolves (from result.awaitingUser); if the send throws, the flag stays set so a
    // retry is still routed as the answer, not a stray plan approval.
    if (route === "answer") {
      await runSend(line);

      return;
    }

    // GENERAL plan mode, approval: bind present_plan proposal (or fenced JSON
    // fallback), unlock tools, implement. Only an explicit approval word counts.
    if (route === "plan-approval") {
      await approveBoundPlan();

      return;
    }

    // GENERAL plan mode, discussion: the agent explores read-only, asks its
    // clarifying questions, and proposes/revises a plan. Stays in plan mode.
    // A FRESH stack-adapter project (Phaser / BoringStack, no approved product
    // plan) must NOT take this path — that is the 94-turn tree-walk. Product
    // planning is the plan; fall through to greenfieldOrSend via onSend=discuss
    // only when no adapter claims the dir (or it is already planned).
    if (route === "plan-discuss") {
      await greenfieldOrSend(
        args.dir,
        STACK_ADAPTERS,
        async (d, s) =>
          session.getPendingPlan() !== null ||
          (await stackHasProductPlan(d, s)),
        (stack) => planProduct(stack, line),
        () => discussInPlanMode(line)
      );

      return;
    }

    // GREENFIELD INTERCEPTION vs NORMAL SEND. A fresh project a stack adapter claims, with
    // no approved plan, routes into planning first (detection AND the planner constraints
    // from the SAME resolved adapter — no gap). Otherwise the AGENT decides: it calls
    // `scaffold_web` itself for a from-scratch web app, and just answers/edits otherwise (so
    // "render a table in the CLI" is no longer mis-scaffolded as a Vite app). The branch
    // itself is greenfieldOrSend (unit-tested); this only supplies the two continuations.
    await greenfieldOrSend(
      args.dir,
      STACK_ADAPTERS,
      async (d, s) =>
        session.getPendingPlan() !== null || (await stackHasProductPlan(d, s)),
      (stack) => planProduct(stack, line),
      () => runSend(line)
    );
  };

  // Placeholder declarations; defined after runLine / editorControl are available.
  let handleHelp: () => Promise<void>;
  let handleSessions: () => Promise<void>;
  let openScaffold: () => Promise<void>;
  // Assigned after the pane console exists (same pattern as handleHelp).
  let handleCopy: () => void = () => undefined;

  const clearConversation = async (opts?: {
    readonly dest?: string;
    readonly silent?: boolean;
  }): Promise<void> => {
    const dirChanged = opts?.dest !== undefined;

    if (opts?.dest !== undefined) {
      args.dir = opts.dest;
      process.chdir(opts.dest);
    }

    // See reboundGateForRebuild's doc comment: a directory change must re-resolve
    // the gate fresh rather than carry the old auto-gate resolver forward.
    const rebound = await reboundGateForRebuild(args, dirChanged, {
      accept: session.gate,
      autoGate,
      autoGateActive: session.autoGateActive,
    });

    // Rebuild the session with the current state (config is not reused;
    // repl's /clear creates a fresh Session.create call)
    spinner.resetClock();
    const profile = resolveCliProfile(args.profile);
    // Carry a still-unvalidated pre-pause edit across the rebuild so /clear does not
    // silently drop the deferred gate: the gate fires on mutation state (`edited`),
    // not merely a dirty tree, so a fresh session would otherwise never re-validate
    // the on-disk edit on a conversational send (WS-C).
    const carryDeferredGate = session.hasDeferredGate;
    const carryPlanId = session.getActivePlanId();
    const carryTouched = session.touchedFiles;

    session = await Session.create({
      provider,
      cwd: args.dir,
      files: session.scope,
      accept: rebound.accept,
      contextWindow,
      report: makeReporter(logFile, id, id),
      enableThinking: false,
      // Keep ask_user (WS-C) offered after /clear when a human is present — but gated
      // on the TTY like the init session, so a piped REPL doesn't advertise a pause
      // nobody can answer.
      // No per-action approval UI exists yet, so `ask` must resolve to DENY with
      // an honest reason — passing `true` here kept the verdict `ask`, which
      // executeTool then rejected anyway but with a message claiming a human was
      // consulted. Flip back to humanAtKeyboard() only when a real prompt lands.
      interactive: false,
      humanPresent: humanAtKeyboard(),
      offerTaskTools: true,
      offerPresentPlan: true,
      // Keep the SCOPED format janitor on across /clear — else the rebuilt session
      // silently reverts to no formatting for the rest of the session.
      coreFormat: true,
      // Keep the AUTO gate re-detecting across /clear — else the rebuild freezes on
      // the last static command and stops picking up new framework packs. Withheld
      // once a manual /gate has taken over (autoGateActive false), so the rebuild
      // never silently re-arms the auto gate over the user's command. A directory
      // change resolves a FRESH resolver instead of carrying the old one forward —
      // see reboundGateForRebuild.
      ...(rebound.autoGate === undefined ? {} : { autoGate: rebound.autoGate }),
      // Same gated-build contract as init — /clear must not drop on-demand `check`.
      ...(rebound.autoGate !== undefined || rebound.accept.length > 0
        ? {
            executionMode: "drive-to-green" as const,
            offerCheck: true as const,
          }
        : {}),
      // Plain boolean (no branch): the constructor only seeds the flag when true.
      pausedWithEdit: carryDeferredGate,
      ...(carryTouched.length > 0 ? { touched: carryTouched } : {}),
      ...(profile === undefined ? {} : { profile }),
      ...(args.strictFloorOnly ? { strictFloorOnly: true as const } : {}),
      ...(carryPlanId !== null ? { activePlanId: carryPlanId } : {}),
      // D2: settings the rebuild silently DROPPED (each reverted to its default
      // for the rest of the session): the explicit --policy-mode, the
      // TSFORGE_COMPACT_AT / TSFORGE_THINKING_BUDGET env knobs (re-read here —
      // the init-time consts live in the boot scope).
      ...clearCarrySettings(args.policyMode),
      ...(await stackSessionExtras(args.dir)),
    });
    wireDelegation(); // re-offer spawn_agent on the rebuilt session
    wireImages(); // re-offer read_image/generate_image + preview on the rebuild
    wirePlanRail();
    // Drop any un-sent clipboard captures — /clear wipes the buffer (and its
    // chips), so their temp files are now orphaned.
    void discardClipboardImages(pendingImages.splice(0));
    session.setPlanMode(planMode); // a /clear must not silently drop the mode
    planDiscussed = false;
    // /clear rebuilds the Session, so the pending ask_user QUESTION is gone — drop the
    // answer-routing flag. (The still-unvalidated EDIT behind that pause is not lost:
    // it's carried into the new session via pausedWithEdit above, so its gate still
    // fires on the first send.)
    awaitingUserAnswer = false;
    await persist();

    if (opts?.silent === true) {
      if (opts.dest !== undefined) {
        echo(`▸ now in ${basename(opts.dest)}\n`);
      }

      return;
    }

    clearScreen(); // wipe the visible terminal + scrollback, not just the state
    echo("conversation cleared\n");
  };

  // Slash-command dispatch. Returns true to EXIT the REPL. Kept as a closure so
  // it can rebuild `session` (e.g. /clear) and reach config/persist.
  const command = async (line: string): Promise<boolean> => {
    const [verb, ...rest] = line.slice(1).split(" ");
    const arg = rest.join(" ").trim();

    switch ((verb ?? "").toLowerCase()) {
      case "exit":
      case "quit":
        return true;
      case "help":
        await handleHelp();
        break;

      case "copy":
        handleCopy();
        break;

      case "clear":
        await clearConversation();
        break;

      case "compact": {
        // Compaction is a full model round-trip (can take many seconds). Drive the
        // SAME live-activity path a turn uses: lastStatus → "● working" on the bar,
        // spinner.start() runs the tick timer whose onTick repaints the bar with the
        // "⠋ compacting · Ns" activity segment (the inline spinner is suppressed in
        // the REPL, so the bar IS the loader). ALWAYS restore + stop, even on a
        // provider error, so the prompt comes back clean and idle.
        lastStatus = "working";
        spinner.start();
        spinner.setLabel("compacting");

        try {
          const result = await session.compact();

          await persist();
          streamOut(`${compactSummaryLine(result)}\n`);
        } finally {
          spinner.stop();
          lastStatus = "ready";
        }

        break;
      }

      case "plan":
        togglePlanMode();
        break;

      case "gate":
        session.setGate(arg);
        process.stdout.write(
          arg.length > 0 ? `gate: ${arg}\n` : "gate cleared\n"
        );
        // Persist immediately so a `/gate` change survives even if the user quits
        // before the next send (persist otherwise only runs after a turn).
        await persist();
        break;

      case "review":
        // Store the report so /reviewfix can act on a manual review too (not just
        // the automatic after-green one). null when clean/errored. `report` +
        // concurrency stream the fan-out into the live agent tree (visible progress).
        try {
          lastReviewReport = await withReviewingStatus(() =>
            runReviewCommand(
              provider,
              args.dir,
              arg,
              echo,
              transcriptCols(),
              reviewProviders,
              report,
              reviewConcurrency()
            )
          );
        } finally {
          resetTree();
        }

        break;

      case "reviewfix": {
        const report = lastReviewReport;

        if (report === null || report.findings.length === 0) {
          echo("no review findings to fix (run a change first, or /review).\n");
          break;
        }

        // Seed the worklist — one task per finding — so the Tasks rail becomes the
        // map the agent works through (focus → fix → complete), instead of a single
        // prose dump. Creates a plan if none is bound, else appends to the current
        // one. The fix turns re-trigger the after-green review on their edits.
        const plan = await seedReviewFixPlan(report);

        if (plan === null) {
          echo("couldn't build the fix task list.\n");
          break;
        }

        echo(
          `${paint(`↳ added ${String(report.findings.length)} finding(s) to the task list`, STYLE.dim, true)} — working them one at a time.\n`
        );
        await drive((opts) => session.send(REVIEWFIX_INSTRUCTION, opts));

        break;
      }

      case "map":
        await runMapCommand(args.dir, arg, echo);
        break;

      case "trace":
        await runTraceCommand(arg, logFile, echo);
        break;

      case "config":
        await handleConfig();
        break;

      case "scaffold":
        await openScaffold();
        break;

      case "setup": {
        const { runSetup } = await import("../setup/run-setup");

        // Same suspend + overlay pattern as `/config`: without it, setup opens a
        // nested alt-screen (fights PaneScreen) and Enter races the editor.
        editorControl?.suspend();
        editorControl?.setInputInert(true);

        try {
          // runSetup prints its own apply/cancel summary — don't add a second,
          // possibly-misleading line (it would claim success even on cancel).
          await runSetup({
            cwd: args.dir,
            yes: false,
            color: process.stdout.isTTY,
            // The REPL editor/readline owns stdin — don't let the wizard pause it
            // on exit (that would quit the whole process).
            manageInput: false,
            out: (s) => {
              streamOut(s);
            },
            view: {
              render: (lines) => {
                chrome.setOverlay(lines);
              },
              close: () => {
                chrome.clearOverlay();
              },
            },
            columns: transcriptCols(),
            viewportRows: overlayBudget(),
          });
        } finally {
          editorControl?.setInputInert(false);
          editorControl?.resume();
          editorControl?.getBuffer().setText("");
        }

        break;
      }

      case "files": {
        const globs = arg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        session.setScope(globs.length > 0 ? globs : WHOLE_REPO);
        streamOut(`scope: ${scopeLabel(session.scope)}\n`);
        await persist();
        break;
      }

      case "model": {
        const result = await runModelCommand({
          arg,
          provider,
          activeName,
          fallbackEntry: activeModelEntry,
          contextWindow,
        });

        activeName = result.activeName;
        contextWindow = result.contextWindow;
        // Keep auto-compaction in sync with the new model's window — not just the
        // status bar. Otherwise a swap to a smaller model compacts too late.
        session.setContextWindow(contextWindow);
        break;
      }

      case "sessions":
        await handleSessions();
        break;

      case "memory":
        await runMemorySlashCommand(args.dir, session, arg, streamOut);
        break;

      case "remember":
        await runRememberSlashCommand(session, arg, streamOut);
        break;

      case "cost": {
        const chars = session.messages.reduce(
          (sum, m) => sum + m.content.length,
          0
        );

        streamOut(
          `  ${String(session.messages.length)} messages · ~${String(Math.round(chars / 4))} tokens (rough)\n`
        );
        break;
      }

      case "metrics": {
        const m = session.metrics;

        if (m.calls === 0) {
          streamOut("  no model calls yet\n");
        } else {
          streamOut(
            `  ${String(m.calls)} call(s) · ${String(m.promptTokens)} in / ${String(m.completionTokens)} out · ` +
              `${String(m.lastTokensPerSecond)} tok/s last · ${String(m.avgTokensPerSecond)} tok/s avg\n`
          );
        }

        streamOut(turnsToGreenLine(lastTurnsToGreen));

        break;
      }

      default:
        streamOut(`unknown command: ${line} (try /help)\n`);
    }

    return false;
  };

  // Current state as the status surface sees it — pane footer and plain prompt.
  const statusInfo = (): IStatusInfo => {
    const chrome = resolveChromeStatus({
      busy: paneScreen.isBusy,
      lastStatus,
      activity: spinner.frameLabel(),
    });

    return {
      model: modelInfo(provider.config).model,
      contextTokens: session.contextTokens,
      contextWindow,
      turns: lastTurns,
      elapsedMs: lastElapsedMs,
      status: chrome.status,
      scope: scopeLabel(session.scope),
      mode: modeById(currentModeId).label,
      tokensPerSecond: session.metrics.lastTokensPerSecond,
      ...(chrome.activity !== undefined ? { activity: chrome.activity } : {}),
    };
  };

  // Pane console — the only interactive UI on a TTY.
  const paneScreen = new PaneScreen(process.stdout);
  const tuiKeybindings = resolveTuiKeybindings(
    parseProjectTuiKeybindings(delegationConfig),
    loadUserTuiKeybindings()
  );

  paneScreen.setKeybindings(tuiKeybindings);
  let exitCode = 0;

  /** Main-pane content width (or full tty when panes are not live). Menus,
   *  bubbles, and hairlines must use this — full stdout.columns punches through
   *  the side panel. */
  const transcriptCols = (): number => {
    if (paneScreen.active) {
      return Math.max(20, paneScreen.mainInnerCols());
    }

    const cols = process.stdout.columns;

    return cols > 0 ? cols : 80;
  };

  /** Max overlay rows — pane chrome budget when live, else tty rows. */
  const overlayBudget = (): number => {
    if (paneScreen.active) {
      return paneScreen.overlayBudgetRows();
    }

    const rows = process.stdout.rows;

    return rows > 0 ? rows : 24;
  };

  /** True while the alt-screen pane console owns the terminal. */
  const panesLive = (): boolean => paneScreen.active;

  // Overlays / agent tree / editor → PaneScreen only.
  const chrome: ILiveChrome = {
    hasChrome: () => panesLive(),
    setOverlay(lines) {
      if (panesLive()) {
        paneScreen.setOverlay(lines);
      }
    },
    clearOverlay() {
      if (panesLive()) {
        paneScreen.clearOverlay();
      }
    },
    setEditorOverlay(lines) {
      if (panesLive()) {
        paneScreen.setOverlay(lines);
      }
    },
    clearEditorOverlay() {
      if (panesLive()) {
        paneScreen.clearOverlay();
      }
    },
    setAgentTree(lines) {
      if (panesLive()) {
        paneScreen.setAgentTree(lines);
      }
    },
    clearAgentTree() {
      if (panesLive()) {
        paneScreen.clearAgentTree();
      }
    },
    setInput(line, cursor) {
      if (panesLive()) {
        paneScreen.setInput({
          lines: [line],
          cursorRow: 0,
          cursorCol: cursor,
        });
      }
    },
    setEditor(lines, cursorRow, cursorCol) {
      if (panesLive()) {
        paneScreen.setInput({ lines, cursorRow, cursorCol });
      }
    },
  };

  liveChrome = chrome;

  const syncPaneChrome = (): void => {
    if (!panesLive()) {
      return;
    }

    paneScreen.setStatus(statusInfo());
  };

  /** Keep pane footer metrics in sync. */
  const refreshStatus = (): void => {
    syncPaneChrome();
  };

  /** Dump transcript to the primary buffer for copy, then re-enter panes. */
  const dumpPanesTranscript = (): void => {
    if (!panesLive()) {
      return;
    }

    const transcript = paneScreen.dumpTranscript();

    paneScreen.leave();
    process.stdout.write(
      (transcript.length > 0 ? `${transcript}\n` : "") +
        "(transcript dumped above for copy)\n"
    );

    if (paneScreen.enter()) {
      syncPaneChrome();
    }
  };

  handleCopy = (): void => {
    if (panesLive()) {
      dumpPanesTranscript();
    } else {
      process.stdout.write("(nothing to dump — pane TUI is not active)\n");
    }
  };

  /** Paint the Tasks rail from the session-bound plan (or empty-rail hints). */
  let railPlan: IPlanDocument | null = null;
  let gateView: IGateRailView = session.gateRailView();
  let worklistSpin = 0;
  let keymapOpen = false;

  const railHasItems = (): boolean => {
    if (paneScreen.focusState.railSurface === "gate") {
      // Gate surface always keeps the rail open — formatGateLines renders the
      // empty / not-configured states; gating on gateConfigured hid the rail the
      // moment the user cycled to Gate.
      return true;
    }

    return railPlan !== null && railPlan.items.length > 0;
  };

  const syncRailPanel = (opts?: {
    readonly soft?: boolean;
    readonly plan?: IPlanDocument | null;
  }): void => {
    if (opts?.plan !== undefined) {
      railPlan = opts.plan;
    }

    if (!panesLive()) {
      return;
    }

    const cols = paneScreen.panelInnerCols();
    const surface = paneScreen.focusState.railSurface;

    paneScreen.focusState.syncHasItems(railHasItems());

    if (cols <= 0) {
      if (opts?.soft !== true) {
        if (surface === "gate") {
          paneScreen.setGateBadge(gateRailBadge(gateView));
        } else {
          paneScreen.setWorklistBadge(worklistBadge(railPlan));
        }
      }

      return;
    }

    const maxRows = Math.max(4, paneScreen.panelListBudgetRows());
    const spinning = spinner.frameLabel().length > 0;
    const focused = paneScreen.focusState.panelFocused;
    const selection = paneScreen.focusState.selection;

    if (surface === "gate") {
      const sortedLen = gateView.errors.length;
      const shown = Math.min(sortedLen, maxRows);

      paneScreen.setGateSelectableRows(shown);

      paneScreen.setPanel(
        formatGateLines(gateView, {
          columns: cols,
          maxRows,
          color: true,
          cwd: args.dir,
          ...(focused ? { showSelection: true, selectedIndex: selection } : {}),
        }),
        { soft: opts?.soft === true }
      );

      if (opts?.soft !== true) {
        paneScreen.setGateBadge(gateRailBadge(gateView));
        syncPaneChrome();
      }

      return;
    }

    paneScreen.setPanel(
      formatWorklistLines(railPlan, {
        columns: cols,
        maxPending: maxRows,
        color: true,
        ...(spinning ? { currentFrame: worklistSpin } : {}),
      }),
      { soft: opts?.soft === true }
    );

    if (opts?.soft === true) {
      return;
    }

    paneScreen.setWorklistBadge(worklistBadge(railPlan));
    syncPaneChrome();
  };

  const syncWorklistPanel = (
    plan: IPlanDocument | null,
    opts?: { readonly soft?: boolean }
  ): void => {
    syncRailPanel({ ...opts, plan });
  };

  let handleGateEnter: (() => boolean) | null = null;

  paneScreen.onGateEnter = (): boolean => handleGateEnter?.() ?? false;

  const wirePlanRail = (): void => {
    session.setOnPlanChanged((plan) => {
      syncRailPanel({ plan });
    });
    session.setOnGateChanged((view) => {
      gateView = view;
      syncRailPanel();
    });
    session.setOnPlanPresented((plan) => {
      planDiscussed = true;
      const cols = panesLive()
        ? paneScreen.mainInnerCols()
        : process.stdout.columns > 0
          ? process.stdout.columns
          : 80;

      echo(`\n${formatPlanProposal(plan, cols, true)}\n`);

      // Preview in Tasks rail before approve (pending badge).
      if (panesLive()) {
        paneScreen.setPanel(
          formatWorklistLines(plan, {
            columns: Math.max(12, paneScreen.panelInnerCols()),
            maxPending: Math.max(4, paneScreen.panelListBudgetRows()),
            color: true,
          })
        );
        paneScreen.setWorklistBadge(pendingPlanBadge(plan));
        syncPaneChrome();
      }
    });
  };

  wirePlanRail();
  gateView = session.gateRailView();
  syncRailPanel();

  /** Stream conversation text: main pane when live, else plain stdout (pipes). */
  const streamOut = (text: string): void => {
    const linked = linkifyTranscriptLine(text, args.dir);

    if (panesLive()) {
      paneScreen.appendMain(linked);
    } else {
      process.stdout.write(linked);
    }
  };

  /** Raw terminal modes (bracketed paste, kitty keys) — never transcript. */
  const writeTerm = (text: string): void => {
    process.stdout.write(text);
  };

  // --- live agent tree ------------------------------------------------------
  // When the orchestrator delegates (`spawn_agent`), its subagents render as a
  // live tree pinned above the input row, with the focused agent's streaming
  // output beneath it — so a run is never a black box. Each subagent's output is
  // diverted to a per-agent buffer (via the OutputRouter) instead of interleaving
  // into the transcript; only the orchestrator writes the transcript.
  let agentTree = new AgentTreeModel();
  const agentOutput = new Map<string, string[]>();
  // Every agentId we installed an OutputRouter sink for — tracked separately from
  // agentOutput because a subagent that produces no routed output never gets an
  // agentOutput entry, yet its sink still needs clearing (else it leaks + keeps
  // diverting that id's future chunks away from the transcript).
  const agentSinkIds = new Set<string>();
  let treeFrame = 0;
  let treeActive = false;
  // The detail pane auto-follows the newest running agent; ↑/↓ overrides it.
  let focusedAgentId: string | null = null;
  let userPickedFocus = false;
  const AGENT_DETAIL_LINES = 8;
  // Strip SGR color codes from captured subagent output. Built via fromCharCode
  // so the literal carries no control byte (no-control-regex).
  const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

  const treeCols = (): number =>
    process.stdout.columns > 0 ? process.stdout.columns : 80;

  const detailPane = (rows: readonly IAgentRow[]): string[] => {
    const id = focusedAgentId ?? rows.at(-1)?.id;

    if (id === undefined) {
      return [];
    }

    const label = rows.find((r) => r.id === id)?.label ?? id;
    const width = Math.max(10, treeCols() - 5);
    // Show the last N non-blank lines (the reassembled stream may end on an empty
    // in-progress line; blanks would waste rows in the small pane).
    const lines = (agentOutput.get(id) ?? [])
      .map((l) => l.replace(/\s+$/u, ""))
      .filter((l) => l.length > 0);
    const body =
      lines.length === 0
        ? [paint("    drafting…", STYLE.dim, true)]
        : lines
            .slice(-AGENT_DETAIL_LINES)
            .map((l) => `    ${l.slice(0, width)}`);
    // One child: the row already names it. Don't repeat `↳ product planner`.
    const header =
      rows.length <= 1 ? [] : [paint(`  ↳ ${label}`, STYLE.dim, true)];

    return [...header, ...body];
  };

  const repaintTree = (): void => {
    if (!chrome.hasChrome()) {
      return;
    }

    const rows = agentTree.rows();

    if (rows.length === 0) {
      chrome.setAgentTree([]);

      return;
    }

    const viewportRows = process.stdout.rows > 0 ? process.stdout.rows : 24;
    const tree = renderAgentTree(rows, {
      columns: treeCols(),
      frame: treeFrame,
      maxRows: Math.max(3, viewportRows - AGENT_DETAIL_LINES - 4),
      ...(focusedAgentId === null ? {} : { selectedId: focusedAgentId }),
    });

    chrome.setAgentTree([...tree, ...detailPane(rows)]);
  };

  const pushAgentOutput = (agentId: string, text: string): void => {
    const buf = agentOutput.get(agentId) ?? [""];
    // Streaming chunks are small and often newline-free (mid-word), so we can't
    // treat each chunk as a whole line. The LAST buffered entry is the line still
    // in progress: the chunk's first segment continues it, and each embedded
    // newline starts a new line. This reassembles fragments into coherent lines.
    const segments = text.replace(SGR_RE, "").split(/\r?\n/u);

    buf[buf.length - 1] = `${buf[buf.length - 1] ?? ""}${segments[0] ?? ""}`;

    for (let k = 1; k < segments.length; k += 1) {
      buf.push(segments[k] ?? "");
    }

    // Amortized trim: slicing to 200 on EVERY chunk allocated a fresh array
    // per token; trim only when the buffer doubles.
    agentOutput.set(agentId, buf.length > 400 ? buf.slice(-200) : buf);

    // No repaint here: a full-screen tree repaint per streamed subagent token
    // was the delegation repaint storm (2201 full paints / 2000 tokens in the
    // bench). The 120ms spinner tick repaints the live tree, and agent_result /
    // focus changes repaint immediately, so the final state is never stale.
  };

  const feedTree = (event: ILoopEvent): void => {
    const id = event.agentId;

    if (id !== undefined && event.kind === "agent_spawned") {
      // Only DIVERT a subagent's output to the (invisible) detail buffer when the
      // pane console can render the tree. Otherwise leave the sink unset so
      // output routes to the parent/stdout and stays visible.
      if (panesLive()) {
        outputRouter.setAgentSink(id, (t) => {
          pushAgentOutput(id, t);
        });
        agentSinkIds.add(id);
      }

      treeActive = true;
    }

    if (
      id !== undefined &&
      event.kind === "agent_started" &&
      !userPickedFocus
    ) {
      focusedAgentId = id; // auto-follow the newest running agent
    }

    if (
      event.kind === "agent_spawned" ||
      event.kind === "agent_started" ||
      event.kind === "agent_result"
    ) {
      agentTree.applyEvent(event);
      repaintTree();
    }
  };

  // Move the detail-pane focus between rows (↑/↓ while agents run).
  const moveTreeFocus = (delta: number): void => {
    const rows = agentTree.rows();

    if (rows.length === 0) {
      return;
    }

    // Start from the CURRENTLY-shown row: when nothing is explicitly picked yet
    // the pane auto-follows the last row, so resolve that same id first — else the
    // first ↑/↓ would jump to row 0 instead of stepping from what's on screen.
    const activeId = focusedAgentId ?? rows.at(-1)?.id;
    const current = rows.findIndex((r) => r.id === activeId);
    const base = current < 0 ? rows.length - 1 : current;
    const next = Math.min(rows.length - 1, Math.max(0, base + delta));

    focusedAgentId = rows[next]?.id ?? null;
    userPickedFocus = true;
    repaintTree();
  };

  // Fresh tree next turn; drop the per-agent sinks so output routes normally.
  const resetTree = (): void => {
    if (!treeActive) {
      return;
    }

    // Clear EVERY sink we installed (not just ids with buffered output — an agent
    // that streamed nothing still has a live sink that would otherwise leak).
    for (const id of agentSinkIds) {
      outputRouter.clearAgentSink(id);
    }

    agentSinkIds.clear();
    agentOutput.clear();
    agentTree = new AgentTreeModel();
    focusedAgentId = null;
    userPickedFocus = false;
    treeActive = false;
    chrome.clearAgentTree();
  };

  observeEvents(feedTree);

  plannerLive.start = (): void => {
    spinner.start();
  };

  plannerLive.stop = (): void => {
    spinner.stop();
    resetTree();
  };

  plannerLive.note = (text: string): void => {
    pushAgentOutput(PLANNER_AGENT_ID, text);
  };

  // Switch the interactive mode (via the extensible registry) and reflect it in
  // the pane footer. The single entry point for /plan, Shift+Tab, and startup —
  // so `planMode`, `currentModeId`, and the chrome never drift apart.
  const setMode = (id: string): void => {
    const mode = modeById(id);

    mode.apply(session);
    currentModeId = mode.id;
    planMode = mode.id === "plan";
    planDiscussed = false;

    refreshStatus();
  };

  // `/plan` toggles between plan and normal. Extracted so the slash-command
  // dispatcher stays under the cognitive-complexity cap.
  const togglePlanMode = (): void => {
    const turningOn = !planMode;

    setMode(turningOn ? "plan" : "normal");
    process.stdout.write(
      turningOn
        ? "plan mode ON — read-only: the agent explores, asks, and proposes " +
            "a plan; type 'approve' to implement\n"
        : "plan mode OFF\n"
    );
  };

  // `/config` — the in-harness settings hub. Runs as one owned-stdin menu loop;
  // extracted from the dispatcher to keep it under the complexity cap.
  const setEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  };

  const handleConfig = async (): Promise<void> => {
    editorControl?.suspend();
    editorControl?.setInputInert(true);

    try {
      await runConfigMenu({
        color: process.stdout.isTTY,
        suspend: () => {
          editorControl?.suspend();
          editorControl?.setInputInert(true);
        },
        resume: () => {
          editorControl?.setInputInert(false);
          editorControl?.resume();
          editorControl?.getBuffer().setText("");
        },
        reconfigure: (entry) => {
          provider.reconfigure(providerConfig(entry));
        },
        currentModelName: () => activeName,
        onModelChange: (name) => {
          activeName = name;
        },
        currentMode: () => modeById(currentModeId).label,
        setMode,
        getGate: () => gateLabel,
        setGate: (cmd) => {
          const trimmed = cmd.trim();

          session.setGate(trimmed);
          gateLabel = trimmed.length === 0 ? "none" : trimmed;
        },
        getScope: () => scopeLabel(session.scope),
        setScope: (globs) => {
          const parts = globs
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          session.setScope(parts.length > 0 ? parts : WHOLE_REPO);
        },
        getEnv: (name) => process.env[name],
        setEnv,
        view: {
          render: (lines) => {
            chrome.setOverlay(lines);
          },
          close: () => {
            chrome.clearOverlay();
          },
        },
        columns: transcriptCols(),
        viewportRows: overlayBudget(),
      });
    } finally {
      editorControl?.setInputInert(false);
      editorControl?.resume();
      editorControl?.getBuffer().setText("");
    }

    refreshStatus();

    await persist();
  };

  // Set once the multi-line editor is created (it lives in a nested scope); the
  // resize handler below calls it so the editor re-wraps/re-windows at the new
  // size instead of clipping the current line at its pre-resize dimensions.
  let resizeEditor: ((columns: number, rows: number) => void) | null = null;
  // The live editor handle, exposed to repl-scope closures (e.g. the `/config`
  // command) so they can suspend/resume its stdin ownership around an overlay
  // wizard — the editor itself is created inside the loop's nested scope.
  let editorControl: IEditorHandle | null = null;

  // Each agent turn: `┌AGENT┐` badge + hairline + dim model subheader, then every
  // body line on the thin `│ ` rail (wrapping inside it). No bottom cap — spacing
  // is a trailing blank. The cap is emitted once, on the turn's first streamed
  // output. Content budget leaves the rail (2) + 2 spare columns so the terminal
  // never hard-wraps a row and drops the rail.
  // Prefer forge> width for the pane console (editor is built before enter(),
  // so panesLive() is still false at construction time).
  const promptGutterCols = (): number => FORGE_EDITOR_GUTTER;

  /** Draft wrap width — pane input matches the agent card, not full tty. */
  const editorColumns = (ttyCols: number): number => {
    if (panesLive()) {
      return Math.max(1, inputContentCols(paneScreen.mainInnerCols()));
    }

    return Math.max(1, ttyCols - promptGutterCols());
  };

  /** Content budget inside `│  …  │` (left gutter 3 + right rail 1). */
  const railInnerWidth = (): number => agentRailInnerCols(transcriptCols());
  let agentTurnOpen = false;
  let agentRail = makeAgentRail(
    agentBar(true),
    railInnerWidth,
    agentRight(true)
  );

  // Route streamed agent output through the bar so it scrolls above the pinned
  // input row; cleared on loop exit so later/headless writes go straight to stdout.
  if (useInputRow) {
    outputRouter.setParentSink((text): void => {
      if (!agentTurnOpen) {
        agentTurnOpen = true;
        agentRail = makeAgentRail(
          agentBar(true),
          railInnerWidth,
          agentRight(true)
        );
        const cols = transcriptCols();

        streamOut(
          `\n${agentCardTop(true, cols)}\n${agentCardPadRow(true, cols)}\n`
        );
      }

      streamOut(agentRail.feed(text));
    });
  }

  // Start a fresh agent card for each turn (the cap re-emits on its first output).
  const beginAgentTurn = (): void => {
    agentTurnOpen = false;
  };

  // Close the current agent card (trailing blank) once its turn is done. A
  // no-op for turns that produced no streamed output (e.g. slash commands).
  const closeAgentTurn = (): void => {
    if (agentTurnOpen && useInputRow) {
      const held = agentRail.flush();

      if (held.length > 0) {
        streamOut(held);
      }

      const cols = transcriptCols();

      streamOut(
        `${agentCardPadRow(true, cols)}\n${agentCardBottom(true, cols)}\n`
      );
      agentTurnOpen = false;
    }
  };

  // Mirror readline's buffer onto the input row after each keypress. setImmediate
  // lets readline update rl.line/rl.cursor first (it processes the key async).
  const syncInput = (): void => {
    if (useInputRow && rl !== null) {
      setImmediate(() => {
        chrome.setInput(rl.line, rl.cursor);
      });
    }
  };

  // Echo a CLI-side line into pane scrollback when live; plain write otherwise.
  const echo = (text: string): void => {
    if (panesLive() || useInputRow) {
      streamOut(text);
    } else {
      process.stdout.write(text);
    }
  };

  // In the interactive REPL a readline/editor owns stdin for the WHOLE session, so
  // the spinner's carriage-return inline write would clobber input mid-turn.
  // Suppress it; activity shows via pane statusInfo instead.
  spinner.setInlineGate(() => false);

  // Debounce SIGWINCH: suppress repaints mid-drag, then resize panes once settled.
  const RESIZE_SETTLE_MS = 120;
  let resizing = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // While a turn is busy, keep status chrome ticking even if streams are silent
  // (gate eslint JSON filtered, quiet model waits, etc.).
  paneScreen.onBusyTick = (): void => {
    if (resizing) {
      return;
    }

    syncPaneChrome();
  };

  // Ctrl+G changes main width — keep the prompt editor + rail in sync.
  paneScreen.onLayoutChange = (): void => {
    if (panesLive()) {
      resizeEditor?.(paneScreen.mainInnerCols(), process.stdout.rows);
      syncRailPanel();
    }
  };

  paneScreen.onRailRefresh = (): void => {
    syncRailPanel();
  };

  // Pane footer + agent tree on every spinner tick — not during a resize storm.
  spinner.onTick(() => {
    if (resizing) {
      return;
    }

    syncPaneChrome();

    // Spin the focused Tasks-rail mark in step with the status spinner.
    if (panesLive() && railPlan !== null) {
      worklistSpin = (worklistSpin + 1) % 10;
      syncRailPanel({ soft: true });
    }

    // Advance the tree's spinner so running agent rows animate in step.
    if (treeActive) {
      treeFrame += 1;
      repaintTree();
    }
  });

  // Named so it can be detached on loop exit (an anonymous listener on the
  // global process.stdout would pin the whole REPL closure for the process
  // lifetime). columns/rows are typed `number` here, so no nullish guard is
  // needed; the editor's resize ignores non-positive values regardless.
  const handleResize = (): void => {
    resizing = true;

    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
      resizing = false;
      resizeTimer = null;
      // Geometry first (no paint), then one chrome sync — avoids resize+status
      // double frames on every SIGWINCH settle.
      paneScreen.resize(process.stdout.rows, process.stdout.columns, {
        paint: false,
      });
      syncPaneChrome();
      // Rewrap Tasks rail after geometry changes — plan updates while the rail
      // was auto-collapsed (cols=0) never refreshed the panel body.
      syncWorklistPanel(railPlan);
      // The editor wraps/windows at the dimensions it was created with; without
      // this it keeps using the pre-resize size and can clip the current line.
      resizeEditor?.(process.stdout.columns, process.stdout.rows);
    }, RESIZE_SETTLE_MS);
  };

  process.stdout.on("resize", handleResize);

  // Editor handle lives inside the prompt loop below; this ref lets the process
  // exit hook tear down Kitty/modifyOtherKeys even on an unexpected exit.
  // Without that cleanup the shell sees Ctrl+C as literal `;5;99~` junk.
  let editorForExit: { close: () => void } | null = null;

  // Restore the terminal on normal exit AND on the signals that would otherwise
  // terminate the process without firing 'exit' (SIGTERM/SIGHUP). See
  // installTerminalRestore.
  installTerminalRestore(paneScreen, () => editorForExit);

  // Wipe the visible terminal. Pane console: clear scrollback + repaint. Pipes:
  // plain CSI wipe.
  const clearScreen = (): void => {
    if (panesLive()) {
      paneScreen.clear();
      syncPaneChrome();

      return;
    }

    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  };

  // The prompt. Pane console owns the bottom strip — refresh metrics only.
  // Pipes / non-TTY: inline status + `›`.
  const prompt = (): void => {
    if (panesLive()) {
      syncPaneChrome();

      if (rl !== null) {
        paneScreen.setInput({
          lines: [rl.line],
          cursorRow: 0,
          cursorCol: rl.cursor,
        });
      } else {
        // Editor mode: status may be unchanged (no dirty paint) — still park the caret.
        paneScreen.rehomeCursor();
      }

      return;
    }

    process.stdout.write("\n");
    process.stdout.write(renderStatus(statusInfo()));
    process.stdout.write("› ");
  };

  await new Promise<void>((resolveLoop) => {
    let editorHandle: IEditorHandle | null = null;
    let busy = false;
    let closed = false;
    let paletteOpen = false;

    // Finish the loop only when stdin has closed AND no run is in flight — so a
    // stdin EOF (piped input / Ctrl-D) never kills a build mid-turn.
    const maybeFinish = (): void => {
      if (closed && !busy) {
        resolveLoop();
      }
    };

    // Submit a line of input: check if busy/pending, echo it, handle /exit, or run it.
    const submitLine = (raw: string): void => {
      const line = raw.trim();

      if (!shouldDispatchReplLine(raw)) {
        if (!busy) {
          prompt();
        }

        return;
      }

      // readline's output is sinked in input-row mode, so the submitted line is
      // never echoed to scrollback — record it ourselves so the transcript reads
      // naturally above the (now-cleared) input row.
      if (useInputRow) {
        echo(`\n${userBubble(line, true, transcriptCols())}\n`);
      }

      if (busy) {
        if (line === "/exit" || line === "/quit") {
          active?.abort();

          if (rl !== null) {
            rl.close();
          }

          if (editorHandle !== null) {
            editorHandle.close();
          }
        } else if (wantsPlanApproval(line, approvalRouteState())) {
          // Bind the plan — do not steer "approve" into the model (that keeps
          // plan mode locked and never offers task_* tools).
          pendingPlanApprove = true;
          active?.abort();
          echo("  ↳ approving plan — stopping this turn\n");
        } else {
          pending.push(line);
          echo("  ↳ queued (steers the next turn)\n");
        }

        return;
      }

      void runLine(line);
    };

    // Handle one idle line (slash command or a message), then any queued follow-up.
    const runLine = async (line: string): Promise<void> => {
      busy = true;
      // So Ctrl+C / /exit abort product planning (not just Session.send). Without
      // this, planning has busy=true and active=null: interrupt thinks we're idle,
      // closes the editor, and the process dies with mouse tracking still on.
      active = new AbortController();

      // Slash commands (help/config overlays) must not start the turn spinner —
      // busy ticks fight the overlay and drop Enter. Real sends still show working.
      if (!line.startsWith("/")) {
        lastStatus = "working";
        spinner.start();
      }

      if (keymapOpen) {
        keymapOpen = false;
        chrome.clearOverlay();
      }

      paneScreen.setBusy(true);
      beginAgentTurn(); // the agent's response opens a fresh closed AGENT card

      try {
        if (line.startsWith("/")) {
          if (await command(line)) {
            closed = true;

            if (rl !== null) {
              rl.close();
            }

            editorHandle?.close();
          }
        } else {
          await dispatch(line);
        }
      } catch (err) {
        // A command/turn that throws (e.g. a provider error mid-/compact) must NOT
        // escape: runLine is invoked fire-and-forget (`void runLine(...)`), so an
        // unhandled rejection would terminate the whole REPL — which read as "the
        // CLI just exits". Surface the error and fall through to re-prompt instead.
        spinner.stop(); // belt-and-suspenders: clear any spinner the failed path left running
        echo(`\n⚠ ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        closeAgentTurn(); // seal the agent card's bottom cap before re-prompting
        spinner.stop();

        if (lastStatus === "working") {
          lastStatus = "ready";
        }

        busy = false;
        paneScreen.setBusy(false);
        active = null;
      }

      // Mid-run approve aborted the discuss turn — bind + implement before any
      // other queued steer line.
      if (pendingPlanApprove) {
        pendingPlanApprove = false;
        void runLine("approve");

        return;
      }

      // A line typed in the gap after the last steer-drain becomes the next turn.
      const next = pending.shift();

      if (next !== undefined) {
        void runLine(next);

        return;
      }

      if (closed) {
        maybeFinish();
      } else {
        prompt();
      }
    };

    // `/help` — the capability browser. On a TTY, opens an inline dropdown menu;
    // off-TTY, prints the static help text so pipes/logs are unchanged. Extracted
    // to keep cognitive complexity in check.
    const buildHelpDeps = async (): Promise<
      Parameters<typeof runCapabilityMenu>[0]
    > => {
      const suspend = (): void => {
        editorControl?.suspend();
        editorControl?.setInputInert(true);
      };

      const resume = (): void => {
        editorControl?.setInputInert(false);
        editorControl?.resume();
        editorControl?.getBuffer().setText("");
      };

      const hasRecipes = (await loadRecipes(args.dir)).length > 0;

      return {
        color: process.stdout.isTTY,
        hasRecipes,
        runCommand: (c) => {
          // c already includes the leading slash (registry stores "/sessions").
          void runLine(c);
        },
        prefill: (c) => {
          editorControl?.getBuffer().setText(`${c} `);
        },
        openWizard: async (opener) =>
          opener === "scaffold"
            ? openScaffoldInRepl({
                cwd: args.dir,
                suspend,
                resume,
                out: (s) => process.stdout.write(s),
                columns: transcriptCols(),
                viewportRows: overlayBudget(),
              }).then(async (dest) => {
                if (dest !== null) {
                  await clearConversation({ dest, silent: true });
                }
              })
            : openRecipePicker({
                cwd: args.dir,
                render: (lines) => {
                  chrome.setOverlay(lines);
                },
                close: () => {
                  chrome.clearOverlay();
                },
                columns: transcriptCols(),
                viewportRows: overlayBudget(),
                out: (s) => process.stdout.write(s),
                runRecipe: (recipe) => {
                  if (recipe.gate !== undefined) {
                    session.setGate(recipe.gate);
                    gateLabel = recipe.gate;
                  }

                  if (recipe.files !== undefined) {
                    session.setScope([...recipe.files]);
                  }

                  if (recipe.task !== undefined) {
                    void runLine(recipe.task);
                  }
                },
              }),
        render: (lines) => {
          chrome.setOverlay(lines);
        },
        close: () => {
          chrome.clearOverlay();
        },
        columns: transcriptCols(),
        viewportRows: overlayBudget(),
      };
    };

    handleHelp = async (): Promise<void> => {
      if (!process.stdout.isTTY) {
        process.stdout.write(`${HELP}\n`);

        return;
      }

      editorControl?.suspend();
      editorControl?.setInputInert(true);

      try {
        const deps = await buildHelpDeps();

        await runCapabilityMenu(deps);
      } finally {
        editorControl?.setInputInert(false);
        editorControl?.resume();
        editorControl?.getBuffer().setText("");
      }

      refreshStatus();
    };

    handleSessions = async (): Promise<void> => {
      editorControl?.suspend();
      editorControl?.setInputInert(true);

      try {
        await openSessionsMenu({
          cwd: args.dir,
          out: streamOut,
          render: (lines) => {
            chrome.setOverlay(lines);
          },
          close: () => {
            chrome.clearOverlay();
          },
          columns: transcriptCols(),
          viewportRows: overlayBudget(),
        });
      } finally {
        editorControl?.setInputInert(false);
        editorControl?.resume();
        editorControl?.getBuffer().setText("");
      }

      refreshStatus();
    };

    // Open the in-REPL scaffold wizard (create a new project here), reachable as a
    // first-class typed/palette command so it's discoverable at the prompt. This
    // path AWAITS openScaffoldInRepl, so the wizard's suspend/resume owns the screen
    // for its whole lifetime. (The `/help` capability browser reaches scaffold
    // through its dedicated wizard row instead — never a fire-and-forget
    // `void runLine` command row, which would race the wizard for stdin.) Extracted
    // from the command switch to keep that dispatcher's cognitive complexity down.
    openScaffold = async (): Promise<void> => {
      const dest = await openScaffoldInRepl({
        cwd: args.dir,
        suspend: () => {
          editorControl?.suspend();
          editorControl?.setInputInert(true);
        },
        resume: () => {
          editorControl?.setInputInert(false);
          editorControl?.resume();
          editorControl?.getBuffer().setText("");
        },
        out: (s) => {
          streamOut(s);
        },
        view: {
          render: (lines) => {
            chrome.setOverlay(lines);
          },
          close: () => {
            chrome.clearOverlay();
          },
        },
        columns: transcriptCols(),
        viewportRows: overlayBudget(),
      });

      if (dest !== null) {
        await clearConversation({ dest, silent: true });
      }
    };

    // Helper: repaint the editor buffer to the pane input after palette insertion.
    const repaintEditor = (handle: IEditorHandle): void => {
      const { line, col } = handle.getBuffer().getCursor();
      const lines = handle.getBuffer().getText().split("\n");

      const frame = renderEditor(
        {
          lines,
          cursorLine: line,
          cursorCol: col,
        },
        {
          columns: process.stdout.columns,
          // Mirror the editor controller's own repaint window (rows minus the bar
          // block) so wrapping/windowing matches.
          maxRows: Math.max(1, process.stdout.rows - 3),
          color: true,
        }
      );

      // Repaint the editor block IN the pinned live region (setEditor), NOT via
      // writeStream — writeStream treats its argument as conversation content, so
      // it would strand the editor frame in scrollback (a leftover "/" per palette
      // open). This mirrors the editor's renderEditor→setEditor callback.
      chrome.setEditor(
        frame.frame.split("\n"),
        frame.cursorRow,
        frame.cursorCol
      );
    };

    // Open the interactive `/` command palette: pick a command from a navigable
    // list, then either run it (no-arg) or prefill the line so the user types the
    // argument. Cancel ⇒ back to a clean prompt. Only meaningful on a TTY.
    const openPalette = async (): Promise<void> => {
      paletteOpen = true;
      // Suspend the editor's stdin ownership so the palette's keypress loop owns
      // input (see openFilePicker). Resumed in finally.
      editorHandle?.suspend();

      // Inline palette: paint the command list as an overlay above the input row
      // (no alt-screen), same mechanism as the `@` picker and /help. The live
      // query rides in the overlay title.
      const view: IPaletteView = {
        render: (lines) => {
          chrome.setOverlay(lines);
        },
        close: () => {
          chrome.clearOverlay();
        },
        columns: transcriptCols(),
        viewportRows: overlayBudget(),
      };

      try {
        const picked = await pickCommand(view);

        if (picked !== null) {
          if (editorHandle !== null) {
            editorHandle.getBuffer().setText("");

            if (takesArg(picked)) {
              // Prefill "<cmd> " so the user types the argument next.
              editorHandle.getBuffer().insert(`${picked.name} `);
              repaintEditor(editorHandle);
            } else {
              // No-arg command: run it and leave the input EMPTY. Inserting the
              // name would linger in the buffer and reappear on the next keystroke
              // (the "/clear" ghost after the screen is cleared).
              repaintEditor(editorHandle);
              void runLine(picked.name);
            }
          } else if (rl !== null) {
            rl.write(null, { ctrl: true, name: "u" }); // clear the typed "/"

            if (takesArg(picked)) {
              rl.write(`${picked.name} `);
            } else {
              void runLine(picked.name);
            }
          }
        } else if (editorHandle !== null) {
          // Cancel (Esc / backspace-past-empty): drop the lingering trigger "/"
          // so it doesn't stay in the input.
          editorHandle.getBuffer().setText("");
          repaintEditor(editorHandle);
        } else if (rl !== null) {
          rl.write(null, { ctrl: true, name: "u" });
        }
      } finally {
        paletteOpen = false;

        // Hand stdin back to the editor and repaint its input row (the overlay
        // cleared it). No-op in readline mode (editorHandle is null).
        if (editorHandle !== null) {
          editorHandle.resume();
          repaintEditor(editorHandle);
        }

        refreshStatus();

        if (useInputRow && rl !== null) {
          syncInput();
        }
      }
    };

    // Open the interactive `@` file picker: a compact dropdown rendered INLINE just
    // above the input row (the conversation stays visible — no alternate screen),
    // recency-ordered, type to fuzzy-filter. The buffer keeps its `@`; the live
    // query is echoed onto the input row for feedback (it isn't in readline's/editor's
    // buffer — the picker owns input). On select, the full path is appended after
    // the `@`; at send time `@path` expands to the file's contents (see runSend).
    const openFilePicker = async (): Promise<void> => {
      paletteOpen = true;
      // In editor mode the editor owns stdin via a `data` listener; suspend it so
      // the inline picker's own `keypress` loop isn't fighting the editor for every
      // keystroke (both would otherwise consume the same input). Resumed in finally.
      editorHandle?.suspend();

      const base =
        editorHandle !== null
          ? editorHandle.getBuffer().getText()
          : rl !== null
            ? rl.line
            : ""; // text up to and including the just-typed `@`

      const view: IPickerView = {
        render: (query, items, selected): void => {
          const rows = formatCompletionRows(
            items,
            selected,
            transcriptCols(),
            process.stdout.isTTY
          );

          chrome.setInput(`${base}${query}`, base.length + query.length);
          chrome.setOverlay(rows);
        },
        close: (): void => {
          chrome.clearOverlay();
        },
      };

      try {
        const files = await listWorkspaceFiles(args.dir);
        const picked = await pickFileInline(files, view);

        if (picked !== null) {
          if (editorHandle !== null) {
            editorHandle.getBuffer().insert(`${picked} `);
            repaintEditor(editorHandle);
          } else if (rl !== null) {
            rl.write(`${picked} `);
          }
        }
      } finally {
        paletteOpen = false;

        // Hand stdin back to the editor and repaint its input row (the overlay
        // cleared it). No-op in readline mode (editorHandle is null).
        if (editorHandle !== null) {
          editorHandle.resume();
          repaintEditor(editorHandle);
        }

        refreshStatus();

        if (useInputRow && rl !== null) {
          syncInput();
        }
      }
    };

    // `/` on an empty line opens the palette; `@` at a word boundary opens the file
    // picker. The editor handles these internally (via openPalette/openFilePicker deps);
    // readline mode uses keypress detection. The shared paletteOpen guard keeps the
    // two overlays mutually exclusive. No-op while busy.

    if (process.stdin.isTTY && !useEditor && !flags.basicInput()) {
      // Only set up keypress detection for readline mode (not editor mode).
      emitKeypressEvents(process.stdin);
      process.stdin.on(
        "keypress",
        (str: string | undefined, key: { name?: string } | undefined) => {
          // Navigate the live agent tree while subagents run — checked BEFORE the
          // busy guard, because a turn is exactly when the tree is active. ↑/↓
          // move the detail-pane focus between agents.
          if (treeActive && (key?.name === "up" || key?.name === "down")) {
            moveTreeFocus(key.name === "up" ? -1 : 1);

            return;
          }

          syncInput(); // keep the pinned input row in sync as the user types

          if (busy || paletteOpen) {
            return;
          }

          if (str === "/" && rl !== null) {
            setImmediate(() => {
              if (!busy && !paletteOpen && rl.line === "/") {
                void openPalette();
              }
            });
          } else if (str === "@" && useInputRow && rl !== null) {
            // The inline dropdown renders above the input row, so it needs that row
            // (a tall-enough TTY). Without it we skip the picker — `@path` typed by
            // hand still expands at send time (composeMessage), just no live popup.
            setImmediate(() => {
              if (
                !busy &&
                !paletteOpen &&
                shouldOpenAtPicker(rl.line, rl.cursor)
              ) {
                void openFilePicker();
              }
            });
          }
        }
      );
    }

    // Event-driven (not for-await) so stdin is read DURING a run: a line typed
    // mid-run is queued to steer the next turn (or, if "/exit", aborts). This is
    // what makes it feel like a real harness — you can redirect without waiting.
    // When the editor is active, submitLine is wired via onSubmit; otherwise it's
    // called here from readline. Crucially: the editor owns stdin exclusively in
    // editor mode, and readline is NOT created in that case.
    if (useEditor) {
      // Editor-native `@`-completion: preload the workspace file list once, then
      // filter it synchronously as the user types. The dropdown is painted ABOVE
      // the editor block (not the readline input row), so it can't fight the editor
      // for the cursor — the cause of the earlier display corruption.
      let completionFiles: readonly string[] = [];

      void listWorkspaceFiles(args.dir).then((files) => {
        completionFiles = files;
      });

      const editorCompletion = {
        items: (query: string) => {
          const ts = flags.noLspTools() ? null : session.tsService;
          const symbols = ts?.symbols(query);

          return filterMentionItems(completionFiles, query, symbols, (abs) =>
            relative(args.dir, abs)
          );
        },
        pick: mentionInsertText,
        render: (items: readonly IMentionItem[], selected: number): void => {
          chrome.setEditorOverlay(
            formatCompletionRows(
              items,
              selected,
              transcriptCols(),
              process.stdout.isTTY
            )
          );
        },
        clear: (): void => {
          chrome.clearEditorOverlay();
        },
      };

      // When panes are up, reassemble SGR mouse reports across stdin chunks
      // before the editor sees them. A split report otherwise peels off ESC and
      // types `[<65;96;52M` into the prompt (and wheel feels insane).
      const stdinDataWrappers = new Map<
        (data: string) => void,
        (data: string) => void
      >();
      const mouseCsi = createMouseCsiFilter();
      let mouseCsiFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const ESC_HOLD_MS = 35;

      const deliverCleaned = (
        cleaned: string,
        cb: (data: string) => void
      ): void => {
        if (cleaned.length === 0) {
          return;
        }

        let rest = cleaned;

        while (rest.length > 0) {
          const peeled = takeOneInputSequence(rest);

          if (peeled.seq.length === 0) {
            break;
          }

          if (keymapOpen) {
            if (peeled.seq === "\x1b") {
              keymapOpen = false;
              chrome.clearOverlay();
              rest = peeled.rest;
              continue;
            }

            rest = peeled.rest;
            continue;
          }

          if (
            !busy &&
            !paletteOpen &&
            matchPaneAction(peeled.seq, tuiKeybindings) === "keymap.show" &&
            editorHandle !== null &&
            editorHandle.getBuffer().getText().trim().length === 0
          ) {
            keymapOpen = true;
            chrome.setOverlay(
              formatKeymapOverlay(tuiKeybindings, transcriptCols(), true)
            );
            rest = peeled.rest;
            continue;
          }

          const result = paneScreen.handleKey(peeled.seq);

          if (result === "handled") {
            rest = peeled.rest;
            continue;
          }

          // Passthrough this one key only — keep scanning so a later Ctrl+G
          // in `x\x07` still reaches the pane chrome.
          cb(peeled.seq);
          rest = peeled.rest;
        }
      };

      editorHandle = startEditor({
        stdin: {
          on: (event: string, cb: (data: string) => void) => {
            if (event !== "data") {
              process.stdin.on(event, cb);

              return;
            }

            const wrapped = (data: string): void => {
              if (mouseCsiFlushTimer !== null) {
                clearTimeout(mouseCsiFlushTimer);
                mouseCsiFlushTimer = null;
              }

              if (!panesLive()) {
                mouseCsi.reset();
                cb(data);

                return;
              }

              // Mouse reports hit PaneScreen before anything reaches the editor.
              const fed = mouseCsi.feed(data);

              for (const report of fed.reports) {
                paneScreen.handleKey(report);
              }

              deliverCleaned(fed.cleaned, cb);

              if (fed.holding) {
                mouseCsiFlushTimer = setTimeout(() => {
                  mouseCsiFlushTimer = null;
                  const flushed = mouseCsi.flush();

                  deliverCleaned(flushed.cleaned, cb);
                }, ESC_HOLD_MS);
              }
            };

            stdinDataWrappers.set(cb, wrapped);
            process.stdin.on(event, wrapped);
          },
          removeListener: (event: string, cb: (data: string) => void) => {
            if (event === "data") {
              const wrapped = stdinDataWrappers.get(cb);

              if (wrapped !== undefined) {
                process.stdin.removeListener(event, wrapped);
                stdinDataWrappers.delete(cb);

                return;
              }
            }

            process.stdin.removeListener(event, cb);
          },
          setRawMode: (mode: boolean) => {
            process.stdin.setRawMode(mode);
          },
          resume: () => {
            process.stdin.resume();
          },
          // The editor does string ops per chunk; without UTF-8 encoding,
          // process.stdin emits Buffers and the first keypress crashes.
          setEncoding: () => {
            process.stdin.setEncoding("utf8");
          },
        },
        // Mode switches only — must NOT go through streamOut (that appends to
        // the pane transcript and re-emits CSI on every paint).
        out: writeTerm,
        // Multi-row editor rendering callback: paints to the pinned input area
        renderEditor: (
          lines: string[],
          cursorRow: number,
          cursorCol: number
        ) => {
          chrome.setEditor(lines, cursorRow, cursorCol);
        },
        // Pane box = agent card width.
        columns: editorColumns(process.stdout.columns),
        // Editor reserves 3 rows internally; remainder = max draft visual lines
        // the growing input box will show (then Enter clears → 1 line again).
        rows: INPUT_INNER_ROWS_MAX + 3,
        openPalette,
        openFilePicker,
        completion: editorCompletion,
        pasteFromClipboard,
      });

      resizeEditor = (columns, _rows): void => {
        editorHandle?.resize(editorColumns(columns), INPUT_INNER_ROWS_MAX + 3);
      };

      editorControl = editorHandle;
      editorForExit = editorHandle;

      handleGateEnter = (): boolean => {
        if (paneScreen.focusState.railSurface !== "gate") {
          return false;
        }

        const sel = paneScreen.focusState.selection;
        const sorted = [...gateView.errors].sort((a, b) => {
          const ar = a.rule ?? a.key;
          const br = b.rule ?? b.key;

          if (ar !== br) {
            return ar.localeCompare(br);
          }

          const al = a.file ?? "";
          const bl = b.file ?? "";

          return al.localeCompare(bl);
        });
        const item = sorted[sel];

        if (item === undefined) {
          return false;
        }

        const steer = gateSteerText(item);

        if (editorHandle !== null) {
          editorHandle.getBuffer().setText(steer);
          editorHandle.resume();
          paneScreen.focusState.focusPrompt();
          repaintEditor(editorHandle);
        } else if (rl !== null) {
          rl.write(steer);
        }

        return true;
      };

      editorHandle.onSubmit(submitLine);
      editorHandle.onInterrupt(() => {
        if (active === null) {
          closed = true;
          editorHandle?.close();
          maybeFinish();
        } else {
          active.abort();
        }
      });
      editorHandle.onExit(() => {
        closed = true;
        editorHandle?.close();
        maybeFinish();
      });
      // Shift+Tab cycles the interactive mode (plan → normal → …).
      editorHandle.onCycleMode(() => {
        setMode(nextMode(currentModeId).id);
      });
      // ↑/↓ on an empty input row navigate the live agent tree (parity with the
      // readline path at the keypress handler above). Consumed only while a tree
      // is active; otherwise the editor keeps the arrows for history/cursor.
      editorHandle.onNavigateTree((delta) => {
        // Prefer pane scrollback when the pane console is up and the buffer
        // is empty; otherwise the live agent tree keeps the arrows.
        if (panesLive() && !treeActive) {
          // Empty prompt: ↑/↓ scroll the main transcript only (never the window).
          paneScreen.scrollMain(delta < 0 ? 1 : -1);

          return true;
        }

        if (!treeActive) {
          return false;
        }

        moveTreeFocus(delta);

        return true;
      });
    } else if (rl !== null) {
      rl.on("line", submitLine);
    }

    rl?.on("close", () => {
      closed = true;
      editorHandle?.close();
      paneScreen.leave();
      observeEvents(null); // stop feeding the agent tree once the REPL is gone
      maybeFinish();
    });

    // Enter alt-screen before any primary-buffer paint so scrollback is untouched.
    const seedPaneLanding = (panes: PaneScreen): void => {
      panes.setHeader({ cwd: args.dir, sessionId: id });
      syncPaneChrome();
      panes.setInput({ lines: [""], cursorRow: 0, cursorCol: 0 });

      // Tasks rail first — it shrinks mainInnerCols. Replay MUST use that width
      // (full stdout.columns paints cards that rewrap and shatter box rails).
      const planId = session.getActivePlanId();
      const plan = planId !== null ? loadPlan(args.dir, planId) : null;

      syncWorklistPanel(plan);

      // The boot banner, config warnings and MCP connect results, rendered
      // INSIDE the TUI as the transcript's first lines: scrollable, and they
      // survive the paint that used to erase them.
      const boot = outputRouter.endCapture();

      setMcpDiagnosticSink(null);

      if (boot.length > 0) {
        panes.appendMain(boot);
      }

      if (updateNotice !== null) {
        panes.appendMain(`${updateNotice}\n`);
      }

      if (resumed !== null) {
        const speaker = modelInfo(provider.config).model;
        const columns = panes.mainInnerCols();

        for (const message of resumed.messages) {
          if (isEphemeralUserInject(message)) {
            continue;
          }

          panes.appendMain(
            renderMessage(message, { color: true, speaker, columns })
          );
        }
      }
    };

    if (interactiveTty) {
      if (!paneScreen.enter()) {
        const reason = paneConsoleRejectReason({
          stdinTty: true,
          stdoutTty: true,
          rows: process.stdout.rows > 0 ? process.stdout.rows : 0,
        });

        // Never swallow boot output on the failure path: the pane never
        // painted, so stdout is the right destination after all.
        flushBootCaptureToStdout();
        process.stderr.write(
          `${reason ?? `tsforge: could not enter pane console (need ≥ ${String(PANE_MIN_ROWS)} rows)`}\n`
        );
        exitCode = 1;
        closed = true;
        editorHandle?.close();
        maybeFinish();

        return;
      }

      seedPaneLanding(paneScreen);
      resizeEditor?.(process.stdout.columns, process.stdout.rows);
    }

    // Belt and braces: any path that began the capture but never reached
    // seedPaneLanding must still emit it rather than swallow it.
    flushBootCaptureToStdout();

    if (args.task.length > 0) {
      void runLine(args.task); // sent as the first message; prompts when done
    } else {
      prompt();
    }
  });

  paneScreen.leave();
  process.stdout.off("resize", handleResize); // don't pin the REPL closure
  outputRouter.setParentSink(null); // later/headless writes go straight to stdout again
  // Flush any debounced save — the exit path must never lose --continue state.
  await persistNow();

  return exitCode;
}
