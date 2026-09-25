import type {
  IChatMessage,
  IModelResponse,
  IProvider,
  ITokenUsage,
  TokenChannel,
} from "../inference";
import { StreamInterruptedError } from "../inference";
import { isContextOverflow } from "../agent/agent-runner";
import type { ITask } from "../spec";
import {
  makeFileLinter,
  isWorkspaceContainer,
  makeWorkspaceFileLinter,
  runWorkspaceContainerGate,
  listChildPackageRoots,
  packageLabel,
  capturePackageGatePolicy,
  packageLintPacks,
  type FileLinter,
  type IPackageGatePolicy,
  type IPackageGateCaptureOpts,
} from "../gate";
import {
  captureDirtyBaseline,
  detectDirtyPackageRoots,
  rememberNewChildren,
} from "../gate/dirty-packages";
import { commandGate, type IGate } from "../gate/gate-runner";
import { workspaceHasCode } from "../gate/workspace-code";
import type { IStackProfile } from "../stack-detection";
import {
  type ADD_DEPENDENCY_TOOL,
  TOOL_NAME,
  buildSpawnAgentTool,
  READ_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  GITHUB_READ_TOOL,
  GIT_WRITE_TOOL,
  GITHUB_WRITE_TOOL,
  GITHUB_MARKER,
  GITHUB_DRIVE_GUIDANCE,
  LINEAR_READ_TOOL,
  LINEAR_WRITE_TOOL,
  LINEAR_START_TOOL,
  LINEAR_MARKER,
  LINEAR_DRIVE_GUIDANCE,
  NOTION_READ_TOOL,
  NOTION_WRITE_TOOL,
  NOTION_MARKER,
  NOTION_DRIVE_GUIDANCE,
  SENTRY_READ_TOOL,
  SENTRY_WRITE_TOOL,
  SENTRY_MARKER,
  SENTRY_DRIVE_GUIDANCE,
  BROWSER_MARKER,
  BROWSER_RESEARCH_GUIDANCE,
  NOTE_TOOL,
} from "../agent";
import { openBrowserSession, type BridgeStatus } from "../chrome-bridge";
import type { IAgentSpec } from "../agent/agent-spec";
import type { SpawnAgentFn, IToolContext, EditGuard } from "./tools";
import { resolveLinearCapability } from "./tools/linear-ops";
import { resolveNotionCapability } from "./tools/notion-ops";
import { resolveSentryCapability } from "./tools/sentry-ops";
import { suppressedIntegrationServers } from "./tools/integration-servers";
import { suppressCuratedSchemas } from "./tools/integration-common";
import type { PolicyMode, IPolicyRules } from "../policy";
import { mergePolicyRules } from "../policy";
import type { ProfileId } from "../config/profiles";
import { join } from "node:path";
import {
  buildMetaRuleContext,
  runMetaRules,
  buildMetaBaseline,
  META_RULES,
  type MetaBaseline,
} from "../meta-rules";
import { flags } from "../config";
import { trace } from "../lib/trace";
import {
  validate,
  isEslintJsonLine,
  type ErrorParser,
  type ErrorSet,
  type IValidateResult,
} from "../validate";
import { ruleHelp } from "./feedback";
import type { IConventionProvider } from "./conventions-provider";
import { houseConventionProvider, withProfileEnforcement } from "./conventions";
import { detectStack } from "../stack-detection";
import { recallMapBlock } from "../codebase";
import {
  loadTsforgeConfig,
  withProfileOverride,
  normalizeRuleOverrides,
  resolveActivePacks,
} from "../config/tsforge-config";
import { connectMcpServers, mergeMcpServers } from "../mcp";
import { loadGlobalMcpServers } from "../models-config";
import { loadAndRegisterPlugins } from "../config/external-plugins";
import {
  formatPackActivationNotice,
  newlyActivatedPacks,
  packsGrew,
  sortedPacks,
  summarizeGateCommand,
} from "./gate-visibility";
import {
  isChecklistSnapshot,
  CHECKLIST_SNAPSHOT_MARKER,
} from "./harness-inject";
import {
  autoCompactPct as compactThresholdPct,
  compactConversation,
  compactSummaryLine,
  scrubLegacyWriteArgStubs,
} from "./context-hygiene";
import {
  filterWriteForceTools,
  nextReadonlyStreak,
  streakAfterReadonlyResteer,
  toolCallsAttemptWrite,
  toolCallsDoResearch,
} from "./readonly-spin";
import {
  HISTORY_META_PARK_AT,
  HISTORY_META_RESTEER,
  HISTORY_META_RESTEER_AT,
  isHistoryMetaOnlyWriteTurn,
  nextHistoryMetaStreak,
  streakAfterHistoryMetaResteer,
  turnHadHistoryMetaReject,
} from "./history-meta-spin";
import {
  DEFAULT_TEMPERATURE,
  LOOP_LIMITS,
  RUN_STATUS,
  READONLY_STREAK_LIMIT,
  MAX_READONLY_RECOVERIES,
  STUCK_REASON,
} from "./loop.constants";
import type { Reporter, ILoopEvent, IHandoff } from "./loop.types";
import type { TtsrManager } from "./ttsr";
import { initTtsrManager, applyTtsrInterrupt } from "./ttsr-init";
import { assistantMessage } from "./assistant-message";
import { selectThinking, offeredToolsFor, usageEvent } from "./model-call";
import { activeOverlay } from "../self-harness/overlay";
import {
  mineLessons,
  consolidate as consolidateMemory,
  loadDecisionMemoryAtStart,
  decisionBriefBlock,
  buildDecisionRetainText,
  extractDecisions,
  lastAssistantContent,
  withDeadline,
  MEMORY_REQUEST_TIMEOUT_MS,
  EXTRACT_DECISION_TIMEOUT_MS,
  type ICandidateLesson,
  type IMemoryProvider,
} from "./memory";
import {
  buildChatSystem,
  buildDriveToGreenSystem,
  buildTddGuidance,
  buildHistoryFreshnessGuidance,
  type ExecutionMode,
} from "./prompt";
import { resolveConventions } from "../infer-rules/conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import type { TsService } from "../lsp";
import {
  buildTsService,
  BUILD_NUDGE,
  buildHandoffAsk,
  emitTiming,
  type ILoopCtx,
  type ILoopState,
  isPhantomRouteError,
  NO_TOOL_CALL_NUDGE,
  runCheckGate,
  runToolCalls,
  settleGate,
  announceTaskDone,
  toolsFor,
  browserTools,
  tryExpertRescue,
} from "./turn";
import { parkOrRaiseHand } from "./raise-hand";
import type { IPlanDocument } from "./worklist/checklist.types";
import { gateRailViewFromState, type IGateRailView } from "./session-gate-view";
import {
  countOpen,
  formatPlanTree,
  isChecklistComplete,
  loadPlan,
} from "./worklist/checklist-store";

/** Signature of the memory-consolidation step, injectable for tests so they can
 *  capture the per-build source id each send passes. */
export type ConsolidateLessonsFn = (
  cwd: string,
  candidates: readonly ICandidateLesson[],
  source: string
) => Promise<number>;

/**
 * A persistent, tool-using conversation against a working directory — the engine
 * behind the interactive CLI. Unlike `runTask` (one RED-first task driven to
 * green and returned), a Session lives across many user messages: each `send()`
 * runs the model until it stops calling tools, then — IF a gate is configured —
 * the deterministic gate confirms "done" (green = accept, red = errors fed back,
 * keep going). With no gate it's a plain conversational turn. Same `turn.ts`
 * primitives as `runTask`, so there is one tool-loop and one gate, not two.
 */
export interface ISessionConfig {
  provider: IProvider;
  /** Working directory the agent operates in. */
  cwd: string;
  /**
   * Extra absolute directories for read/run/search beyond `cwd` (multi-repo attach).
   * Default absent/`[]`. Do not set to the tsforge install path.
   */
  extraRoots?: readonly string[];
  /** Editable scope — edits/creates outside these are rejected. Empty = read-only. */
  files?: string[];
  /** Gate command. When set, a turn that ends without tool calls is gate-confirmed. */
  accept?: string;
  /** Auto-fix command run before re-validating (e.g. `eslint --fix`). */
  fix?: string;
  /** Opt into the core format janitor: a strict `eslint --fix` + prettier over the files
   *  the model wrote this session (`ctx.tool.touched`, never the whole tree — and NOT
   *  `task.files`, which defaults to a whole-repo glob in the REPL), deferring to the
   *  project's own prettier. The interactive CLI sets this; bare test/eval loops leave it
   *  off so they don't pay per-turn formatter subprocess latency. Independent of `fix`. */
  coreFormat?: boolean;
  /** Read-only context files. */
  context?: string[];
  parse?: ErrorParser;
  report?: Reporter;
  /** Test seam: override the memory-consolidation step (defaults to the real
   *  cross-build learned-rule pipeline). Lets a test observe the stable per-build
   *  source id passed on every send. */
  consolidateLessons?: ConsolidateLessonsFn;
  temperature?: number;
  enableThinking?: boolean;
  thinkingTokenBudget?: number;
  /** Runaway crash-guard on turns per send (default LOOP_LIMITS.runawayBackstopTurns).
   *  The PRIMARY terminal is ladder-exhaustion (R5 handoff), not this turn cap. */
  maxTurns?: number;
  /** Heartbeat cadence: emit checkpoint progress event every N turns without
   *  terminating (default LOOP_LIMITS.checkpointIntervalTurns). */
  checkpointIntervalTurns?: number;
  /** Base policy mode (from `--policy-mode`/config). Plan mode overrides it with
   *  `"plan"`; absent ⇒ `"default"`. */
  policyMode?: PolicyMode;
  /** Extra deny/allow/ask rules injected by a build BACKEND, MERGED with (appended to)
   *  the project config's `policy.rules`. Lets a stack forbid commands the model must
   *  never run (e.g. BoringStack blocks the model from starting the browser E2E / host
   *  dev server itself — that trips a host preflight guard and traps the drive). Kept
   *  generic here; the specific rules live in the backend (loop/boringstack). */
  policyRules?: IPolicyRules;
  /** Resume from a saved conversation (incl. its system message) instead of
   *  starting fresh — used by `--continue`. */
  history?: IChatMessage[];
  /** The last server-reported prompt size (tokens) from the persisted session —
   *  seeds the auto-compaction check so the FIRST resumed send can compact a
   *  near-full transcript instead of firing blind at full size (before this, a
   *  95%-full resume overflowed on its first call and, with no recovery, died). */
  lastPromptTokens?: number;
  /** Extra opinionated guidance appended to the system prompt (e.g. a scaffold's
   *  conventions: "this is a web app, the entry is app.ts…"). */
  guidance?: string;
  /** The model's context window (tokens). When set, the session auto-compacts
   *  before a send once the held context exceeds `autoCompactAt` of it. 0/unset
   *  disables auto-compaction. */
  contextWindow?: number;
  /** Fraction of `contextWindow` that triggers auto-compaction (default 0.8). */
  autoCompactAt?: number;
  /** A FAST check (e.g. `tsc --noEmit`) run every `checkEvery` edits WHILE the
   *  model is still building — so errors surface a few edits after they're made,
   *  not as a 100-error avalanche when it finally stops. Empty = off. */
  incrementalCheck?: string;
  /** Edits between incremental checks (default 3). */
  checkEvery?: number;
  /** Write-time single-file linter (the gate's eslint rules per write). When set,
   *  the write-guard reports lint violations — the moat rules tsc can't see (`as`,
   *  `I`-prefix) — inline, so they're fixed in-context not piled up at the gate. */
  lintFile?: FileLinter;
  /** Optional edit guard that can veto+revert an applied edit. Set by a build
   *  BACKEND (e.g. boringstack) to inject a domain rule; the core edit tool stays
   *  domain-agnostic. Absent ⇒ no guard. */
  editGuard?: EditGuard;
  /** Rule profile override for this session (from a recipe); defaults to config file. */
  profile?: ProfileId;
  /** When true, per-package workspace gates omit the project's test command
   *  (CLI `--strict-floor-only`). */
  strictFloorOnly?: boolean;
  /** Offer the read-only `pull_conventions` tool — set by a build BACKEND that ships
   *  a convention library (e.g. boringstack) so the model can fetch its how-to
   *  patterns on demand. Drive-to-green sessions without a provider get the house
   *  library injected automatically. Decoupled from any flag: chat leaves it off. */
  pullConventions?: boolean;
  /** The build ADAPTER's (or house) convention library, injected as a generic provider
   *  (see `IConventionProvider`). Delivery: short pull contract in the system prompt,
   *  full bodies via `pull_conventions` + reactive PUSH after red. Absent ⇒ no
   *  stack conventions (unless drive-to-green defaults to house). */
  conventions?: IConventionProvider;
  /** Offer the callable, structured `check` tool (WS-G) — set by a build BACKEND
   *  whose gate is authoritative (e.g. boringstack, which injects its gate per-slice
   *  via `setGate`). The tool runs the SAME full evaluation `settleGate` does
   *  (`runCheckGate` → autofix + gate command + META_RULES combined — NOT the gate
   *  runner alone) and returns the whole structured error set MID-TURN, so the model
   *  fixes every error in one pass. Left off for plain eval/scratch tasks (their
   *  acceptance set can be empty ⇒ vacuous). */
  offerCheck?: boolean;
  /** POLICY approval-path only. The REPL keeps this false so `ask` DENYs honestly
   *  (no per-action UI). Do not use this to offer co-pilot tools — see
   *  `humanPresent` / `offerTaskTools` / `offerPresentPlan`. */
  interactive?: boolean;
  /** TTY co-pilot is present. Sets `ctx.tool.humanPresent` and offers `ask_user`.
   *  Must not set `ctx.tool.interactive` (that loosens policy `ask`). */
  humanPresent?: boolean;
  /** Put `task_*` in `this.tools`. `offeredToolsFor` still withholds them until
   *  `activePlanId` is bound. REPL always true. */
  offerTaskTools?: boolean;
  /** Put `present_plan` in `this.tools`. `offeredToolsFor` still withholds it
   *  outside plan mode. REPL always true. */
  offerPresentPlan?: boolean;
  /** Seed the deferred-gate flag at construction: an edit written before an ask_user
   *  pause that has NOT yet been validated. Set when a caller rebuilds the Session (e.g.
   *  the REPL's /clear) but must not drop the still-pending gate — the first send that
   *  yields (or churns) then validates the on-disk edit. Without this the rebuilt session
   *  starts `edited=false` and a conversational send silently skips the gate (WS-C). */
  pausedWithEdit?: boolean;
  /** Seed `ctx.tool.touched` from a resumed session so workspace gates still
   *  know which packages were edited before the pause. */
  touched?: readonly string[];
  /** Session-bound plan id restored from the session store on `--continue`. */
  activePlanId?: string | null;
  /** Fired when a task_* tool persists a plan change (REPL refreshes the Tasks rail). */
  onPlanChanged?: (plan: IPlanDocument) => void;
  /** Fired when present_plan proposes a plan (REPL renders pending proposal). */
  onPlanPresented?: (plan: IPlanDocument) => void;
  /** Put `propose_product_plan` in `this.tools`. `offeredToolsFor` still
   *  withholds it outside greenfield mode (see `setGreenfieldMode`). REPL
   *  always true — same posture as `offerPresentPlan`. */
  offerProductPlan?: boolean;
  /** Composed gate the session's loop checks each cycle. Defaults to a command
   *  gate from `accept`. Use `setGate` to swap it per unit mid-build. */
  gate?: IGate;
  /** AUTO gate re-detection: when set, the session re-resolves this before each gate
   *  cycle and refreshes `task.accept` + the stack profile + the per-write linter — so a
   *  greenfield build enables framework rule-packs once its package.json lists them,
   *  instead of freezing on the empty-dir `generic-ts` fallback. Disabled the moment the
   *  user overrides the gate (`setGate`). Ignored when an explicit `gate` is given. */
  autoGate?: () => Promise<{
    command: string;
    stackProfile: IStackProfile;
    lintFile?: FileLinter;
    /** Set when re-resolution would downgrade the gate below the session's
     *  stage floor — the runner reds the cycle instead of adopting it. */
    downgrade?: string;
  }>;
  /** Pristine-scaffold meta-rule baseline to subtract from each cycle's violations.
   *  Usually captured mid-build via `captureMetaBaseline()`; this is for callers that
   *  already hold one at construction time. */
  metaBaseline?: MetaBaseline;
  /** How the model is driven. `"chat"` (default) = open-ended assistant framing;
   *  `"drive-to-green"` = the strict expert-TS implement contract (for autonomous
   *  builds), so the constitution is in force from the first token, not the gate. */
  executionMode?: ExecutionMode;
}

/** The outcome of one `send`. `responded` = conversational (no gate); the gate
 *  verdicts are `done`/`stuck` as in `runTask`; `interrupted` = the user aborted. */
export interface ISendResult {
  status: "responded" | "done" | "stuck" | "interrupted";
  turns: number;
  /** When stuck with a handoff: the structured, resumable handoff details. */
  handoff?: IHandoff;
  /** WS-C: set to the question when the send ended because the model called `ask_user`.
   *  The REPL routes the user's NEXT free-text line as the answer BEFORE plan-approval
   *  detection (so "go"/"approve" answers the question, not the plan — which would
   *  wrongly unlock mutating tools). Slash commands still run (a slash during a pause is
   *  a deliberate command), and the answer goes through the normal send path (@file/image
   *  expansion apply) — it is NOT delivered byte-for-byte verbatim. */
  awaitingUser?: string;
}

/** Cumulative model-call metrics for a session — the basis for `/metrics`. */
export interface ISessionMetrics {
  /** Number of model calls made. */
  readonly calls: number;
  /** Total prompt (input) tokens billed across all calls. */
  readonly promptTokens: number;
  /** Total completion (output) tokens generated across all calls. */
  readonly completionTokens: number;
  /** Output generation rate averaged over all calls (tokens/second). */
  readonly avgTokensPerSecond: number;
  /** Output generation rate of the most recent call (tokens/second). */
  readonly lastTokensPerSecond: number;
}

export interface ISendOptions {
  /** Caller cancellation (Ctrl-C). */
  signal?: AbortSignal;
  /** Drained at each turn boundary — any returned strings are injected as user
   *  messages before the next model call, so the user can STEER a run in flight
   *  ("actually use Tailwind") without aborting it. */
  steer?: () => string[];
  /** Per-send thinking override (beats cfg.enableThinking for this send only).
   *  Used to keep thinking ON for the design phase (where reasoning earns its
   *  keep) but OFF for the mechanical implement phase, where ~25k tokens of
   *  pre-write reasoning per build is pure latency. */
  enableThinking?: boolean;
}

const SESSION_ID = "session";

/** ONE stable memory-source id for this whole PROCESS (= one build; the nightly
 *  loop spawns a fresh headless-build process per domain, and all of a build's
 *  features / revisit attempts / Sessions run inside it). Memory's recurrence
 *  gate (MIN_HITS_TO_ACTIVATE) treats a distinct `source` as a distinct session,
 *  so this MUST be stable across the build — a per-send/per-Session id makes a
 *  lesson mined twice within ONE build look like a cross-session recurrence,
 *  activate mid-build, and trap the model with notes about its own in-progress
 *  code (the learned-rule self-poisoning bug). Cross-build learning still works:
 *  a separate invocation is a new process with a new id, so a genuinely
 *  recurring lesson still bumps hits and activates on the next build. The pid
 *  disambiguates two builds started in the same millisecond (Date.now alone can
 *  collide), so genuine cross-build recurrence is never misread as same-build. */
export const MEMORY_RUN_ID = `${SESSION_ID}-${Date.now().toString(36)}-${process.pid.toString(36)}`;

/** A gate-output sink that also carries `flush()` — call it when the stream
 *  ends to emit any trailing line the process printed without a newline. */
export type IGateStreamSink = ((text: string) => void) & { flush: () => void };

/** Wrap a live gate-output sink so the machine-readable `eslint --format json`
 *  blob NEVER reaches the terminal — it's a single giant JSON line the harness
 *  parses internally and a human must not see (it was dumping raw at the end of
 *  every web run). Buffers across chunk boundaries: a line that begins `[{` is
 *  held until its newline, then dropped if it's the eslint JSON; everything else
 *  (vite build progress, tsc, test output) passes through unchanged. Call
 *  `flush()` at stream end so a final newline-less line isn't swallowed. */
export function filterGateStream(
  sink: (text: string) => void
): IGateStreamSink {
  let buf = "";

  const emit = (line: string): void => {
    if (!isEslintJsonLine(line)) {
      sink(line);
    }
  };

  const fn = (text: string): void => {
    buf += text;

    // Cursor-based line walk: re-slicing the remaining buffer per line was
    // O(n²) on chunks carrying many lines (tsc/vitest bursts). One slice at
    // the end keeps only the trailing partial.
    let start = 0;
    let nl = buf.indexOf("\n", start);

    // Emit only COMPLETE (newline-terminated) lines; HOLD any trailing partial
    // until its newline (or flush()). This is what makes the JSON drop reliable:
    // the eslint blob is one complete line, always evaluated whole and dropped —
    // the old partial flush leaked the JSON across chunk boundaries. Gate output
    // (vite/tsc/test) is line-based, so live progress isn't lost.
    while (nl !== -1) {
      emit(buf.slice(start, nl + 1));
      start = nl + 1;
      nl = buf.indexOf("\n", start);
    }

    if (start > 0) {
      buf = buf.slice(start);
    }
  };

  // When the gate process exits, its last chunk may not end in a newline — emit
  // that remainder (still JSON-filtered) so no output is permanently lost.
  fn.flush = (): void => {
    if (buf.length > 0) {
      emit(buf);
      buf = "";
    }
  };

  return fn;
}

// assistantMessage moved to ./assistant-message so runTask (run.ts) and Session share
// ONE TTSR-aware builder — a fix in one path but not the other left the API-400 bug live.

/** Default share of the context window that triggers auto-compaction. */
const AUTO_COMPACT_AT = 0.8;

/** GENERAL plan mode (the default for a fresh interactive session; also the
 *  `/plan` toggle — distinct from the staged web build's PLAN_SUMMARY_STEP):
 *  rides the first user message after the mode flips on. Read-only tools enforce
 *  the contract at the execute layer; this note tells the model the workflow —
 *  explore, ask the few clarifying questions that matter, propose a plan, wait. */
const PLAN_MODE_NOTE =
  "[PLAN MODE — read-only. edit/create and write commands are disabled until " +
  "you propose a plan and the user approves it.]\n" +
  "Work in this order:\n" +
  "1. EXPLORE: read/search the code this request actually touches. Skip this for " +
  "a self-contained ask that has nothing to do with this repo — just answer it.\n" +
  "2. CLARIFY — ask only the FEW questions that most change the plan (scope, which " +
  "file/module to touch, the desired behavior, hard constraints). At most 3-4, as a " +
  "short numbered list, then STOP and wait for the answers. Do NOT ask what the code " +
  "or a sensible default already settles — state those as one-line assumptions " +
  "instead. Never interrogate: skip any question the user can't meaningfully answer.\n" +
  "3. GREENFIELD (building something new from scratch): say plainly, up front, that " +
  "the more detail and research the user provides now, the better the result — a " +
  "sharp spec (goals, who it is for, must-have features, tech/stack constraints, " +
  "reference examples, and explicit non-goals) yields a far better build than a vague " +
  "one. Then ask for the specific missing pieces that matter most. If the user would " +
  "rather not answer, proceed on clearly-stated assumptions — never block.\n" +
  "4. PLAN — once you know enough, call the `present_plan` tool with " +
  "{ goal, items: [{ title, detail?, files?, verify?, kind?, children? }] }. " +
  "Do NOT paste the JSON into chat — the harness renders it for the human. " +
  "Decompose for execution: (a) GREENFIELD — prefer VERTICAL feature slices " +
  "(scaffold + one visible proof → feature end-to-end → next feature → polish), " +
  "NOT layer-first (types then mocks then api then pages); nest contracts/tests " +
  "under the slice that needs them; (b) one shippable outcome per item with an " +
  "actionable title (e.g. Feed page end-to-end — not vague prose); (c) `files` " +
  "is a hint when known — a vertical slice may list more than 3 paths; do NOT " +
  "split a working feature across items just to keep file counts small; " +
  "(d) prefer a parent feature + children over one mega-item; " +
  "(e) NEVER a checklist item for 'run tests / lint / the gate' — the harness " +
  "gate validates each task_complete; `verify` is an optional hint only; " +
  "`kind` may be investigate|create|modify|test (advisory). " +
  "The user replies with feedback (call present_plan again with revisions) or " +
  "approves (approve/go/lgtm). On approve, the harness writes plans/<id>.json " +
  "and you implement ONLY after that.";

/** Sent when the user approves a plan-mode plan — the plan itself is already the
 *  latest assistant message, so anchor it instead of re-pasting it. */
export const PLAN_APPROVED_NOTE =
  "Your plan is APPROVED — saved as this session's checklist under " +
  ".tsforge/worklist/plans/<id>.json (bound via activePlanId). Plan mode is off; " +
  "task_list / task_focus / task_complete / task_uncomplete / task_add / " +
  "task_update are available. The plan is a living checklist: when you or the " +
  "human discover work the approved plan missed, call task_add (optional " +
  "parent_id to nest); when an item's title/detail/files/verify is wrong, call " +
  "task_update; when done work needs redoing, task_uncomplete then continue. " +
  "Do not keep discovered work only in chat — put it on the checklist. " +
  "With a code gate, task_complete RUNS THE GATE and only marks done when " +
  "green — never invent done, never mark an item complete while the gate is " +
  "red; finishing requires BOTH gate green AND every checklist item done. With " +
  "no code gate (research/notes work) it just records the item. Walk items in plan order " +
  "(vertical slices in the order approved). Implement now: task_focus the first " +
  "open item, then emit the tool calls. Do not re-explore or restate the plan.";

/** Shared with `isChecklistSnapshot` so the writer and the detector cannot drift. */
const CHECKLIST_CONTRACT_MARKER = CHECKLIST_SNAPSHOT_MARKER;

/** A snapshot minus its `(revision N)` header — the part that decides "changed". */
function treeOf(snapshot: string): string {
  const nl = snapshot.indexOf("\n");

  return nl === -1 ? "" : snapshot.slice(nl + 1);
}

/** Post-green nudge when the gate is clean but the bound plan still has open nodes. */
export function checklistOpenNudge(opts: {
  openCount: number;
  calledTaskComplete: boolean;
}): string {
  const base =
    `Gate is GREEN but the approved checklist still has ${String(opts.openCount)} ` +
    "open item(s). Finished work requires BOTH gate green AND every checklist " +
    "item done (via task_complete). Status is tools-only — do not invent done.";

  if (!opts.calledTaskComplete) {
    return (
      `${base} You did not call task_complete this turn — mark finished items, ` +
      "then task_focus the next open item and continue."
    );
  }

  return `${base} Continue with the next open item (task_focus / task_complete).`;
}

export {
  isEphemeralUserInject,
  isGateFeedbackInject,
  isHarnessUserInject,
} from "./harness-inject";

/** Default edits between incremental checks. */
const CHECK_EVERY = 3;

/** Force the FULL gate after this many edits without the model yielding. The
 *  incremental check (CHECK_EVERY) is TS-only and the full gate normally runs only
 *  on yield — so a model stuck editing one file (never yielding) would never run
 *  the build, never see build/CSS errors, and never tick the no-progress guards
 *  (observed: 190 turns / 2 gate runs on a corrupted index.css). This bounds blind
 *  edit-churn: every Nth edit re-gates, surfacing the real error AND advancing the
 *  guards so a genuine loop is stopped. */
const FULL_GATE_EVERY = 9;

/** Edits between forced gates when NEAR-GREEN or already stalling — small, so the
 *  gate (and the escalation ladder it drives via `checkStuck`) cycles densely and
 *  climbs to the expert in a handful of turns. */
const FULL_GATE_EVERY_NEAR_GREEN = 2;

/** A gate error count at/under this is "near green" — close enough that dense,
 *  immediate feedback beats churning many blind edits between sparse gates. */
const NEAR_GREEN_ERRORS = 3;

/**
 * How many edits to allow before forcing a full gate. Normally `FULL_GATE_EVERY`,
 * but once the build is NEAR-GREEN (a small, non-zero last gate error count) or the
 * steer ladder has already begun, collapse toward `FULL_GATE_EVERY_NEAR_GREEN` so
 * the gate — and the escalation ladder that only advances per gate cycle — fires
 * densely and reaches the expert in a handful of turns instead of hundreds (a live
 * run ground ~100 turns at 1 error because gates were ~15–20 turns apart). Progress
 * isn't penalised: a new all-time-low error count resets the guards, so only a
 * genuine plateau escalates — this changes cadence, NOT any gate rule or threshold.
 */
export function forcedGateInterval(state: ILoopState): number {
  const lastCount = state.lastGateCount;
  const nearGreen = lastCount > 0 && lastCount <= NEAR_GREEN_ERRORS;
  const stalling = state.steerLevel > 0;

  return nearGreen || stalling ? FULL_GATE_EVERY_NEAR_GREEN : FULL_GATE_EVERY;
}

/** Reset convergence state at a `send()` boundary. A Session keeps conversation
 * and cumulative edit metrics across messages, but a new drive must not inherit an
 * exhausted ladder or sticky block from the previous drive. */
export function resetDriveConvergence(state: ILoopState): void {
  state.prevGateErrors = [];
  state.gateNoProgress = 0;
  state.bestErrorCount = Number.POSITIVE_INFINITY;
  state.noNewLow = 0;
  state.errorAge = new Map();
  state.lastGateCount = -1;
  state.steerLevel = 0;
  state.redGates = 0;
  state.blockFingerprint = "";
  state.recentGateFingerprints = [];
  state.triedLeversByBlock = new Map();
  state.pendingRung = null;
  state.pendingBlockFingerprint = null;
  state.pendingDiagnosisSteer = null;
  state.focusError = null;
  delete state.plateauBest;
  delete state.pendingSteer;
  delete state.resetContext;
  delete state.pendingModelOverride;
  // WS-B is per-drive: a new drive starts with no checkpoint, watermark, or revert budget
  // (the budget bounds TOTAL reverts for the drive). Kept in sync with driveInner's own
  // per-drive reset so no path can carry a spent budget or stale checkpoint across a send.
  delete state.nearGreenCheckpoint;
  delete state.nearGreenBest;
  delete state.nearGreenRollbacks;
  delete state.completionPhase;
  // #77: the near-green ROTATION window + flag are per-drive too — else a send that ends mid-
  // rotation leaks the flag into the next send, injecting the completion-only steer with no
  // evidence from the new drive.
  delete state.nearGreenSamples;
  delete state.nearGreenSpikeGap;
  delete state.nearGreenRotation;
}

/** How many times a send recovers from a repetition loop before giving up. */
const MAX_DEGENERATION_RECOVERIES = 2;

/** How many times a send recovers from a model-request TIMEOUT before giving up.
 *  A single over-long turn (the model spiralled past the request timeout) must not
 *  throw away many turns of real progress — re-steer toward a small, fast turn and
 *  continue. Bounded so a server that's genuinely wedged still ends the run. */
const MAX_TIMEOUT_RECOVERIES = 2;

/** Pushed after a request timeout — the previous turn ran past the (generous)
 *  request timeout, almost always from too-long reasoning or one huge file. Demand
 *  a small, fast turn (paired with a forced, thinking-off tool call). */
const TIMEOUT_RESTEER =
  "Your previous response timed out — it ran too long (likely over-long reasoning " +
  "or one huge file). Make the SINGLE next tool call now: create or edit just ONE " +
  "file, kept small. Keep reasoning brief. No prose.";

/** True when an error is a request TIMEOUT (AbortSignal.timeout fires a
 *  `TimeoutError`), as opposed to a caller abort or a connection drop. Matched
 *  on error CLASSES, not the message: the old `/timeout/i` substring match
 *  classified any permanent 400 whose response BODY mentioned a "timeout"
 *  field as recoverable, re-steering a doomed request MAX_TIMEOUT_RECOVERIES
 *  times. A StreamInterruptedError is a timeout iff its cause is. */
export function isModelTimeout(err: unknown): boolean {
  if (err instanceof StreamInterruptedError) {
    return isModelTimeout(err.cause);
  }

  if (!(err instanceof Error)) {
    return false;
  }

  return (
    err.name === "TimeoutError" ||
    err.name === "HeadersTimeoutError" ||
    err.name === "BodyTimeoutError"
  );
}

/** Pushed after a response hit the output-token cap mid-tool-call: the partial
 *  call was dropped (its arguments were cut mid-JSON), so demand the same work
 *  in smaller pieces instead of retrying the identical over-long emission. */
const TRUNCATION_RESTEER =
  "Your tool call was CUT OFF by the response token limit — its arguments never " +
  "arrived intact and it was NOT executed. Emit a smaller call now: write the " +
  "file in smaller pieces (create the file with the first part, then extend it " +
  "with edit), or split the work across multiple calls. No prose.";

/** Pushed after a repetition loop — break the spiral by demanding ONE concrete
 *  action (paired with a forced tool call, which can't loop in prose). "Concrete
 *  progress" is an edit only when there is code to fix (a live gate); in a
 *  research/notes session it is saving findings or moving on. */
export function repetitionResteer(liveGate: boolean): string {
  const step = liveGate
    ? "create or edit ONE file"
    : "save what you have found with `note`, or move on to the next page/source";

  return (
    "You started repeating yourself. STOP — do not re-explain or re-decide. Emit " +
    `the SINGLE next tool call that makes concrete progress (${step}). No prose.`
  );
}

/** Pushed on a read-only spin in a BUILD (gated) session — demand a concrete edit. */
const READONLY_RESTEER_BUILD =
  "STOP READING. You already have enough context — further survey reads will be rejected. " +
  "Your ONLY allowed tools now are create / edit / edit_lines / check. Call `check` if you " +
  "need the current gate errors, then emit ONE write with real file contents. Do not call " +
  "read, run, or search.";

/** Pushed on a read-only spin in a CONVERSATIONAL (no-gate) session — demand an
 *  answer (there is nothing to edit, so the failure is never wrapping up). */
/** The build execution mode (strict-TS drive-to-green contract). */
const DRIVE_MODE = "drive-to-green";

const READONLY_RESTEER_ANSWER =
  "You have made many tool calls in a row without answering — only reading or " +
  "searching. You have enough context now. STOP reading and give your answer, " +
  "with no further tool calls.";

/** Prefaces interim-check feedback so the model fixes real errors and ignores the
 *  expected "module not found" noise from files it hasn't created yet. */
const INTERIM_CHECK_NOTE =
  "Interim type-check (NOT the final gate) — fix these now, while they are few, " +
  "before writing more. IGNORE any `Cannot find module './…'` for files you have " +
  "not created yet; fix the real type errors:";

/** How many interim errors to surface per turn (raw message + rule-doc lookup). */
const INTERIM_ERROR_CAP = 20;

/**
 * Compose the interim-check user message: the note, the capped raw error list,
 * and — when a failing rule has a curated doc — the fix RECIPE from `ruleHelp`.
 * Without this the build model saw only raw rule messages (e.g.
 * `i18n-locale-keys-used: … dead translation surface (remove … or wire it up)`)
 * and took the destructive path (deleting keys it just wrote) because nothing
 * taught it the constructive fix (wire the key into the UI state it names).
 * Exported for unit testing.
 */
export function interimCheckContent(errors: ErrorSet): string {
  const shown = errors.slice(0, INTERIM_ERROR_CAP);
  const detail = shown.map((e) => e.message).join("\n");
  // No silent truncation: if the cap dropped errors, say how many remain so the
  // model knows the list is partial (not that only `shown` are outstanding).
  const omitted = errors.length - shown.length;
  const more =
    omitted > 0
      ? `\n… and ${String(omitted)} more error(s) not shown — fix these first, then re-run.`
      : "";
  const help = ruleHelp(shown);
  const guidance = help.length > 0 ? `\n\n${help}` : "";

  return `${INTERIM_CHECK_NOTE}\n${detail}${more}${guidance}`;
}

/**
 * Did the model write whole files INTO its chat message instead of calling
 * `create`? Trips on ≥2 fenced code blocks (4 ``` markers), or one big block in
 * a long message — i.e. it dumped the app as prose. A single short illustrative
 * snippet in a chat answer does NOT trip it, so genuine Q&A is unaffected.
 */
function looksLikeCodeDump(content: string): boolean {
  const fences = (content.match(/```/g) ?? []).length;

  return fences >= 4 || (fences >= 2 && content.length > 1500);
}

const TOOL_NAMES_ALT = Object.values(TOOL_NAME).join("|");

/** Tool-call MARKUP leaked into the reply text: the known malformed variants
 *  (`<function=`, `<tool_call`, `<parameter…`, `<|tool|>`, `<tool>` for a tool
 *  we offer) — the server's parser left the call in content and salvage could
 *  not rescue it (see malformed-toolcall-format + wire.ts salvage). */
const LEAKED_CALL_RE = new RegExp(
  `<function=|<tool_call|<parameters?[=>]|<\\|(?:${TOOL_NAMES_ALT})\\|>|^<(?:${TOOL_NAMES_ALT})>`,
  "im"
);

/** The fully-degenerate invented-markup form: a short matched `<tag>…</tag>`
 *  pair on its own lines (e.g. `<files>\n["…"]\n</files>`, captured live). A
 *  legit prose answer with an HTML example could match — the cost is one
 *  bounded nudge turn, while missing it strands the whole build. */
const TAG_PAIR_RE = /^<([a-z_]+)>\s*$[\s\S]{0,400}?^<\/\1>\s*$/m;

/** Did the model emit a tool call as TEXT instead of invoking one? */
function leaksToolMarkup(content: string): boolean {
  return LEAKED_CALL_RE.test(content) || TAG_PAIR_RE.test(content);
}

/** Pushed when a no-tool-call reply contained leaked tool markup — the model
 *  believes it acted, but nothing ran. Paired with a FORCED tool call next turn
 *  (constrained decoding ⇒ the retry always parses). */
const MALFORMED_CALL_NUDGE =
  "Your last reply contained tool-call markup as plain TEXT — the syntax was " +
  "malformed, so NO tool ran and nothing happened. Do not write tool syntax " +
  "in prose. Re-issue that action as a real tool call now.";

/** CHAT_SYSTEM + the (optional) workspace map + a short orientation to the
 *  workspace and gate. The map block, when present, is injected right after
 *  CHAT_SYSTEM so the agent is oriented before the task-specific lines. */
/** Header of the DYNAMIC task-contract block. It carries the mutable facts (editable
 *  scope + active check) and is rebuilt from LIVE `ctx.task` by `refreshTaskContract`
 *  whenever `setScope`/`setGate` change them — so the top-priority prompt can never go
 *  stale (the old bug: "edit any file" persisting after scope narrowed to one feature).
 *  Kept as the LAST block of the system message; `guide()` inserts before it. */
const TASK_CONTRACT_MARKER = "## Current task contract";

/** The dynamic contract: what's editable right now + how acceptance is checked. */
function taskContract(
  files: string[],
  accept: string | undefined,
  offerCheck = false
): string {
  const wholeRepo = files.length === 0 || files.includes("**/*");
  const scope = wholeRepo
    ? "Scope: you may read, run, and edit any file in the workspace."
    : `Scope: edit ONLY these paths — ${files.join(", ")}. Every other file is READ-ONLY; never edit it.`;
  let check = "";

  if (accept !== undefined && accept.length > 0) {
    const label = summarizeGateCommand(accept);

    check = offerCheck
      ? `Check: \`${label}\` — call the \`check\` tool any time for the full structured error set; the harness also runs it when you stop calling tools. Fix failures until it passes. Do NOT run the gate through the shell.`
      : `Check: \`${label}\` runs automatically when you stop calling tools — fix any failures and continue until it passes.`;
  }

  return [TASK_CONTRACT_MARKER, scope, check]
    .filter((s) => s.length > 0)
    .join("\n");
}

/** Whether `pull_conventions` is OFFERED — advertised in the system prompt AND exposed by
 *  `toolsFor`. Both must read this ONE predicate or they drift: the tool is offered only when
 *  the capability flag is on AND a provider is actually injected (a knowledge tool with no
 *  provider always returns "no convention library"). Keeping the prompt inventory and the
 *  advertised tool list in lockstep is the flag↔prompt invariant. */
function conventionsOffered(cfg: ISessionConfig): boolean {
  return cfg.pullConventions === true && cfg.conventions !== undefined;
}

/**
 * Drive-to-green without an adapter provider gets the house convention library
 * (pull-before-first-write). Explicit `pullConventions: false` opts out. Chat /
 * ungated stays off. BoringStack (and other adapters) keep their injected compose.
 */
function withDefaultHouseConventions(cfg: ISessionConfig): ISessionConfig {
  if (cfg.executionMode !== DRIVE_MODE) {
    return cfg;
  }

  // Explicit opt-out wins (chat-like gated runs that still use drive-to-green framing).
  if (cfg.pullConventions === false) {
    return cfg;
  }

  // Every guide is served through the profile wrapper — the house library and an
  // adapter's injected provider alike — so no guide can promise enforcement the
  // ACTIVE profile does not deliver. Neither provider knows about profiles; this
  // is the one place that does.
  if (cfg.conventions !== undefined) {
    return {
      ...cfg,
      pullConventions: true,
      conventions: withProfileEnforcement(cfg.conventions, cfg.profile),
    };
  }

  return {
    ...cfg,
    pullConventions: true,
    conventions: withProfileEnforcement(houseConventionProvider, cfg.profile),
  };
}

/** `check` is live only when the backend opts in AND the prompt is drive-to-green. */
function isOfferCheckActive(cfg: ISessionConfig): boolean {
  return cfg.offerCheck === true && cfg.executionMode === DRIVE_MODE;
}

/** The STATIC system policy (identity, tools, conventions, workspace map, guidance) +
 *  the initial dynamic task contract. Base framing is mode-driven: `drive-to-green`
 *  (autonomous builds) gets the strict expert-TS implement contract; `chat` (default)
 *  gets the open-ended assistant framing. The scope/check facts live in the task
 *  contract (rebuilt per change), NOT baked statically here. */
/** Tools that only make sense against a live gate. */
const GATE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAME.check,
  TOOL_NAME.pullConventions,
]);

/** How long a "no code yet" workspace probe is trusted before re-scanning. */
const CODE_PROBE_TTL_MS = 2000;

export type PromptMode = "drive-to-green" | "chat";

/** The mode-specific HEAD of the system prompt — everything that differs between
 *  building (strict-TS drive-to-green contract, TDD, conventions) and assisting.
 *  Kept a separate prefix so the session can swap it in place when the gate
 *  wakes (code appeared) or is cleared, without rebuilding the rest. */
export function promptHead(
  mode: PromptMode,
  cfg: ISessionConfig,
  conventions: IConventions
): string {
  if (mode === "chat") {
    return `${buildChatSystem(conventions)}\n\n`;
  }

  const base = buildDriveToGreenSystem(
    conventions,
    cfg.offerCheck === true,
    conventionsOffered(cfg)
  );
  // TDD-first (default ON) — the headless build prompt gets this via
  // buildSystemPrompt; the interactive build path injects it here. Build mode
  // only: test-first guidance is noise in a research or chat session.
  const tdd = flags.tdd() ? `${buildTddGuidance(conventions)}\n\n` : "";
  // Short pull-before-first-write contract + topic names only — never full guide
  // bodies. Full text arrives via `pull_conventions` (and optional PUSH after a red).
  const conv = conventionsOffered(cfg)
    ? `${cfg.conventions?.buildGuides() ?? ""}\n\n`
    : "";

  return `${base}\n\n${tdd}${conv}`;
}

/** The prompt mode a new session starts in: build mode only when it is a
 *  drive-to-green session whose gate is live — an auto gate in a workspace with
 *  no code starts DORMANT, so the session starts as an assistant. */
function initialPromptMode(cfg: ISessionConfig): PromptMode {
  if (cfg.executionMode !== DRIVE_MODE) {
    return "chat";
  }

  return startsDormant(cfg) ? "chat" : DRIVE_MODE;
}

/** An AUTO gate (no explicit runner) in a workspace with no JS/TS code: nothing
 *  for the strict TypeScript gate to check, so it waits for code. `accept` is
 *  NOT consulted: alongside `autoGate` it is only the auto gate's initially
 *  resolved command (the REPL passes both), not a user-chosen gate. */
function startsDormant(cfg: ISessionConfig): boolean {
  return (
    cfg.gate === undefined &&
    cfg.autoGate !== undefined &&
    !workspaceHasCode(cfg.cwd)
  );
}

function systemPrompt(
  cfg: ISessionConfig,
  workspaceMap: string,
  conventions: IConventions,
  decisionBrief: string | null = null
): string {
  const head = promptHead(initialPromptMode(cfg), cfg, conventions);

  const lines = [`Workspace: ${cfg.cwd}`];

  if (cfg.guidance !== undefined && cfg.guidance.length > 0) {
    lines.push(cfg.guidance);
  }

  const prefix = workspaceMap.length > 0 ? `${workspaceMap}\n\n` : "";
  const decisions = decisionBriefBlock(decisionBrief);

  // Which copy wins when history holds two. Superseded reads / checklists are no
  // longer stubbed per turn (that rewrote old messages and cost a cold prefill),
  // so the ordering rule has to be stated — and this is the one place it can sit
  // without ever dirtying the prefix. Same gap as the TDD block above: the
  // interactive path does not go through buildSystemPrompt.
  const freshness = `${buildHistoryFreshnessGuidance()}\n\n`;

  const contract = taskContract(
    cfg.files ?? [],
    cfg.accept,
    isOfferCheckActive(cfg) && initialPromptMode(cfg) === DRIVE_MODE
  );

  return `${head}${freshness}${decisions}${prefix}${lines.join("\n")}\n\n${contract}`;
}

/** The system content minus its VOLATILE blocks, for resume comparison: the
 *  workspace-map staleness line ("Map built <ts>; N file(s) changed since…")
 *  is recomputed from live file hashes — a resumed build has, by construction,
 *  changed files, so it always differs — and the recalled decision brief comes
 *  from an external provider (network-variable, fail-soft to absent). Neither
 *  affects which tools/flags the prompt advertises. */
function stableSystemKey(content: string): string {
  return (
    content
      .replace(/<project-decisions>[\s\S]*?<\/project-decisions>\s*/u, "")
      .replace(/^Map built .*$/mu, "")
      // The delegation roster is INSERTED before the task contract (guide()),
      // not appended — so it breaks the prefix relation between the persisted
      // prompt (which has it) and a fresh rebuild (which doesn't yet; it
      // re-ensures itself after resume). Idempotent by marker either way.
      .replace(/DELEGATION:[\s\S]*?(?:\n+(?=## )|$)/u, "")
  );
}

/** Build the initial message list. A FRESH session gets one freshly-built system
 *  prompt. A RESUMED session (`cfg.history`) keeps its persisted system message
 *  VERBATIM whenever the fresh prompt's stable parts are a prefix of it — the
 *  persisted copy is the fresh prompt plus idempotent appended blocks
 *  (delegation roster, checklist rules) and the possibly-rebuilt task contract,
 *  all of which re-ensure themselves after resume. Keeping the persisted bytes
 *  preserves the SERVER-SIDE prefix cache across `--continue`: the cache
 *  outlives the client process, and unconditionally substituting a rebuilt
 *  string (whose staleness note always differs) cold-prefilled the entire
 *  resumed transcript every time (592ms vs 92,787ms at 130k tokens, measured).
 *
 *  When the stable parts DON'T match — a flag toggled (`offerCheck`,
 *  `pullConventions`), the map rebuilt, conventions changed — the fresh prompt
 *  wins, preserving the flag↔prompt lockstep invariant in both directions.
 *  This assumes `history[0]` is the generated base prompt — true for every
 *  caller here, since `create` always seeds it with `systemPrompt(cfg)` and
 *  later system text is APPENDED, never prepended. */
function resumeMessages(
  cfg: ISessionConfig,
  freshSystem: string
): IChatMessage[] {
  const systemMsg: IChatMessage = { role: "system", content: freshSystem };

  if (cfg.history === undefined || cfg.history.length === 0) {
    return [systemMsg];
  }

  const [first, ...rest] = cfg.history;

  if (first?.role !== "system") {
    return [systemMsg, ...cfg.history];
  }

  const reuse = stableSystemKey(first.content).startsWith(
    stableSystemKey(freshSystem)
  );

  return [reuse ? first : systemMsg, ...rest];
}

/** The highest `revision N` stamped on a checklist snapshot in `history` — the
 *  seed for a resumed session's revision counter (see the constructor). */
function maxChecklistRevision(history: readonly IChatMessage[]): number {
  let max = 0;

  for (const m of history) {
    for (const match of m.content.matchAll(/\(revision (\d+)\)/g)) {
      const n = Number(match[1]);

      if (Number.isFinite(n) && n > max) {
        max = n;
      }
    }
  }

  return max;
}

/** Stable prefix of the delegation block — the sentinel `setDelegation` checks to
 *  stay idempotent across resumed/rebuilt sessions (so the prompt can't grow). */
const DELEGATION_MARKER = "DELEGATION:";

/** The system-prompt block that tells the orchestrator delegation exists and
 *  names the specialists, so it picks the right one without the user ever naming
 *  an agent. Appended (not baked into buildChatSystem) because the roster is
 *  known only after specs load. Starts with {@link DELEGATION_MARKER}. */
function delegationGuidance(specs: readonly IAgentSpec[]): string {
  const roster = specs
    .map((s) =>
      s.description === undefined ? `- ${s.id}` : `- ${s.id}: ${s.description}`
    )
    .join("\n");

  return [
    `${DELEGATION_MARKER} you can hand focused, read-only investigation to specialist subagents with the \`spawn_agent\` tool — exploring an unfamiliar part of the codebase, researching an external API/library, or verifying a claim — instead of spending your own turns and context on it. Spawn several in one turn for independent lines of inquiry; they run in parallel, each with its own context, and only YOU edit files. The user thinks in tasks and features, never in subagents — it is YOUR call when delegation helps. Rule of thumb: skip delegation for a task you can finish inline by reading one or two files you already know — the round-trip costs more than it saves; delegate when the investigation spans an unfamiliar subsystem, needs external docs, or would burn 3+ turns of your own reading.`,
    `Specialists available:\n${roster}`,
  ].join("\n\n");
}

/** Build a synthetic handoff for terminal exits (build-nudge, degeneration,
 *  timeout, readonly-spin, etc.) — a minimal, resumable handoff describing what
 *  a stronger model or human intervention is needed for. */
function buildSyntheticHandoff(
  block: string,
  errors: string[],
  diagnosticNote: string
): IHandoff {
  const ask = buildHandoffAsk(diagnosticNote, errors.slice(0, 3));

  return {
    block,
    rungHistory: [],
    errors: errors.slice(0, 3),
    ask,
    resumable: true,
    resume: { triedLevers: [] },
  };
}

/** Rebuild the dynamic task-contract block (scope + check) from LIVE `ctx.task`.
 *
 *  Replaces ONLY the contract section. The old form truncated everything from
 *  the marker to the END of the system message — deleting any block appended
 *  after it (the `## Active plan rules` text that binds on plan approval).
 *  The next turn re-appended the rules, so with a plan bound and the auto gate
 *  firing every cycle, message 0 OSCILLATED between two byte strings — every
 *  flip invalidating the entire server-side prefix cache (592ms vs 92,787ms
 *  prefill, measured) and dropping/restoring a governance block mid-drive.
 *
 *  Also a strict no-op when the rebuilt content is byte-identical: callers run
 *  on every gate cycle, and an equal-string reassignment should never even
 *  look like a mutation of the prompt prefix. */
function rebuildTaskContract(
  ctx: Pick<ILoopCtx, "messages" | "task">,
  offerCheck = false
): void {
  const system = ctx.messages[0];

  if (system?.role !== "system") {
    return;
  }

  const fresh = taskContract(ctx.task.files, ctx.task.accept, offerCheck);
  const idx = system.content.indexOf(TASK_CONTRACT_MARKER);

  if (idx === -1) {
    system.content = `${system.content}\n\n${fresh}`;

    return;
  }

  // The contract body (Scope:/Check: lines) contains no `## ` headings, so the
  // first heading after the marker starts the NEXT section — keep it and
  // everything that follows, byte-for-byte (including its newline run).
  const afterMarker = system.content.slice(idx + TASK_CONTRACT_MARKER.length);
  const nextSection = /\n+## /.exec(afterMarker);
  const tail = nextSection === null ? "" : afterMarker.slice(nextSection.index);
  const next = `${system.content.slice(0, idx).trimEnd()}\n\n${fresh}${tail}`;

  if (system.content !== next) {
    system.content = next;
  }
}

/** Gate identity for a workspace-container cycle: the packs that actually ran, over the
 *  packages that ran them — without this the failure feedback claims `Packs: (none)`
 *  while the per-package gates were enforcing a full pack set. */
function workspaceProfile(label: string, packs: string[]): IStackProfile {
  return {
    name: `workspace: ${label}`,
    packs,
    confidence: "certain",
    reason: `per-package gates: ${label}`,
  };
}

/** Announce packs that just activated, so the model learns the gate got stricter and
 *  why. Shared by both gate paths (stack re-detection and per-package workspace gates);
 *  silent on the first cycle, when there is no previous pack set to have grown from. */
function notePackActivation(
  ctx: ILoopCtx,
  prevPacks: string[] | null,
  packs: string[]
): void {
  if (prevPacks === null || !packsGrew(prevPacks, packs)) {
    return;
  }

  const activated = newlyActivatedPacks(prevPacks, packs);
  const notice = formatPackActivationNotice(packs, activated);

  ctx.messages.push({ role: "user", content: notice });
  ctx.report({ kind: "tool", task: ctx.task.id, message: notice });
}

/** Build the AUTO-gate runner: a gate that RE-DETECTS the stack each cycle — refreshing
 *  `ctx.task.accept` (run by validate), the stack profile, the task-contract Check:, and
 *  the per-write linter — so a greenfield build enables framework rule-packs once its
 *  package.json lists them. Pack growth injects a Detected packs: notice. It reads the
 *  shared `active` flag; `setGate` flips that off so a manual override wins. Returned
 *  alongside its `state` so `Session.create` can hand the flag to the constructor, and kept
 *  module-level so the large factory stays within the complexity budget. */
/** CLI overlays for per-package workspace gate capture. */
function packageGateCaptureFrom(cfg: ISessionConfig): IPackageGateCaptureOpts {
  return {
    ...(cfg.profile !== undefined ? { profile: cfg.profile } : {}),
    ...(cfg.strictFloorOnly === true ? { strictFloorOnly: true } : {}),
  };
}

/** A red gate result for a gate-INTEGRITY violation (the gate itself was
 *  tampered with / downgraded), as opposed to the code under test being red. */
function gateIntegrityRed(key: string, message: string): IValidateResult {
  return {
    passed: false,
    errors: [{ key: `gate-integrity:${key}`, rule: "gate-integrity", message }],
    output: message,
  };
}

/** Indirection so a stale post-`await` read of `state.active` can't be narrowed
 *  to a compile-time literal: `setGate` mutates the SAME `state` object from a
 *  different closure, invisible to this file's control-flow analysis, so a
 *  direct `state.active` read after an `await` looks "always true" to the
 *  checker even though it can genuinely have flipped to `false` by then (the
 *  whole point of the re-check below). A function boundary forces a fresh,
 *  unnarrowed `boolean` read. */
function isGateStillActive(state: { active: boolean }): boolean {
  return state.active;
}

function makeAutoGateRunner(
  ctx: ILoopCtx,
  resolve: NonNullable<ISessionConfig["autoGate"]>,
  parse: ErrorParser | undefined,
  offerCheck = false,
  capture: IPackageGateCaptureOpts = {}
): { runner: IGate; state: { active: boolean } } {
  const state = { active: true };
  let prevPacks: string[] | null = null;
  let workspaceLint: FileLinter | null = null;
  /** True once any cycle gated this cwd as a PACKAGE (non-container) — the
   *  container-flip floor: deleting the root package.json mid-session must not
   *  downgrade a real package gate to the container skip. */
  let wasPackageGate = false;
  /** Frozen per-package policies for workspace fan-out (test cmd + packs). */
  const workspacePolicies = new Map<string, IPackageGatePolicy>();
  /** FG-1: per-child git-state baseline, captured EAGERLY at runner creation
   *  (before the model's first turn — a shell write during turn 1 would
   *  otherwise be baselined away and never gated). Each container cycle diffs
   *  against it so changes written OUTSIDE the edit tools still gate. */
  const gateStartMs = Date.now();
  const dirtyBaseline: Promise<Map<string, string>> | null =
    isWorkspaceContainer(ctx.cwd)
      ? captureDirtyBaseline(listChildPackageRoots(ctx.cwd))
      : null;

  ctx.gate.workspacePolicies = workspacePolicies;
  ctx.gate.workspaceCapture = capture;

  const runner: IGate = {
    async run(cwd, opts) {
      // F19: external plugins are frozen at session start; a mid-session edit of
      // a workspace plugin must hard-fail the gate rather than weaken rules.
      const { assertExternalPacksFrozen } = await import("../rule-packs");

      await assertExternalPacksFrozen();

      // Multi-repo workspace root: gate only packages the model touched — but
      // only while auto-gate is active. `setGate` flips active off; then we
      // honor the manual command via validate (same as non-workspace).
      if (isWorkspaceContainer(cwd) && state.active) {
        if (wasPackageGate) {
          // The cwd HAD a root package.json (this session gated it as a
          // package) and now presents as a container — the root package.json
          // disappeared mid-session. Refusing beats silently downgrading to
          // the container skip, which would green a broken tree.
          return gateIntegrityRed(
            "root-package-json",
            "root package.json disappeared mid-session — the gate will not " +
              "downgrade from a package gate to a workspace-container skip. " +
              "Restore package.json, or start a new session / --continue " +
              "(which re-captures the gate) if the restructuring is intentional."
          );
        }

        // One router for the whole session — each package's eslint engine is
        // rebuilt when packs grow so newly activated frameworks aren't missed.
        workspaceLint ??= makeWorkspaceFileLinter(
          cwd,
          workspacePolicies,
          capture
        );
        ctx.gate.lintFile = workspaceLint;

        // FG-1: union git-detected dirty children into the gate. `touched`
        // records only edit/create TOOL writes — a `sed -i`/script/git-apply
        // change is invisible to it and used to green-skip the whole gate.
        const baseline = await (dirtyBaseline ??
          captureDirtyBaseline(listChildPackageRoots(cwd)));
        const children = listChildPackageRoots(cwd);
        const detection = await detectDirtyPackageRoots(
          children,
          baseline,
          gateStartMs
        );

        await rememberNewChildren(baseline, children);

        const run = await runWorkspaceContainerGate(
          cwd,
          ctx.task,
          ctx.tool.touched ?? [],
          parse,
          {
            ...(opts ?? {}),
            policies: workspacePolicies,
            capture,
            extraPackageRoots: detection.dirty,
          }
        );

        // Re-check: `setGate` may have fired WHILE the awaits above were in
        // flight. A manual override must win — apply nothing from this now-
        // stale resolution and fall through to the manual command below,
        // rather than silently reverting `setGate`'s effect.
        if (!isGateStillActive(state)) {
          return validate(ctx.task, cwd, parse, opts ?? {});
        }

        // Keep `accept` EXECUTABLE: it is persisted and re-run verbatim on
        // --continue / a /clear rebuild, so a display label would run as a
        // command. Only adopt it when something actually GATED — a nothing-
        // changed cycle's vacuous "true" must never replace (and persist over)
        // a real command.
        if (run.label !== "") {
          ctx.task.accept = run.accept;
        }

        rebuildTaskContract(ctx, offerCheck);

        if (run.packs.length > 0) {
          const packs = sortedPacks(run.packs);

          ctx.gate.stackProfile = workspaceProfile(run.label, packs);
          notePackActivation(ctx, prevPacks, packs);
          prevPacks = packs;
        }

        return run.result;
      }

      if (state.active) {
        const r = await resolve();

        // Re-check: `setGate` may have fired WHILE `resolve()` was in flight —
        // its `state.active` read above is now stale. A manual override must
        // win, not get silently reverted by a resolution that started before it.
        if (!isGateStillActive(state)) {
          return validate(ctx.task, cwd, parse, opts ?? {});
        }

        if (r.downgrade !== undefined) {
          // The re-resolved gate fell below the session's stage floor (e.g.
          // tsconfig.json deleted → tsc stage gone). Keep the previous accept
          // command untouched and red the cycle with the explanation.
          return gateIntegrityRed("stage-downgrade", r.downgrade);
        }

        const packs = sortedPacks(r.stackProfile.packs);

        wasPackageGate = true;
        ctx.task.accept = r.command;
        ctx.gate.stackProfile = r.stackProfile;
        rebuildTaskContract(ctx, offerCheck);
        notePackActivation(ctx, prevPacks, packs);
        prevPacks = packs;

        if (r.lintFile !== undefined) {
          ctx.gate.lintFile = r.lintFile;
        }
      }

      return validate(ctx.task, cwd, parse, opts ?? {});
    },
  };

  return { runner, state };
}

/** The Chrome research bridge's tool-context field: `{ browser }` when
 *  TSFORGE_BROWSER is on (process-wide bridge, per-session state), else `{}`. */
async function browserToolField(): Promise<Pick<IToolContext, "browser">> {
  return flags.browser()
    ? { browser: await openBrowserSession(flags.browserPort()) }
    : {};
}

export class Session {
  private readonly provider: IProvider;
  private readonly cfg: ISessionConfig;
  private readonly report: Reporter;
  private tools: (
    | ReturnType<typeof toolsFor>[number]
    | typeof ADD_DEPENDENCY_TOOL
    | NonNullable<ReturnType<typeof buildSpawnAgentTool>>
  )[];
  /** A gate is CONFIGURED (explicit command/runner or the auto gate). Whether it
   *  is LIVE also depends on dormancy — read `hasGate`, not this. */
  private gateConfigured: boolean;
  /** The auto gate saw code once — it stays awake for the rest of the session. */
  private gateAwake = false;
  /** The user explicitly cleared the gate (`/gate ""`) — build-only tools go. */
  private gateCleared = false;
  /** Cached workspace probe (re-run when the touched set grows or it goes stale). */
  private codeProbe: { at: number; touched: number; hasCode: boolean } | null =
    null;
  /** Which mode head the system message currently starts with (null = unknown,
   *  e.g. a resumed transcript from an older prompt layout — never swapped). */
  private promptMode: PromptMode | null = null;
  private promptHeads: Readonly<Record<PromptMode, string>> | null = null;
  /** Current 1-based turn inside the active drive — fed to mid-turn `check` /
   *  `task_complete` gate progress lines so they match settle (not hardcoded 0). */
  private driveTurn = 0;
  /** Shared with the auto-gate runner: while `active`, the runner re-detects the stack
   *  each cycle. `setGate` flips it off — a manual gate override stops re-detection.
   *  Absent when the session has no auto gate. */
  private readonly autoGateState?: { active: boolean };
  private readonly ctx: ILoopCtx;
  private readonly state: ILoopState;
  /** Token usage from the most recent model call — `promptTokens` is the real
   *  size of the context the model last saw (drives the status gauge and, soon,
   *  auto-compaction). */
  private lastUsage?: ITokenUsage;
  /** Running totals behind the `metrics` getter. genMs is the summed generation
   *  time (first-token→end) so the average rate is tokens/total-gen-seconds. */
  private readonly metricsTotals = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    genMs: 0,
    lastTokensPerSecond: 0,
  };
  /** Fast check run every few edits while building (e.g. tsc); "" = off. */
  private incrementalCheck: string;
  /** Per-send thinking override, set from ISendOptions for the duration of a
   *  `send` (cleared after). Lets the design phase think and the implement phase
   *  not. Undefined = fall back to cfg.enableThinking (server default). */
  private activeThinking?: boolean;
  /** ADAPTIVE THINKING: true while the model has outstanding errors to fix (an
   *  interim check or the gate came back RED). Measured: ~80% of build time is
   *  REPAIR, and thinking-OFF repair oscillates and never converges (churns to the
   *  turn cap), while thinking-ON repair converges. So we think ONLY while
   *  repairing — fast thinking-off creation, convergent thinking-on repair. */
  private repairing = false;
  /** GENERAL plan mode: read-only exploration until the user approves a plan.
   *  Mirrors into ctx.tool.readOnly (the execute-layer guarantee) and filters the
   *  advertised tool list per call — `this.tools` itself is never mutated, so
   *  toggling off restores everything with zero bookkeeping. */
  private planMode = false;
  /** GREENFIELD planning discovery: a transient state distinct from `planMode`
   *  (pre-approval discovery for a NEW product, not read-only exploration of an
   *  existing one). Filters `propose_product_plan` into the advertised set per
   *  call, same "this.tools never mutated" posture as planMode. Set/cleared by
   *  `setGreenfieldMode` — never a second `Session.create()`. */
  private greenfieldMode = false;
  /**
   * Set when Phase B continues after GREEN with an open checklist — the next
   * driveInner iteration must reset readonly-spin counters (fresh item work).
   */
  private checklistContinuePending = false;
  /** The policy mode to fall back to when plan mode is OFF — from CLI/config
   *  (wired in `create`), default `"default"`. Plan mode overrides it with
   *  `"plan"`; toggling plan off restores THIS, not a hard `"default"`. */
  private baseMode: PolicyMode = "default";
  /** Attach PLAN_MODE_NOTE to the NEXT send only (not every revision reply). */
  private planIntroPending = false;
  /** Session-bound checklist plan id (`.tsforge/worklist/plans/<id>.json`). */
  private activePlanId: string | null = null;

  /** Monotonic stamp on appended checklist snapshots. Superseded copies stay in
   *  history until compaction, so the live one must be identifiable on sight. */
  private checklistRevision = 0;
  /** Last present_plan proposal — bound on approve; not on disk until then. */
  private pendingPlan: IPlanDocument | null = null;
  /** Mid-session turn-cap override (setMaxTurns) — a web scaffold raises it. */
  private maxTurnsOverride?: number;
  /** TTSR manager (built-in + project + memory-learned rules). Null when TTSR is
   *  disabled. Built in `create` (needs async rule loading). */
  private ttsrManager: TtsrManager | null = null;
  /** Events of the CURRENT send (reset each drive), buffered off ctx.report so the
   *  post-send memory hook can mine the run for failure→fix lessons. */
  private readonly sendEvents: ILoopEvent[] = [];
  /** After a readonly-spin re-steer: next askModel offers only create/edit/edit_lines. */
  private forceWriteTools = false;
  /** Live `check` tool is offered (drive-to-green + cfg.offerCheck) — keeps the
   *  task-contract Check: line aligned with toolsFor when the auto-gate refreshes. */
  private readonly offerCheckActive: boolean;
  /** Optional pluggable decision-memory provider (HTTP/MCP). Null when unset. */
  private decisionMemory: IMemoryProvider | null = null;
  /**
   * `providers.memory.autoRetain` — on unless opted out. After a green send,
   * extract durable product/architecture decisions (never the raw prompt).
   */
  private autoRetain = true;
  /** Last user send text — fed to the decision extractor after a green send. */
  private lastUserPrompt = "";

  private constructor(
    cfg: ISessionConfig,
    ctx: ILoopCtx,
    autoGateState?: { active: boolean }
  ) {
    this.provider = cfg.provider;
    this.cfg = cfg;
    this.report = cfg.report ?? ((): void => undefined);
    this.autoGateState = autoGateState;
    this.gateConfigured =
      cfg.gate !== undefined ||
      cfg.autoGate !== undefined ||
      (cfg.accept !== undefined && cfg.accept.length > 0);
    this.incrementalCheck = cfg.incrementalCheck ?? "";

    // Seed the auto-compaction gauge from the persisted session so the FIRST
    // resumed send can proactively compact a near-full transcript (see
    // ISessionConfig.lastPromptTokens).
    if (cfg.lastPromptTokens !== undefined && cfg.lastPromptTokens > 0) {
      this.lastUsage = {
        promptTokens: cfg.lastPromptTokens,
        completionTokens: 0,
        totalTokens: cfg.lastPromptTokens,
      };
    }

    // Start with the 4 BASE tools (read/run/edit/create). Measured: the bigger
    // 11-tool list pushes this model onto a malformed-tool-call boundary (it
    // emits unparseable formats the server leaves in content) — see
    // malformed-toolcall-format. The base tools are enough to work a repo; the
    // LSP nav set can become an opt-in once we confirm it parses cleanly here.
    // Interactive sessions also get `search` (ripgrep): it's read-only, needs
    // no tsconfig, and is the plan-mode explorer's main tool besides `read`.
    // Headless/eval sessions keep the measured base set (see
    // lsp-tools-regress-scratch: nav tools hurt from-scratch builds).
    // `check` (WS-G): offered only when the build BACKEND opts in (`cfg.offerCheck`).
    // The boringstack build injects its authoritative gate per-slice via `setGate`
    // (not at construction), so this is an explicit flag, not `cfg.gate !== undefined`
    // (which is still undefined here). A plain eval/scratch task leaves it off — its
    // acceptance set can be empty, so a callable gate would answer vacuously.
    // Requires drive-to-green: only that base prompt is check-aware, and toolsFor must
    // not advertise check in a chat session whose prompt would omit + contradict it.
    // (`resumeMessages` keeps the persisted prompt in lockstep with this on resume, so
    // the advertised tool set and the prompt can never disagree in either direction.)
    // C3: the checklist snapshot revision counter is in-memory; a resumed
    // history already contains snapshots stamped `revision N`. Starting back
    // at 0 made the next change stamp `revision 1`, and the HISTORY FRESHNESS
    // rule then pointed the model at the STALE higher-numbered tree for the
    // next N changes. Seed from the highest revision already in history.
    this.checklistRevision = maxChecklistRevision(cfg.history ?? []);

    const offerCheck = isOfferCheckActive(cfg);

    this.offerCheckActive = offerCheck;
    // pull_conventions is offered only when the capability is on AND a provider is
    // actually injected — advertising a knowledge tool with no knowledge base would
    // promise a topic listing the dispatch can't deliver ("no convention library"),
    // and its free-form schema falsely implies unknown topics return valid ones. The
    // topic enum is then built from the injected provider's real topics() at offer
    // time (stack-agnostic — core carries no topic literal).
    const offerConventions = conventionsOffered(cfg);
    const conventionTopics =
      offerConventions && cfg.conventions !== undefined
        ? cfg.conventions.topics()
        : [];

    // Co-pilot tools are independent of policy `interactive` (#298). REPL passes
    // humanPresent / offerTaskTools / offerPresentPlan; offeredToolsFor still
    // withholds task_* until activePlanId and present_plan outside plan mode.
    this.tools = toolsFor(
      false,
      {},
      offerConventions,
      offerCheck,
      cfg.humanPresent === true,
      conventionTopics,
      cfg.offerTaskTools === true,
      cfg.offerPresentPlan === true,
      cfg.offerProductPlan === true
    );

    this.ctx = ctx;

    // `check` tool seam — only when offerCheck (do not enable via hasGate alone).
    // Reads `this.ctx` LAZILY so a mid-build `setGate` swap is honored.
    if (offerCheck) {
      this.ctx.tool.runCheck = () => runCheckGate(this.ctx, this.driveTurn);
    }

    // Checklist complete seam — separate from `check` so a gate for task_complete
    // does not advertise/enable the model's on-demand check tool.
    if (this.hasGate) {
      this.ctx.tool.runTaskGate = () => runCheckGate(this.ctx, this.driveTurn);
    }

    // `--continue` used to revive contentMeta stubs; scrub before first call.
    scrubLegacyWriteArgStubs(this.ctx.messages);

    if (typeof cfg.activePlanId === "string" && cfg.activePlanId.length > 0) {
      this.activePlanId = cfg.activePlanId;
      this.ctx.tool.activePlanId = cfg.activePlanId;
      this.refreshChecklistContract();
    }

    if (cfg.onPlanChanged !== undefined) {
      this.ctx.tool.onPlanChanged = cfg.onPlanChanged;
    }

    this.ctx.tool.onPlanPresented = (plan) => {
      this.pendingPlan = plan;
      cfg.onPlanPresented?.(plan);
    };

    // create() already resolved the base mode (CLI > config > default) onto ctx.
    this.baseMode = ctx.tool.policyMode ?? "default";
    this.ctx.tool.policyMode = this.planMode ? "plan" : this.baseMode;
    // Buffer events off ctx.report (where edit/create/validated flow) so the
    // post-send memory hook can mine them; still forward to the original reporter.
    const rawCtxReport = ctx.report;

    this.ctx.report = (event) => {
      this.sendEvents.push(event);
      rawCtxReport(event);
    };

    this.state = {
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
      // Same signal as the pull_conventions tool: push + pull activate together.
      conventionsEnabled: cfg.pullConventions === true,
      // Carried across a Session rebuild (e.g. /clear) so a still-unvalidated pre-pause
      // edit is gated by the first send of the new session, not silently dropped (WS-C).
      ...(cfg.pausedWithEdit === true ? { pausedWithEdit: true } : {}),
    };
  }

  /** Build a session (async because it spins up the TS LanguageService). */
  static async create(rawCfg: ISessionConfig): Promise<Session> {
    const cfg = withDefaultHouseConventions(rawCfg);
    const task: ITask = {
      id: SESSION_ID,
      accept: cfg.accept ?? "",
      files: cfg.files ?? [],
      context: cfg.context,
      fix: cfg.fix,
    };

    const report = cfg.report ?? ((): void => undefined);
    // Same stack + tsforge.config.json resolution as the eval path
    // (resolveStackForRun in run.ts) — interactive users get identical
    // pack selection and rule-severity overrides.
    const detected = await detectStack(cfg.cwd);
    const projectConfig = withProfileOverride(
      await loadTsforgeConfig(cfg.cwd),
      cfg.profile
    );
    // Base policy mode + rules: CLI (`--policy-mode` via cfg) wins over the
    // config file's `policy.mode`, else `"default"`. Plan mode overrides this
    // base at runtime (setPlanMode).
    const baseMode = cfg.policyMode ?? projectConfig.policy?.mode ?? "default";
    // Config rules (tsforge.config.json) + rules INJECTED by the build backend, appended so
    // both apply (deny-first evaluation means an injected deny still wins). A backend can thus
    // forbid commands the model must never run without editing the user's config.
    const policyRules = mergePolicyRules(
      projectConfig.policy?.rules,
      cfg.policyRules
    );
    const activePacks = resolveActivePacks(detected.packs, projectConfig);
    // Opt-in: load rule packs from external plugins and fold their ids into the
    // active packs so the gate runs them. A configured plugin that registers no
    // pack throws here: starting the session anyway would run a rule set weaker
    // than the project declared, with only a report line to say so.
    const externalPackIds =
      projectConfig.plugins === undefined
        ? []
        : await loadAndRegisterPlugins(
            projectConfig.plugins,
            cfg.cwd,
            (message) => {
              report({ kind: "tool", task: SESSION_ID, message });
            }
          );
    const stackProfile = {
      ...detected,
      packs:
        externalPackIds.length > 0
          ? [...activePacks, ...externalPackIds]
          : activePacks,
    };
    const ruleOverrides = normalizeRuleOverrides(projectConfig);

    // Opt-in: connect any configured MCP servers so their tools are offered to
    // the agent — the global registry (`~/.tsforge/models.json`) merged with this
    // project's `tsforge.config.json` (project entries win on a name collision). A
    // bad server is reported and skipped (connectMcpServers never throws), so MCP
    // can never block an interactive session from starting.
    const globalMcpServers = await loadGlobalMcpServers();
    const mergedMcpServers = mergeMcpServers(
      globalMcpServers,
      projectConfig.mcpServers ?? {}
    );
    const mcpRegistry =
      Object.keys(mergedMcpServers).length === 0
        ? null
        : await connectMcpServers(mergedMcpServers, (message) => {
            report({ kind: "tool", task: SESSION_ID, message });
          });

    // Opt-in Chrome research bridge (TSFORGE_BROWSER). One server per process —
    // a /clear rebuild reuses it. Tools are advertised by setBrowserCapability.
    const browserField = await browserToolField();

    // Opt-in decision memory (HTTP/MCP). Fail-soft: missing/down backend → null brief.
    const { provider: decisionMemory, brief: decisionBrief } =
      await loadDecisionMemoryAtStart(
        cfg.cwd,
        projectConfig.providers?.memory,
        mcpRegistry,
        report,
        SESSION_ID
      );

    // Persisted workspace map (from `/map`), if any — primes the agent with the
    // repo's structure. Cheap: loads + marks drift, never rebuilds here.
    const workspaceMap = await recallMapBlock(cfg.cwd);

    const conventions = resolveConventions(projectConfig.conventions);

    // Write-time eslint moat. The interactive CLI passes its own `lintFile`; an
    // autonomous `drive-to-green` build gets one built from the DETECTED stack here
    // (headless-build needn't know the stack) so `as`/`!`/`any` surface per-write —
    // in seconds — instead of only at the ~90s gate. STRICT_CONFIG carries the moat.
    const lintFile =
      cfg.lintFile ??
      (cfg.executionMode === DRIVE_MODE
        ? makeFileLinter(
            "core",
            cfg.cwd,
            stackProfile.packs,
            Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
            conventions
          )
        : undefined);

    const ctx: ILoopCtx = {
      task,
      cwd: cfg.cwd,
      tsService: await buildTsService(cfg.cwd),
      report,
      tool: {
        touched: new Set<string>(cfg.touched ?? []),
        policyMode: baseMode,
        ...(cfg.extraRoots !== undefined && cfg.extraRoots.length > 0
          ? { extraRoots: cfg.extraRoots }
          : {}),
        ...(policyRules === undefined ? {} : { policyRules }),
        ...(mcpRegistry === null ? {} : { mcpRegistry }),
        ...browserField,
        ...(cfg.editGuard === undefined ? {} : { editGuard: cfg.editGuard }),
        // A real human is present (the interactive REPL) → ask_user can pause for an
        // answer; absent/false ⇒ unattended, ask_user proceeds without hanging. Set
        // `humanPresent`, NOT `interactive` — the latter is a POLICY signal (approval
        // path) and co-pilot presence must not loosen policy verdicts.
        ...(cfg.humanPresent === true || cfg.interactive === true
          ? { humanPresent: true }
          : {}),
        // The adapter's convention library — spread into every IToolContext (so
        // `pull_conventions` reads its guides) and read by the reactive push. Gated on
        // `pullConventions` (the same flag that OFFERS the tool + enables the push), so a
        // hallucinated pull_conventions call when the feature is off finds no provider
        // (returns "not configured"), never a withheld-capability that still executes.
        ...(cfg.pullConventions === true && cfg.conventions !== undefined
          ? {
              conventions: cfg.conventions,
              pulledTopics: new Set<string>(),
            }
          : {}),
      },
      gate: {
        parse: cfg.parse,
        stackProfile,
        ...(cfg.coreFormat === true ? { coreFormat: true } : {}),
        ...(lintFile === undefined ? {} : { lintFile }),
        ...(Object.keys(ruleOverrides).length > 0 ? { ruleOverrides } : {}),
        ...(cfg.metaBaseline === undefined
          ? {}
          : { metaBaseline: cfg.metaBaseline }),
        // Stream the gate's output live (the interactive CLI), so a slow gate
        // (vite build + chromium) shows progress instead of running silently — but
        // filtered so the raw eslint JSON blob never floods the terminal.
        onGateChunk: filterGateStream((text) => {
          report({ kind: "token", task: SESSION_ID, message: text });
        }),
        runner: cfg.gate ?? commandGate(task, cfg.parse),
      },
      messages: resumeMessages(
        cfg,
        systemPrompt(cfg, workspaceMap, conventions, decisionBrief)
      ),
    };

    // AUTO gate: swap in a runner that RE-DETECTS the stack each cycle (only when no
    // explicit `gate` was injected). `makeAutoGateRunner` owns the closure; the returned
    // `state` flag is handed to the constructor so `setGate` can flip auto-refresh off.
    let autoGateState: { active: boolean } | undefined;

    if (cfg.gate === undefined && cfg.autoGate !== undefined) {
      const auto = makeAutoGateRunner(
        ctx,
        cfg.autoGate,
        cfg.parse,
        isOfferCheckActive(cfg),
        packageGateCaptureFrom(cfg)
      );

      ctx.gate.runner = auto.runner;
      autoGateState = auto.state;
    }

    const session = new Session(cfg, ctx, autoGateState);

    session.adoptPromptHeads(conventions);
    // Reconcile once at birth: a resumed transcript's saved head, or any drift
    // between the config and the live gate state, is corrected before turn 1.
    session.syncGateMode();

    session.decisionMemory = decisionMemory;
    session.autoRetain = projectConfig.providers?.memory?.autoRetain !== false;

    // Build the TTSR manager (built-in + project + memory-learned rules) so the
    // interactive loop gets the SAME mid-stream guidance the headless loop does —
    // including the failure→fix lessons learned in this repo.
    session.ttsrManager = await initTtsrManager(cfg.cwd, report, SESSION_ID);

    return session;
  }

  /** Record both mode heads and which one the system message starts with, so
   *  the head can be swapped when the gate wakes or is cleared. */
  private adoptPromptHeads(conventions: IConventions): void {
    const heads = {
      [DRIVE_MODE]: promptHead(DRIVE_MODE, this.cfg, conventions),
      chat: promptHead("chat", this.cfg, conventions),
    };
    const system = this.ctx.messages[0]?.content ?? "";

    this.promptHeads = heads;
    this.promptMode = system.startsWith(heads[DRIVE_MODE])
      ? DRIVE_MODE
      : system.startsWith(heads.chat)
        ? "chat"
        : null;
  }

  /** The current gate command (empty when none). */
  /** The last server-reported prompt size (tokens), for persistence: --continue
   *  seeds it back so the FIRST resumed send can proactively compact a near-full
   *  transcript instead of firing blind at full size. 0 = none recorded. */
  get lastPromptTokens(): number {
    return this.lastUsage?.promptTokens ?? 0;
  }

  /** The session's CURRENT policy mode — `plan` while plan mode is on, else the
   *  base mode. Read by the spawn runner so a child inherits the parent's live
   *  mode (B9), not the value captured at REPL start. */
  get effectivePolicyMode(): PolicyMode {
    return this.planMode ? "plan" : this.baseMode;
  }

  get gate(): string {
    return this.ctx.task.accept;
  }

  /** Whether the AUTO gate (stack re-detection) is still driving this session. False for
   *  an explicit/manual gate, and flipped false by `setGate`. The REPL reads it to decide
   *  whether `/clear` re-attaches the auto resolver and whether to persist `auto: true` —
   *  so a manual override is never silently re-armed by a rebuild or a `--continue`. */
  get autoGateActive(): boolean {
    return this.autoGateState?.active ?? false;
  }

  /** The policy posture plan mode toggles OFF to — CLI `--policy-mode` ?? config
   *  `policy.mode` ?? "default". Lets the CLI decide whether a fresh session
   *  should default to plan mode without re-loading the project config. */
  get basePolicyMode(): PolicyMode {
    return this.baseMode;
  }

  /** The editable scope globs. */
  get scope(): string[] {
    return this.ctx.task.files;
  }

  /** Whether the scoped format janitor is on for this session — i.e. `cfg.coreFormat`
   *  was threaded into the loop's gate context. Exposed so a test can prove the CLI
   *  wiring (Session.create propagates the flag) without reaching into private state. */
  get coreFormat(): boolean {
    return this.ctx.gate.coreFormat === true;
  }

  /** True when a still-unvalidated edit is pending behind an ask_user pause (an edit
   *  written before the pause whose gate hasn't run). A caller rebuilding the Session
   *  (e.g. /clear) reads this and passes `pausedWithEdit` to `create` so the deferred
   *  gate survives the rebuild instead of being silently dropped (WS-C). */
  get hasDeferredGate(): boolean {
    return this.state.pausedWithEdit === true;
  }

  /** Relative paths the model wrote this session — persisted for workspace gates. */
  get touchedFiles(): string[] {
    return [...(this.ctx.tool.touched ?? [])].sort();
  }

  /** The session's TS LanguageService (null when the workspace has no tsconfig),
   *  exposed so spawned subagents can reuse it instead of each building their own
   *  (expensive, and it would negate the concurrency win). */
  get tsService(): TsService | null {
    return this.ctx.tsService;
  }

  /** Real token usage of the most recent model call (undefined until the first
   *  call, or if the server reports none). */
  get usage(): ITokenUsage | undefined {
    return this.lastUsage;
  }

  /** Cumulative model-call metrics (tokens + generation rate) for this session. */
  get metrics(): ISessionMetrics {
    const t = this.metricsTotals;

    return {
      calls: t.calls,
      promptTokens: t.promptTokens,
      completionTokens: t.completionTokens,
      avgTokensPerSecond:
        t.genMs > 0 ? Math.round((t.completionTokens / t.genMs) * 1000) : 0,
      lastTokensPerSecond: Math.round(t.lastTokensPerSecond),
    };
  }

  /** Fold one call's usage + generation time into the running metrics totals. */
  private recordUsage(usage: ITokenUsage, genMs: number): void {
    this.lastUsage = usage;
    this.metricsTotals.calls += 1;
    this.metricsTotals.promptTokens += usage.promptTokens;
    this.metricsTotals.completionTokens += usage.completionTokens;
    this.metricsTotals.genMs += genMs;
    this.metricsTotals.lastTokensPerSecond =
      genMs > 0 ? (usage.completionTokens / genMs) * 1000 : 0;
  }

  /** The real size of the context the model is currently holding — the prompt
   *  tokens of the last call (what auto-compaction watches), 0 before any call. */
  get contextTokens(): number {
    return this.lastUsage?.promptTokens ?? 0;
  }

  /** If the held context is at/over the auto-compact threshold, the percent full
   *  (for the notice); otherwise undefined. Needs a known window AND real usage
   *  from a prior turn — both absent on the first send, so it never fires early. */
  private autoCompactPct(): number | undefined {
    if (this.lastUsage === undefined) {
      return undefined;
    }

    return compactThresholdPct(
      this.lastUsage.promptTokens,
      this.cfg.contextWindow ?? 0,
      this.cfg.autoCompactAt ?? AUTO_COMPACT_AT
    );
  }

  /** Compact when over the window threshold; shared by send() and mid-drive turns. */
  private async maybeAutoCompact(signal?: AbortSignal): Promise<void> {
    const pct = this.autoCompactPct();

    if (pct === undefined) {
      return;
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⊙ context ~${pct}% full — auto-compacting to free room`,
    });

    const result = await this.compact(signal);

    // Drop stale usage so the same pre-compact reading cannot re-fire every
    // mid-drive turn before the next model call records a fresh prompt size.
    // This is also what lets a prune-only compact skip the summary: the next
    // real model call re-measures against the server's own token count.
    this.lastUsage = undefined;

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⊙ ${compactSummaryLine(result)}`,
    });
  }

  /** Set (or clear, with "") the gate command mid-session, or swap the composed
   *  gate mid-build (one per unit/feature). For a gate runner, flips hasGate on so
   *  the loop actually runs it and the escalation ladder sees its failures. */
  setGate(arg: string | IGate): void {
    // A manual gate override (a per-slice command or a composed IGate) takes control:
    // stop the auto-gate runner from re-detecting + overwriting `task.accept` each cycle.
    if (this.autoGateState !== undefined) {
      this.autoGateState.active = false;
    }

    if (typeof arg === "string") {
      this.ctx.task.accept = arg;
      this.gateConfigured = arg.length > 0;
    } else {
      this.ctx.gate.runner = arg;
      this.gateConfigured = true;
    }

    this.gateCleared = !this.gateConfigured;

    // Prompt head, check/task_complete seams and task contract follow the gate.
    this.syncGateMode();
  }

  /** The gate is LIVE: configured, and not an auto gate waiting for code. Every
   *  drive-to-green mechanism (settle, near-green, no-tool nudge, forced gates,
   *  readonly write-forcing) keys off this. */
  private get hasGate(): boolean {
    return this.gateConfigured && !this.gateDormant();
  }

  /** An AUTO gate in a workspace with no JS/TS code yet: nothing for the strict
   *  TypeScript gate to check (ESLint on a notes folder is red forever), so the
   *  session behaves as an assistant until code appears — then the gate wakes and
   *  stays awake. Explicit gates are never dormant. */
  gateDormant(): boolean {
    if (
      !this.gateConfigured ||
      this.gateAwake ||
      this.cfg.gate !== undefined ||
      this.cfg.autoGate === undefined ||
      this.autoGateState?.active !== true
    ) {
      return false;
    }

    if (!this.probeCode()) {
      return true;
    }

    this.gateAwake = true;
    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: "gate awake — code detected in the workspace",
    });
    this.syncGateMode();

    return false;
  }

  private probeCode(): boolean {
    const touched = this.ctx.tool.touched?.size ?? 0;
    const now = Date.now();
    const cached = this.codeProbe;

    if (
      cached !== null &&
      cached.touched === touched &&
      now - cached.at < CODE_PROBE_TTL_MS
    ) {
      return cached.hasCode;
    }

    const hasCode = workspaceHasCode(this.ctx.cwd);

    this.codeProbe = { at: now, touched, hasCode };

    return hasCode;
  }

  /** Make the prompt head, the `check`/`task_complete` seams and the task
   *  contract match whether the gate is live. Idempotent. */
  private syncGateMode(): void {
    const suppressed = this.buildModeSuppressed();
    const want: PromptMode =
      !suppressed && this.cfg.executionMode === DRIVE_MODE
        ? DRIVE_MODE
        : "chat";

    this.swapPromptHead(want);

    if (suppressed) {
      delete this.ctx.tool.runTaskGate;
      delete this.ctx.tool.runCheck;
    } else {
      // Restore exactly what construction wires: `check` per offerCheck,
      // task_complete's gate whenever a gate is configured.
      if (this.offerCheckActive) {
        this.ctx.tool.runCheck ??= () => runCheckGate(this.ctx, this.driveTurn);
      }

      if (this.gateConfigured) {
        this.ctx.tool.runTaskGate ??= () =>
          runCheckGate(this.ctx, this.driveTurn);
      }
    }

    this.refreshTaskContract();
  }

  /** Build mode is switched OFF only for an auto gate still waiting for code or
   *  a gate the user cleared. A session that was simply never given a gate
   *  (tests, hosts that attach one per slice) keeps its configured mode. */
  private buildModeSuppressed(): boolean {
    return this.gateCleared || this.gateDormant();
  }

  private swapPromptHead(want: PromptMode): void {
    const from = this.promptMode;
    const heads = this.promptHeads;
    const system = this.ctx.messages[0];

    if (from === null || from === want || heads === null) {
      return;
    }

    if (system?.role !== "system" || !system.content.startsWith(heads[from])) {
      this.promptMode = null;

      return;
    }

    system.content = heads[want] + system.content.slice(heads[from].length);
    this.promptMode = want;
  }

  /** Set the per-feature expert rescue target — the editable file the expert repairs
   *  when a stall's errors are all out of the model's scope (e.g. the resource service
   *  file). Cleared with "". Threaded to the loop via `ctx.gate.expertRescueTarget`. */
  setExpertRescueTarget(file: string): void {
    this.ctx.gate.expertRescueTarget = file.length > 0 ? file : undefined;
  }

  /** Raise/lower the per-send turn cap mid-session — `scaffold_web` flips a chat
   *  session into a from-scratch web build, whose heavy gate needs the bigger
   *  webMaxTurns budget (0/undefined restores the config default). */
  setMaxTurns(n?: number): void {
    this.maxTurnsOverride = n !== undefined && n > 0 ? n : undefined;
  }

  /**
   * Capture pristine meta-rule violations to subtract later. Workspace containers
   * fan out per child package (with that package's packs/overrides) so pre-existing
   * child debt is suppressed the same way a single-repo scaffold is.
   * Call ONCE before any model work. Empty `changed` ⇒ only global rules seed it.
   */
  async captureMetaBaseline(): Promise<void> {
    try {
      if (isWorkspaceContainer(this.ctx.cwd)) {
        await this.captureWorkspaceMetaBaselines();

        return;
      }

      const metaContext = buildMetaRuleContext(
        this.ctx.cwd,
        this.ctx.gate.stackProfile?.packs ?? [],
        []
      );
      const violations = runMetaRules(
        META_RULES,
        metaContext,
        this.ctx.gate.ruleOverrides
      );

      this.ctx.gate.metaBaseline = buildMetaBaseline(violations);
    } catch {
      // Supplementary to the gate — never crash the build over baseline capture.
    }
  }

  /** Per-child meta baselines for a workspace container. */
  private async captureWorkspaceMetaBaselines(): Promise<void> {
    const capture = this.ctx.gate.workspaceCapture ?? {};
    const policies =
      this.ctx.gate.workspacePolicies ?? new Map<string, IPackageGatePolicy>();

    this.ctx.gate.workspacePolicies = policies;

    const baselines = new Map<string, ReturnType<typeof buildMetaBaseline>>();

    for (const pkg of listChildPackageRoots(this.ctx.cwd)) {
      let policy = policies.get(pkg);

      if (policy === undefined) {
        policy = await capturePackageGatePolicy(pkg, capture);
        policies.set(pkg, policy);
      }

      const violations = runMetaRules(
        META_RULES,
        buildMetaRuleContext(pkg, packageLintPacks(policy), []),
        policy.ruleOverrides
      );
      const label = packageLabel(pkg);
      const relocated = violations.map((v) => ({
        ...v,
        file: join(label, v.file.replace(/^\.\//u, "")).replaceAll("\\", "/"),
      }));

      baselines.set(pkg, buildMetaBaseline(relocated));
    }

    this.ctx.gate.workspaceMetaBaselines = baselines;
  }

  /** Toggle GENERAL plan mode: read-only tools + the plan-then-approve workflow.
   *  ON ⇒ the next send carries PLAN_MODE_NOTE, the advertised tools shrink to
   *  the read-only set, and the execute layer rejects any mutating call. */
  setPlanMode(on: boolean): void {
    this.planMode = on;
    this.ctx.tool.readOnly = on; // the hard guarantee at the execute layer
    // Plan forces the read-only policy mode; toggling off restores the base mode
    // (e.g. an explicit --policy-mode ci), not a hard reset to "default".
    this.ctx.tool.policyMode = on ? "plan" : this.baseMode;
    this.planIntroPending = on;
  }

  /** Toggle GREENFIELD planning discovery for the CURRENT send — distinct from
   *  `setPlanMode` (read-only exploration of an EXISTING codebase). ON wires
   *  `propose_product_plan`'s validator + proposal callback onto the ambient
   *  tool context and advertises the tool; OFF clears both. Never a second
   *  `Session.create()` — same live session, same TUI, just a transient flag,
   *  so runGreenfieldPlanning can safely call this per-send without recreating
   *  session state (deferred gates, plan mode, activePlanId, …). */
  setGreenfieldMode(
    on: boolean,
    hooks?: {
      readonly validate: IToolContext["productPlanValidate"];
      readonly onProposed: IToolContext["onProductPlanProposed"];
    }
  ): void {
    this.greenfieldMode = on;
    this.ctx.tool.productPlanValidate = on ? hooks?.validate : undefined;
    this.ctx.tool.onProductPlanProposed = on ? hooks?.onProposed : undefined;
    // Same hard guarantee setPlanMode gives GENERAL plan mode — mutating tools
    // are rejected at dispatch even on a salvaged/forced call, not just
    // withheld from advertisement. OR with planMode so turning greenfield off
    // never clobbers a separately-active plan mode's guarantee.
    this.ctx.tool.readOnly = on || this.planMode;
  }

  /** Bind this session to a plan file id (after approve or `--continue`). Offers
   *  task_* tools and refreshes the system checklist block. */
  setActivePlanId(planId: string | null): void {
    this.activePlanId = planId;
    this.ctx.tool.activePlanId = planId;
    this.refreshChecklistContract();
  }

  /** Merge extra deny/allow/ask rules (Phaser build deny of vite/playwright). */
  appendPolicyRules(rules: IPolicyRules): void {
    this.ctx.tool.policyRules = mergePolicyRules(
      this.ctx.tool.policyRules,
      rules
    );
  }

  /** Session-bound plan id, or null when none approved yet. */
  getActivePlanId(): string | null {
    return this.activePlanId;
  }

  /** Wire the Tasks-rail refresh callback (REPL). */
  setOnPlanChanged(fn: ((plan: IPlanDocument) => void) | undefined): void {
    this.ctx.tool.onPlanChanged = fn;
  }

  /** Wire the present_plan UI callback (REPL). Keeps pendingPlan in sync. */
  setOnPlanPresented(fn: ((plan: IPlanDocument) => void) | undefined): void {
    this.ctx.tool.onPlanPresented = (plan) => {
      this.pendingPlan = plan;
      fn?.(plan);
    };
  }

  /** Wire the Gate-rail refresh callback (REPL). */
  setOnGateChanged(fn: ((view: IGateRailView) => void) | undefined): void {
    this.ctx.tool.onGateChanged = fn;
  }

  /** Read-only gate rail snapshot from loop state. */
  gateRailView(): IGateRailView {
    return gateRailViewFromState(this.state, this.gate.trim().length > 0);
  }

  /** Last present_plan proposal, if any (not yet approved). */
  getPendingPlan(): IPlanDocument | null {
    return this.pendingPlan;
  }

  /** Harness-authored proposal (greenfield product plan) — same pending slot as present_plan. */
  presentHarnessPlan(plan: IPlanDocument): void {
    this.ctx.tool.onPlanPresented?.(plan);
  }

  /** Take and clear the pending proposal (approve path). */
  takePendingPlan(): IPlanDocument | null {
    const plan = this.pendingPlan;

    this.pendingPlan = null;

    return plan;
  }

  /**
   * Append the live plan tree when — and only when — it has changed.
   *
   * This block used to be spliced into the SYSTEM message. That put the live
   * task statuses at byte one of the prompt, so every `task_focus` /
   * `task_complete` rewrote index 0 and threw away the WHOLE prefix cache:
   * measured on the Spark box at 130k tokens, an unchanged-prefix turn prefills
   * in 592ms and a one-checkbox change in 92,787ms. Appending keeps the prefix
   * byte-identical, so an unchanged turn stays a cache hit and a changed turn
   * only prefills the new snapshot.
   *
   * Unchanged trees append nothing, so history does not fill with one copy per
   * turn. Superseded snapshots are dropped at compaction, where the prefix is
   * rebuilt anyway; until then the `revision N` stamp marks the live one.
   */
  private refreshChecklistContract(): void {
    if (this.activePlanId === null) {
      return;
    }

    this.ensureChecklistRulesInSystem();

    const block = this.checklistContractText();

    if (block.length === 0) {
      return;
    }

    for (let i = this.ctx.messages.length - 1; i >= 0; i -= 1) {
      const m = this.ctx.messages[i];

      if (m !== undefined && isChecklistSnapshot(m)) {
        // Compare the TREE only: the revision line differs by construction, so
        // including it would make every check look like a change.
        if (treeOf(m.content) === treeOf(block)) {
          return;
        }

        break;
      }
    }

    // Superseded snapshots stay until compaction (removing them here would
    // rewrite an old message and cost a cold prefill), so the live one has to be
    // identifiable on sight. The system block tells the model highest wins.
    this.checklistRevision += 1;

    const stamped = this.checklistContractText();

    // Land the snapshot BEFORE any trailing human turn, so the request stays the
    // last thing the model reads — appending after it buried the ask under a
    // checklist and changed how the model answered. Splicing at the tail rewrites
    // only that final message, which the cache serves for next to nothing; it is
    // the PREFIX that must not move.
    let at = this.ctx.messages.length;

    while (at > 0) {
      const prev = this.ctx.messages[at - 1];

      // Stop at an earlier snapshot: crossing one would place a NEWER revision
      // before an older one, and "later wins" has to hold by position too.
      if (prev?.role !== "user" || isChecklistSnapshot(prev)) {
        break;
      }

      at -= 1;
    }

    this.ctx.messages.splice(at, 0, { role: "user", content: stamped });
  }

  private checklistContractText(): string {
    if (this.activePlanId === null) {
      return "";
    }

    const plan = loadPlan(this.cfg.cwd, this.activePlanId);

    if (plan === null) {
      return "";
    }

    // ONLY the volatile tree. The rules that govern it are invariant, so they
    // live in the system block (written once, never rewritten) where they keep
    // system-level authority — a governance rule demoted to a user turn is a
    // weaker instruction, and there is no cache reason to move it.
    return [
      `${CHECKLIST_CONTRACT_MARKER} (revision ${String(this.checklistRevision)})`,
      formatPlanTree(plan),
    ].join("\n");
  }

  /** The invariant half of the checklist contract — safe to sit in SYSTEM. */
  private static checklistRulesText(): string {
    return [
      "## Active plan rules",
      "Checklist changes ONLY via task_list / task_focus / task_complete / task_uncomplete / task_add / task_update.",
      "Living plan: if you discover missing work (yours or the human's), task_add it — do not leave it only in chat.",
      "If an item's scope/title/detail drifts, task_update; if done work must be redone, task_uncomplete.",
      "When the session has a code gate, task_complete runs it — an item can be done only when the gate is green, and finished requires gate green AND every item done.",
      "With no code gate (research, notes, non-code work), task_complete just records the item done; finished means every item done.",
    ].join("\n");
  }

  /**
   * Write the invariant checklist rules into SYSTEM once, when a plan binds.
   * Constant text, so it never dirties the prefix again after this.
   */
  private ensureChecklistRulesInSystem(): void {
    const system = this.ctx.messages[0];

    if (system?.role !== "system") {
      return;
    }

    const rules = Session.checklistRulesText();

    if (!system.content.includes(rules)) {
      system.content = `${system.content}\n\n${rules}`;
    }
  }

  /** Keep the system checklist live; never append another full tree into history. */
  private injectPlanTree(): void {
    this.refreshChecklistContract();
  }

  /** True when a bound plan still has open nodes (blocks claiming finished). */
  private checklistBlocksFinish(): {
    block: true;
    openCount: number;
    calledTaskComplete: boolean;
  } | null {
    if (this.activePlanId === null) {
      return null;
    }

    const plan = loadPlan(this.cfg.cwd, this.activePlanId);

    if (plan === null || isChecklistComplete(plan)) {
      return null;
    }

    return {
      block: true,
      openCount: countOpen(plan.items),
      calledTaskComplete: this.calledTaskCompleteThisSend(),
    };
  }

  /** Whether task_complete ran during this send (scan buffered tool events). */
  private calledTaskCompleteThisSend(): boolean {
    return this.sendEvents.some(
      (e) =>
        e.kind === "tool" &&
        typeof e.message === "string" &&
        (e.message.startsWith("done ·") ||
          e.message.startsWith("gate · checking"))
    );
  }

  /**
   * After a green settle: if the bound checklist is still open, inject a nudge
   * and keep driving (Phase B — finished = gate green AND plan done).
   */
  private continueIfChecklistOpen(
    settled: ISendResult
  ): ISendResult | "continue" {
    if (settled.status !== "done") {
      return settled;
    }

    const block = this.checklistBlocksFinish();

    if (block === null) {
      return settled;
    }

    this.ctx.messages.push({
      role: "user",
      content: checklistOpenNudge({
        openCount: block.openCount,
        calledTaskComplete: block.calledTaskComplete,
      }),
    });
    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⊙ gate green — checklist still open (${String(block.openCount)} item(s)); continuing`,
    });
    // Fresh exploration budget for the next checklist item — do not inherit a
    // near-limit readonly streak (or force-write) from the turns that just went green.
    this.checklistContinuePending = true;
    this.forceWriteTools = false;

    return "continue";
  }

  /** Set (or clear, with "") the auto-fix command run before each gate — e.g. a
   *  scaffold's `eslint --fix`, so mechanical lint violations are squashed
   *  deterministically instead of costing the model turns. */
  setFix(command: string): void {
    this.ctx.task.fix = command.length > 0 ? command : undefined;
  }

  /** Set (or clear, with "") the fast incremental check (e.g. `tsc --noEmit`) run
   *  every few edits while building, so errors surface early instead of piling up. */
  setIncrementalCheck(command: string): void {
    this.incrementalCheck = command;
  }

  /** Wire the PER-WRITE lint moat — the gate's eslint rules applied to each file
   *  AS it's written, so `as`-casts, no-jsx-computation, hooks-in-component-body,
   *  component-folder-structure, etc. surface immediately instead of as an
   *  end-of-turn pile-up. The interactive session was missing this (only headless
   *  builds wired it), so a whole web app's worth of violations dumped at the gate.
   *  Used at create and when `scaffold_web` flips a session to the web stack. */
  setLintFile(lintFile: FileLinter | undefined): void {
    this.ctx.gate.lintFile = lintFile;
  }

  /** Rebuild the in-process TS LanguageService. `scaffold_web` creates the
   *  project's tsconfig + node_modules AFTER the (empty-dir) session was created,
   *  so the service built at create time is empty/null and the per-write guard —
   *  which holds BOTH the tsc diagnostics AND the eslint lint moat — was skipped
   *  for the whole web build (`tsService !== null` was false). Rebuilding here
   *  makes per-write feedback actually fire in web sessions, matching headless. */
  async refreshTsService(): Promise<void> {
    // Dispose the old service first — it holds program/document-registry refs
    // that would otherwise leak when we drop the reference.
    this.ctx.tsService?.dispose();
    this.ctx.tsService = await buildTsService(this.ctx.cwd);
  }

  /** Replace the editable scope globs mid-session. Also refreshes the system
   *  message's task contract so the prompt reflects the NEW scope on the very next
   *  model call (not the whole-repo scope it was created with). */
  setScope(globs: string[]): void {
    this.ctx.task.files = globs;
    this.refreshTaskContract();
  }

  /** Rebuild the dynamic task-contract block (scope + check) from the LIVE
   *  `ctx.task`, replacing the old block in place. The static policy above the
   *  marker is untouched. No system message yet (shouldn't happen) ⇒ no-op. */
  private refreshTaskContract(): void {
    rebuildTaskContract(
      this.ctx,
      this.offerCheckActive && !this.buildModeSuppressed()
    );
  }

  /** Update the context window mid-session (e.g. after a `/model` hot-swap to a
   *  model with a different window). Without this, `autoCompactPct()` keeps using
   *  the original window, so switching to a SMALLER model would compact too late
   *  and overflow it — even though the status bar already shows the new size. */
  setContextWindow(window: number): void {
    this.cfg.contextWindow = window;
  }

  /** Enable model-driven delegation: offer the `spawn_agent` tool (its
   *  `subagent_type` enum built from the available specialists), wire the runner
   *  callback, and tell the model it can delegate. Late-bound (after create)
   *  because the callback is built by the CLI, which owns model resolution and
   *  the concurrency limiter. No specs ⇒ no-op (nothing to delegate to). */
  setDelegation(specs: readonly IAgentSpec[], fn: SpawnAgentFn): void {
    const tool = buildSpawnAgentTool(specs);

    if (tool === null) {
      return;
    }

    this.ctx.tool.spawnAgent = fn;

    // Idempotent: setDelegation runs on EVERY REPL launch, and a resumed
    // (`--continue`) session reuses persisted history whose system message
    // already carries the guidance. Re-adding the tool or re-appending the block
    // would duplicate them (the prompt would grow each launch). Guard on the
    // tool name and the guidance marker so a rebuilt/fresh session gets them once.
    if (!this.tools.some((t) => t.function.name === tool.function.name)) {
      this.tools = [...this.tools, tool];
    }

    const system = this.ctx.messages[0];

    if (!(
      system?.role === "system" && system.content.includes(DELEGATION_MARKER)
    )) {
      this.guide(delegationGuidance(specs));
    }
  }

  /** Offer the image tools when their capability backends are configured. Called
   *  on REPL launch after capabilities are resolved; idempotent (a resumed session
   *  re-runs it) — mirrors setDelegation's guard so the tool list can't grow on
   *  each launch. `read_image` needs vision, `generate_image` needs imageGen. */
  setImageCapabilities(caps: { vision: boolean; imageGen: boolean }): void {
    const add = [
      ...(caps.vision ? [READ_IMAGE_TOOL] : []),
      ...(caps.imageGen ? [GENERATE_IMAGE_TOOL] : []),
    ];

    for (const tool of add) {
      if (!this.tools.some((t) => t.function.name === tool.function.name)) {
        this.tools = [...this.tools, tool];
      }
    }
  }

  /** Turn on the git/GitHub first-class tools when the `github` capability is
   *  present (gh installed + authenticated). Advertises the three tools, records
   *  consent on the tool context (the WRITE handlers hard-check `ctx.tool.github`),
   *  and appends the drive-loop guidance to the system prompt ONCE. Idempotent —
   *  a resumed session re-runs it; guards mirror setImageCapabilities/setDelegation. */
  setGithubCapability(on: boolean): void {
    if (!on) {
      return;
    }

    this.ctx.tool.github = true;

    for (const tool of [GITHUB_READ_TOOL, GIT_WRITE_TOOL, GITHUB_WRITE_TOOL]) {
      if (!this.tools.some((t) => t.function.name === tool.function.name)) {
        this.tools = [...this.tools, tool];
      }
    }

    const system = this.ctx.messages[0];

    if (!(
      system?.role === "system" && system.content.includes(GITHUB_MARKER)
    )) {
      this.guide(GITHUB_DRIVE_GUIDANCE);
    }
  }

  /** Turn on the Linear verbs when a `linear` MCP server is connected (and the
   *  kill-switch is unset). Resolves the capability from THIS session's registry,
   *  advertises the three verbs, records consent on the tool context (the WRITE
   *  handlers hard-check `ctx.tool.linear`), and appends the drive guidance once.
   *  Idempotent — mirrors setGithubCapability. Returns whether it turned on (for the
   *  boot banner). */
  setLinearCapability(): boolean {
    const on = resolveLinearCapability(this.ctx.tool.mcpRegistry);

    if (!on) {
      return false;
    }

    this.ctx.tool.linear = true;

    for (const tool of [
      LINEAR_READ_TOOL,
      LINEAR_WRITE_TOOL,
      LINEAR_START_TOOL,
    ]) {
      if (!this.tools.some((t) => t.function.name === tool.function.name)) {
        this.tools = [...this.tools, tool];
      }
    }

    const system = this.ctx.messages[0];

    if (!(
      system?.role === "system" && system.content.includes(LINEAR_MARKER)
    )) {
      this.guide(LINEAR_DRIVE_GUIDANCE);
    }

    return true;
  }

  /** Turn on the Notion verbs when a `notion` MCP server is connected. Mirrors
   *  setLinearCapability (advertise + consent + one-time guidance). Returns whether
   *  it turned on (for the boot banner). Idempotent. */
  setNotionCapability(): boolean {
    if (!resolveNotionCapability(this.ctx.tool.mcpRegistry)) {
      return false;
    }

    this.ctx.tool.notion = true;
    this.addIntegrationTools([NOTION_READ_TOOL, NOTION_WRITE_TOOL]);
    this.guideOnce(NOTION_MARKER, NOTION_DRIVE_GUIDANCE);

    return true;
  }

  /** Turn on the Sentry verbs when a `sentry` MCP server is connected. Mirrors
   *  setLinearCapability. Returns whether it turned on. Idempotent. */
  setSentryCapability(): boolean {
    if (!resolveSentryCapability(this.ctx.tool.mcpRegistry)) {
      return false;
    }

    this.ctx.tool.sentry = true;
    this.addIntegrationTools([SENTRY_READ_TOOL, SENTRY_WRITE_TOOL]);
    this.guideOnce(SENTRY_MARKER, SENTRY_DRIVE_GUIDANCE);

    return true;
  }

  /** Advertise the browser_* tools + `note` when this session holds the Chrome
   *  bridge (TSFORGE_BROWSER) and appends the research guidance once. Returns the
   *  bridge status for the boot chip, or null when the feature is off. A bridge
   *  another tsforge process owns (`in-use`) advertises nothing. Idempotent. */
  setBrowserCapability(): BridgeStatus | null {
    const browser = this.ctx.tool.browser;

    if (browser === undefined) {
      return null;
    }

    const status = browser.bridge.status();

    if (status === "in-use") {
      return status;
    }

    const vision = this.tools.some(
      (t) => t.function.name === TOOL_NAME.readImage
    );

    this.addIntegrationTools([
      ...browserTools({ browser: true, vision }),
      NOTE_TOOL,
    ]);
    this.guideOnce(BROWSER_MARKER, BROWSER_RESEARCH_GUIDANCE);

    return status;
  }

  /** Turn the Chrome bridge on mid-session (the /config toggle). */
  async enableBrowser(): Promise<BridgeStatus> {
    this.ctx.tool.browser ??= await openBrowserSession(flags.browserPort());

    return this.setBrowserCapability() ?? "in-use";
  }

  /** Live bridge status (null when the feature is off) — for /browser. */
  browserStatus(): BridgeStatus | null {
    return this.ctx.tool.browser?.bridge.status() ?? null;
  }

  /** Append the given tool schemas to the advertised set if absent (idempotent). */
  private addIntegrationTools(
    add: readonly ReturnType<typeof toolsFor>[number][]
  ): void {
    for (const tool of add) {
      if (!this.tools.some((t) => t.function.name === tool.function.name)) {
        this.tools = [...this.tools, tool];
      }
    }
  }

  /** Append a guidance block to the system prompt exactly once (guarded by `marker`). */
  private guideOnce(marker: string, guidance: string): void {
    const system = this.ctx.messages[0];

    if (!(system?.role === "system" && system.content.includes(marker))) {
      this.guide(guidance);
    }
  }

  /** Wire the inline-image preview callback the `generate_image` tool fires after
   *  saving (the CLI emits the terminal's inline-image escape). Absent ⇒ the tool
   *  just reports the saved path. */
  setPreviewImage(fn: IToolContext["previewImage"]): void {
    this.ctx.tool.previewImage = fn;
  }

  /** Append opinionated guidance to the SYSTEM prompt (e.g. after classifying a
   *  fresh request as a web build). Folded into the existing system message — a
   *  second system message breaks some chat templates (Qwen → 400). */
  guide(text: string): void {
    const first = this.ctx.messages[0];

    if (first?.role === "system") {
      // Insert BEFORE the dynamic task contract so it stays the final block (and
      // `refreshTaskContract` can splice it without clobbering this guidance).
      const idx = first.content.indexOf(TASK_CONTRACT_MARKER);

      first.content =
        idx === -1
          ? `${first.content}\n\n${text}`
          : `${first.content.slice(0, idx).trimEnd()}\n\n${text}\n\n${first.content.slice(idx)}`;
    } else {
      this.ctx.messages.unshift({ role: "system", content: text });
    }
  }

  /**
   * Compress the conversation to [system?, summary, ...retained]: summarize the
   * older turns and keep the newest stretch verbatim, so a compact mid-task does
   * not cost the model the work in progress. When a model-free prune of fat tool
   * results frees enough on its own, no summary is written and `prunedChars`
   * reports what it reclaimed. Returns the message count before/after.
   */
  async compact(
    signal?: AbortSignal
  ): Promise<{ before: number; after: number; prunedChars?: number }> {
    const result = await compactConversation(
      this.ctx.messages,
      this.provider,
      this.ctx.cwd,
      signal
    );

    this.ctx.messages = result.messages;

    return {
      before: result.before,
      after: result.after,
      ...(result.prunedChars === undefined
        ? {}
        : { prunedChars: result.prunedChars }),
    };
  }

  /** The live conversation (system + every exchange). Read-only view. */
  get messages(): readonly IChatMessage[] {
    return this.ctx.messages;
  }

  /**
   * Run one user message: drive the model until it stops calling tools, then
   * gate-confirm if a gate is set. Loops on red gate feedback up to the turn cap.
   */
  async send(text: string, opts: ISendOptions = {}): Promise<ISendResult> {
    const { ctx, report } = this;
    // Runaway crash-guard (not the primary stop — the progress guards pull out when
    // converging stops). The PRIMARY terminal is ladder-exhaustion (R5 handoff).
    const maxTurns =
      this.maxTurnsOverride ??
      this.cfg.maxTurns ??
      LOOP_LIMITS.runawayBackstopTurns;

    const checkpointIntervalTurns =
      this.cfg.checkpointIntervalTurns ?? LOOP_LIMITS.checkpointIntervalTurns;
    const sendStart = performance.now();

    // Thread cancellation to the tool `run` commands and the gate (not just the
    // model call), so Ctrl-C kills in-flight child processes too.
    ctx.tool.signal = opts.signal;
    this.activeThinking = opts.enableThinking;
    this.repairing = false; // fresh send starts in (fast, thinking-off) creation mode
    resetDriveConvergence(this.state);
    this.lastUserPrompt = text;

    // The TtsrManager persists for the whole session, so per-rule silencing and
    // the global interrupt cap must reset per user message — otherwise a rule
    // silenced (or the manager disabled) during one prompt stays off for every
    // later, unrelated prompt. The headless run.ts path builds a fresh manager
    // per run and needs neither reset.
    this.ttsrManager?.resetInterrupts();
    this.state.ttsrInterrupts = 0;

    try {
      // Auto-compact BEFORE adding the new message (so it stays a fresh turn
      // after the summary) when the held context is near the window.
      await this.maybeAutoCompact(opts.signal);

      // The plan-mode workflow note rides the FIRST message after the mode flips
      // on; revision replies go bare (the instruction persists in history).
      if (this.planMode && this.planIntroPending) {
        this.planIntroPending = false;
        ctx.messages.push({
          role: "user",
          content: `${text}\n\n${PLAN_MODE_NOTE}`,
        });
      } else {
        ctx.messages.push({ role: "user", content: text });
      }

      return await this.drive(
        maxTurns,
        checkpointIntervalTurns,
        sendStart,
        opts
      );
    } catch (err) {
      if (opts.signal?.aborted === true) {
        report({
          kind: "stuck",
          task: SESSION_ID,
          message: "interrupted",
        });

        return { status: "interrupted", turns: 0 };
      }

      // A provider/network error (request timeout, connection drop after retries)
      // ends the turn GRACEFULLY as stuck — never crash the process. The message
      // is logged so it's visible/debuggable, not silently swallowed. This keeps a
      // long autonomous run (and the interactive CLI) alive through a flaky model.
      const detail = err instanceof Error ? err.message : String(err);

      report({
        kind: "stuck",
        task: SESSION_ID,
        message: `⚠ model request failed: ${detail}`,
      });

      return { status: "stuck", turns: 0 };
    } finally {
      ctx.tool.signal = undefined;
      this.activeThinking = undefined;
    }
  }

  /** Once `editsSinceCheck` reaches the threshold, run the incremental check and
   *  reset the counter; otherwise pass it through. Keeps `drive` branch-light. */
  private async checkAfterEdits(
    editsSinceCheck: number,
    checkEvery: number
  ): Promise<number> {
    if (editsSinceCheck < checkEvery) {
      return editsSinceCheck;
    }

    await this.runIncrementalCheck();

    return 0;
  }

  /** Run the fast incremental check (e.g. tsc) and, if it surfaces errors, feed
   *  them back NOW as a user message so the model fixes them before writing more
   *  — instead of letting them pile up for the final gate. No-op when unset. */
  private async runIncrementalCheck(): Promise<void> {
    if (this.incrementalCheck.length === 0) {
      return;
    }

    const { ctx } = this;
    const task: ITask = { ...ctx.task, accept: this.incrementalCheck };
    const result = await validate(
      task,
      ctx.cwd,
      ctx.gate.parse,
      ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }
    );

    // Drop stub-route-tree phantoms (the build regenerates the tree at the gate) —
    // the model can't fix them and shouldn't be told to try.
    const errors = result.errors.filter((e) => !isPhantomRouteError(e.message));

    if (result.passed || errors.length === 0) {
      this.repairing = false; // clean (or only phantoms) → fast thinking-off creation

      return;
    }

    this.repairing = true; // errors outstanding → next turns think to converge

    const detail = errors
      .slice(0, INTERIM_ERROR_CAP)
      .map((e) => e.message)
      .join("\n");

    // Surface the ACTUAL errors into the log (not just the count) — so we can see
    // WHAT the model fails at and target the systematic ones in the harness.
    ctx.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⊙ interim check: ${String(errors.length)} error(s) — fixing now:\n${detail}`,
    });

    // The pushed message adds the curated fix RECIPE (ruleHelp) on top of the raw
    // errors, so the model gets the constructive fix (e.g. WIRE UP an unused i18n
    // key) instead of only the raw rule message that invites deletion.
    ctx.messages.push({
      role: "user",
      content: interimCheckContent(errors),
    });
  }

  /** The turn loop — separated so `send` can wrap it in abort handling. */
  /** One model call: stream thinking live, push the reply, and surface salvage +
   *  the highlighted answer. Keeps `drive`'s per-turn control flow lean. */
  private async askModel(
    signal?: AbortSignal,
    toolChoice: "auto" | "required" = "auto",
    forceNoThinking = false
  ): Promise<IModelResponse> {
    const { ctx, report } = this;
    // On a FORCED tool turn, disable thinking: the model already decided what to
    // do, and thinking-on is a known source of prose-before-the-call malformed
    // output on this model. `required` + thinking-off = the cleanest tool call.
    // ADAPTIVE: think while REPAIRING (errors outstanding) so repair converges;
    // otherwise honour the per-send/cfg setting (off = fast creation). A forced
    // recovery turn always thinks-off (it just needs one clean tool call).
    const enableThinking = selectThinking({
      forceNoThinking,
      repairing: this.repairing,
      activeThinking: this.activeThinking,
      configured: this.cfg.enableThinking,
    });
    // PLAN MODE advertises only the read-only tools (+ `run`, whose handler
    // enforces a read-only command allowlist) — the model never sees a write
    // tool. Filtered per call, so `this.tools` is untouched and toggling the
    // mode off restores the full set with zero bookkeeping.
    let offeredTools = offeredToolsFor(
      this.tools,
      this.planMode,
      suppressCuratedSchemas(
        this.ctx.tool.mcpRegistry?.toolSchemas() ?? [],
        suppressedIntegrationServers(this.ctx.tool)
      ),
      activeOverlay()?.toolOverrides ?? [],
      this.activePlanId !== null && this.activePlanId.length > 0,
      this.greenfieldMode
    );

    // An auto gate waiting for code, or a gate the user cleared: the gate-only
    // tools have nothing to act on — `check` would lint an empty workspace and
    // `pull_conventions` pushes TS house rules into non-code work. (A session
    // that was simply never given a gate — e.g. a host that attaches one per
    // slice — keeps them.)
    if (this.buildModeSuppressed()) {
      offeredTools = offeredTools.filter(
        (t) => !GATE_ONLY_TOOLS.has(t.function.name)
      );
    }

    // Readonly-spin recovery: withhold read/search so soft text cannot be ignored.
    if (this.forceWriteTools && !this.planMode) {
      const forced = filterWriteForceTools(offeredTools);

      if (forced.length > 0) {
        offeredTools = forced;
      }

      this.forceWriteTools = false;
    }

    const callStart = performance.now();
    let firstTokenAt = 0;

    this.ttsrManager?.resetBuffer();

    // R2 per-call model overrides (temperature, reasoning effort) — applied to
    // the NEXT main-loop turn only, then cleared. Auxiliary calls (planning,
    // judge, expert) stay on config defaults. Applied by R2 (reason-more) rung.
    const override = this.state.pendingModelOverride;
    const temperature =
      override?.temperature ?? this.cfg.temperature ?? DEFAULT_TEMPERATURE;
    const reasoningEffort = override?.reasoningEffort;

    // Clear the pending override immediately after reading it into locals, BEFORE
    // the provider call. If complete() throws, this ensures the override won't leak
    // into the next successful call (exception-safe one-shot semantics).
    this.state.pendingModelOverride = null;

    const callOpts = {
      tools: offeredTools,
      temperature,
      toolChoice,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(enableThinking === undefined ? {} : { enableThinking }),
      ...(this.cfg.thinkingTokenBudget === undefined
        ? {}
        : { thinkingTokenBudget: this.cfg.thinkingTokenBudget }),
      ...this.ttsrCallOption(),
      ...(signal === undefined ? {} : { signal }),
      onToken: (token: string, channel: TokenChannel) => {
        // Stamp the first token so tokens/sec measures generation rate (excluding
        // prompt-processing / time-to-first-token), not total wall time.
        if (firstTokenAt === 0) {
          firstTokenAt = performance.now();
        }

        // Stream EVERYTHING live — thinking, the tool calls being written, and
        // the answer itself (channel `content`), so the user watches the reply
        // arrive instead of staring at a frozen indicator. The renderer formats
        // content incrementally line-by-line; the consolidated `message` event
        // below stays as the log's record (the interactive renderer dedupes it).
        report({ kind: "token", task: SESSION_ID, message: token, channel });
      },
    };

    const res = await this.completeWithOverflowRecovery(callOpts, signal);

    if (res.usage !== undefined) {
      const ended = performance.now();
      const genMs = firstTokenAt > 0 ? ended - firstTokenAt : ended - callStart;

      this.recordUsage(res.usage, genMs);
      // Logged (not shown) so the --log analyzer can compute tokens-to-solution.
      // `thinking` records THIS call's mode, so malformed-call rates can be
      // correlated with it (analyze-malformed).
      report(
        usageEvent({
          task: SESSION_ID,
          usage: res.usage,
          genMs,
          callMs: ended - callStart,
          ...(enableThinking === undefined ? {} : { thinking: enableThinking }),
        })
      );
    }

    ctx.messages.push(assistantMessage(res));

    // Every model call advances TTSR cooldown accounting (including interrupted
    // ones, so repeatGap rules count correctly after a retry).
    this.ttsrManager?.incrementTurnCount();

    if (res.salvaged !== undefined && res.salvaged > 0) {
      report({
        kind: "tool",
        task: SESSION_ID,
        message: `⚠ recovered ${res.salvaged} malformed tool call(s) (server tool-call parser mismatch)`,
        ...(enableThinking === undefined ? {} : { thinking: enableThinking }),
      });
    }

    if (res.content.length > 0) {
      report({ kind: "message", task: SESSION_ID, message: res.content });
    }

    return res;
  }

  /** One provider call with REACTIVE overflow recovery (the subagent loop has
   *  had this for a while; the main loop only had the PROACTIVE lastUsage
   *  check, which is blind after any turn that returned no usage —
   *  aborted/TTSR/degenerated streams routinely don't). Without this, one
   *  context-length 400 ended the send as stuck, nothing ever shrank the
   *  transcript, and every later send re-overflowed: a dead session that
   *  --continue faithfully restored. */
  private async completeWithOverflowRecovery(
    callOpts: Parameters<IProvider["complete"]>[1],
    signal?: AbortSignal
  ): Promise<IModelResponse> {
    try {
      return await this.provider.complete(this.ctx.messages, callOpts);
    } catch (err) {
      if (
        signal?.aborted === true ||
        !isContextOverflow(err) ||
        this.ctx.messages.length <= 2
      ) {
        throw err;
      }

      this.report({
        kind: "tool",
        task: SESSION_ID,
        message:
          "⊙ request overflowed the context window — compacting and retrying",
      });
      await this.compact(signal);
      this.lastUsage = undefined;

      return this.provider.complete(this.ctx.messages, callOpts);
    }
  }

  /**
   * Decide what a turn that ended with NO tool calls (and no edits yet this send)
   * means. A plain answer — no gate, or a conversational reply — is `responded`.
   * But with a gate set and the reply DUMPING whole files as prose (instead of
   * calling `create`), that's the narrate-instead-of-build failure: the content
   * never reaches disk. We nudge it to act (`result: null`, capped); past the cap
   * we stop honestly rather than loop forever. Side effects (the nudge message,
   * the stuck report) happen here; the caller only emits timing and loops/returns.
   */
  private resolveNoEditYield(
    content: string,
    turn: number,
    buildNudges: number
  ): { result: ISendResult | null } {
    // Plan mode is read-only — a fenced-snippet-heavy PLAN is the desired
    // output, not a narrate-instead-of-build failure; never nudge it to build.
    if (this.planMode) {
      return { result: { status: "responded", turns: turn } };
    }

    // Leaked tool markup = the model TRIED to act but the call never parsed
    // (and salvage couldn't rescue it). Without this nudge the turn ends as a
    // fake "responded" and the build silently strands (captured live: a
    // scaffold_web emitted as text). The retry is a FORCED tool call, which is
    // grammar-constrained — so it always parses.
    const leaked = this.hasGate && leaksToolMarkup(content);
    // An EMPTY no-tool reply mid-gated-build is never a valid conclusion — it
    // is the signature of a degenerate/failed provider response (captured
    // live: a 675ms "reply" during an endpoint flap ended a 180-turn build as
    // "responded" with only the scaffold on disk). Nudge-with-cap, like the
    // other mid-build non-answers.
    const emptyMidBuild = this.hasGate && content.trim().length === 0;

    if (
      !leaked &&
      !emptyMidBuild &&
      (!this.hasGate || !looksLikeCodeDump(content))
    ) {
      return { result: { status: "responded", turns: turn } };
    }

    if (buildNudges >= LOOP_LIMITS.maxBuildNudges) {
      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const diagnosticNote = leaked
        ? "malformed tool-call format"
        : emptyMidBuild
          ? "repeated empty replies"
          : "model narrating instead of creating files";
      const handoff = buildSyntheticHandoff(
        "build-nudge",
        errorMessages,
        diagnosticNote
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message: leaked
          ? "⚠ model kept emitting malformed tool-call text instead of real " +
            "calls — stopped. See malformed-toolcall-format (server parser)."
          : emptyMidBuild
            ? "⚠ model kept returning empty replies mid-build — stopped " +
              "(endpoint likely degraded; the run is incomplete, not done)."
            : "⚠ model kept writing files as chat messages instead of creating " +
              "them — stopped. Try a smaller step (e.g. one file at a time).",
      });

      return { result: { status: "stuck", turns: turn, handoff } };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: leaked
        ? "↳ malformed tool-call text (no tool ran) — forcing a real call"
        : emptyMidBuild
          ? "↳ empty reply during a gated build — asking the model to continue"
          : "↳ no files written — nudging the model to build with tools",
    });
    this.ctx.messages.push({
      role: "user",
      content: leaked ? MALFORMED_CALL_NUDGE : BUILD_NUDGE,
    });

    return { result: null };
  }

  /** Handle a repetition-loop detection: stop (return a stuck result) once the
   *  recovery budget is spent, else re-steer toward one concrete action and
   *  return null so the caller forces a tool call next turn. */
  private degenerationRecovery(
    degenerations: number,
    turn: number
  ): ISendResult | null {
    if (degenerations >= MAX_DEGENERATION_RECOVERIES) {
      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const handoff = buildSyntheticHandoff(
        "degeneration-budget",
        errorMessages,
        "model fell into a repetition loop"
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message:
          "⚠ repetition loop persisted after recovery attempts — stopped. Try a smaller step.",
      });

      return { status: "stuck", turns: turn, handoff };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: "⚠ repetition loop — forcing a concrete next action",
    });
    this.ctx.messages.push({
      role: "user",
      content: repetitionResteer(this.hasGate),
    });

    return null;
  }

  /** Handle a thrown model call: rethrow a caller abort or any non-timeout error
   *  (terminal — send()'s handler turns it into interrupted/stuck). A request
   *  TIMEOUT is recoverable: emit timing, then stop (return stuck) once the budget
   *  is spent, else re-steer toward a small fast turn and return null so the caller
   *  forces a (thinking-off) tool call and CONTINUES — preserving the turns already
   *  done rather than abandoning the whole build on one over-long turn. */
  private recoverFromTimeout(
    err: unknown,
    timeouts: number,
    turn: number,
    turnStart: number,
    sendStart: number,
    signal?: AbortSignal
  ): ISendResult | null {
    if (signal?.aborted === true || !isModelTimeout(err)) {
      throw err;
    }

    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    // Log the RAW error so the timeout's true source (request-timeout ceiling vs a
    // server-side stream close) is diagnosable from the --log, not swallowed.
    const salvage =
      err instanceof StreamInterruptedError
        ? ` (salvaged ${String(err.partial.content.length)} content + ${String(err.partial.reasoning?.length ?? 0)} reasoning chars before the failure)`
        : "";
    const detail =
      (err instanceof Error ? `${err.name}: ${err.message}` : String(err)) +
      salvage;

    if (timeouts >= MAX_TIMEOUT_RECOVERIES) {
      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const errorType = detail.split(":")[0] ?? "unknown";
      const handoff = buildSyntheticHandoff(
        `timeout:${errorType}`,
        errorMessages,
        `model request timed out: ${detail}`
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message: `⚠ model request timed out repeatedly (${detail}) — stopped. The server may be wedged or the task too large for one turn.`,
      });

      // Deliberately a PARK, not a WS-C3 raise-hand: a repeated request timeout is an
      // infrastructure failure (wedged server / over-large turn), not a build decision a
      // human steer can unblock — asking "how should I proceed?" would just move the hang
      // to the human. Raise-hand is reserved for steerable stalls (ladder exhaustion,
      // read-only spin).
      return { status: "stuck", turns: turn, handoff };
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⚠ model request timed out (${detail}) — re-steering to a smaller turn and continuing (${String(timeouts + 1)}/${String(MAX_TIMEOUT_RECOVERIES)})`,
    });
    this.ctx.messages.push({ role: "user", content: TIMEOUT_RESTEER });

    return null;
  }

  /** Inject any messages the user typed mid-run (steering) before the next turn. */
  private injectSteer(steer?: () => string[]): void {
    for (const message of steer?.() ?? []) {
      this.ctx.messages.push({ role: "user", content: message });
      this.report({
        kind: "tool",
        task: SESSION_ID,
        message: `↳ steering: ${message.slice(0, 60)}`,
      });
    }
  }

  /** One model turn for `drive`, with timeout recovery folded in so the loop body
   *  stays lean: `ok` → use the response; `stop` → terminal result; `retry` →
   *  timed out, re-steer applied, force a small tool call next turn. A caller abort
   *  or non-timeout error propagates (via recoverFromTimeout) to send()'s handler. */
  private async acquireResponse(
    forceTool: boolean,
    timeouts: number,
    turn: number,
    turnStart: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<
    | { kind: "ok"; res: IModelResponse }
    | { kind: "stop"; result: ISendResult }
    | { kind: "retry" }
  > {
    try {
      // A recovery force disables thinking for a clean call.
      const res = await this.askModel(
        opts.signal,
        forceTool ? "required" : "auto",
        forceTool
      );

      return { kind: "ok", res };
    } catch (err) {
      const recovered = this.recoverFromTimeout(
        err,
        timeouts,
        turn,
        turnStart,
        sendStart,
        opts.signal
      );

      return recovered !== null
        ? { kind: "stop", result: recovered }
        : { kind: "retry" };
    }
  }

  /** Run the tool calls of a turn, account the edits, emit timing, and run the
   *  incremental check every few edits — returns the updated edit accounting so
   *  `drive`'s loop body stays lean. */
  private async runEditTurn(
    res: IModelResponse,
    acc: { edited: boolean; editsSinceCheck: number; checkEvery: number },
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    edited: boolean;
    editsSinceCheck: number;
    progressed: boolean;
  }> {
    const { ctx, state, report } = this;
    const before = state.edits;
    // `progressed` = this turn touched an editable file (hand-write OR scaffold/
    // semantic mutation), the per-turn signal the read-only-spin guard counts on.
    // `edited` stays cumulative for the gate-confirm decision.
    const progressed = await runToolCalls(res.toolCalls, ctx, state);
    const edited = progressed || acc.edited;

    emitTiming(report, SESSION_ID, turn, turnStart, sendStart);

    // Check every few edits WHILE building, so errors surface early instead of
    // piling up into a final avalanche the model can't dig out of.
    const editsSinceCheck = await this.checkAfterEdits(
      acc.editsSinceCheck + (state.edits - before),
      acc.checkEvery
    );

    return { edited, editsSinceCheck, progressed };
  }

  /** A working turn (the model emitted tool calls): run them via `runEditTurn`,
   *  then apply history-meta + read-only-spin guards. Returns the carried counters
   *  plus an `action` — a terminal `ISendResult` to stop on, or "continue" to keep
   *  looping. Keeps the guard's bookkeeping out of `drive`'s loop body. */
  private async runToolTurn(
    res: IModelResponse,
    carry: {
      edited: boolean;
      editsSinceCheck: number;
      checkEvery: number;
      readonlyStreak: number;
      readonlyRecoveries: number;
      historyMetaStreak: number;
    },
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    action: ISendResult | "continue";
    edited: boolean;
    editsSinceCheck: number;
    readonlyStreak: number;
    readonlyRecoveries: number;
    historyMetaStreak: number;
    forceWriteNext: boolean;
  }> {
    const messagesStart = this.ctx.messages.length;
    const { edited, editsSinceCheck, progressed } = await this.runEditTurn(
      res,
      {
        edited: carry.edited,
        editsSinceCheck: carry.editsSinceCheck,
        checkEvery: carry.checkEvery,
      },
      turn,
      turnStart,
      sendStart
    );

    // WS-C: the model raised its hand via ask_user (runOneToolCall set this). END the
    // send now — the question was already surfaced as an `ask_user` event; the REPL
    // shows it and the human's next `send` carries the answer. A `responded` result is
    // the normal "the model produced output, your turn" signal the REPL already handles.
    if (this.state.pendingAskUser !== undefined) {
      const question = this.state.pendingAskUser;

      this.state.pendingAskUser = undefined;
      // If this send also edited a file, carry that across the pause so the RESUME send
      // re-seeds `edited` and gates the pending edit (per-send `edited` resets to false).
      this.state.pausedWithEdit = edited;

      return {
        action: {
          status: "responded",
          turns: turn,
          awaitingUser: question,
        },
        edited,
        editsSinceCheck,
        readonlyStreak: carry.readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
        historyMetaStreak: carry.historyMetaStreak,
        forceWriteNext: false,
      };
    }

    // A present_plan proposal VALIDATED this turn (runOneToolCall set this): the plan
    // card is rendered and awaiting the human, so END the send — real models otherwise
    // keep exploring read-only and the human's "approve" typed meanwhile is peeled as
    // mid-send steering instead of binding the plan. Unlike the ask_user pause this is
    // a NORMAL end (no awaitingUser), so the next line routes through plan-approval
    // detection (classifyReplRoute), not answer routing.
    if (this.state.pendingPlanPause === true) {
      this.state.pendingPlanPause = undefined;

      return {
        action: {
          status: "responded",
          turns: turn,
        },
        edited,
        editsSinceCheck,
        readonlyStreak: carry.readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
        historyMetaStreak: carry.historyMetaStreak,
        forceWriteNext: false,
      };
    }

    const hadHistoryMeta = turnHadHistoryMetaReject(
      this.ctx.messages,
      messagesStart
    );
    const historyMetaStreak = nextHistoryMetaStreak({
      previous: carry.historyMetaStreak,
      hadHistoryMeta,
      successfulWrite: progressed,
    });
    const attemptedWrite =
      toolCallsAttemptWrite(res.toolCalls) &&
      !isHistoryMetaOnlyWriteTurn({
        calls: res.toolCalls,
        hadHistoryMeta,
        successfulWrite: progressed,
      });

    const base = {
      action: "continue" as const,
      edited,
      editsSinceCheck,
      historyMetaStreak,
      forceWriteNext: false,
    };

    const meta = await this.historyMetaSpinStop(
      historyMetaStreak,
      turn,
      edited
    );

    if (meta === "retry") {
      return {
        ...base,
        readonlyStreak: carry.readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
        historyMetaStreak: streakAfterHistoryMetaResteer(),
        forceWriteNext: false,
      };
    }

    if (meta !== null) {
      return {
        ...base,
        action: meta,
        readonlyStreak: carry.readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
      };
    }

    // The readonly-spin detector exists to catch a model that CAN write but
    // won't — it's a category error when write tools aren't even offered
    // (plan mode / greenfield planning: `ctx.tool.readOnly` is the same hard
    // guarantee that already rejects a mutating call at dispatch). "Only
    // reading" is the CORRECT, expected behavior there, not a stuck signal —
    // pin the streak at 0 rather than escalating a session that structurally
    // cannot do anything else. The per-send `maxTurns` backstop still bounds
    // a genuinely runaway read-only-mode session.
    const readonlyStreak =
      this.ctx.tool.readOnly === true
        ? 0
        : nextReadonlyStreak({
            previous: carry.readonlyStreak,
            // Without a live gate there is no code to write: fetching and
            // reading pages IS the work, not a stall (research sessions).
            progressed:
              progressed ||
              (!this.hasGate && toolCallsDoResearch(res.toolCalls)),
            attemptedWrite,
          });

    if (readonlyStreak === 0) {
      return {
        ...base,
        readonlyStreak: 0,
        readonlyRecoveries: carry.readonlyRecoveries,
      };
    }

    const spin = await this.readonlySpinStop(
      readonlyStreak,
      carry.readonlyRecoveries,
      turn,
      edited
    );

    // Re-steered: keep streak hot + force write tools next turn (soft text alone fails).
    if (spin === "retry") {
      // Forcing create/edit only makes sense when there is code to fix; without
      // a live gate the re-steer asks for an answer, so leave the tools alone.
      this.forceWriteTools = this.hasGate;

      return {
        ...base,
        readonlyStreak: streakAfterReadonlyResteer(READONLY_STREAK_LIMIT),
        readonlyRecoveries: carry.readonlyRecoveries + 1,
        forceWriteNext: true,
      };
    }

    if (spin !== null) {
      return {
        ...base,
        action: spin,
        readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
      };
    }

    return {
      ...base,
      readonlyStreak,
      readonlyRecoveries: carry.readonlyRecoveries,
    };
  }

  /** A working turn (the model emitted tool calls) that also bounds blind
   *  edit-churn: run the calls via `runToolTurn`, track edits since the last full
   *  gate, and force a gate once they cross `FULL_GATE_EVERY` (so the build runs +
   *  the no-progress guards tick even if the model never yields). Returns the
   *  carried loop state, including whether the next turn must force a tool call. */
  private async handleWorkingTurn(
    res: IModelResponse,
    carry: {
      edited: boolean;
      editsSinceCheck: number;
      editsSinceGate: number;
      checkEvery: number;
      readonlyStreak: number;
      readonlyRecoveries: number;
      historyMetaStreak: number;
    },
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    action: ISendResult | "continue";
    edited: boolean;
    editsSinceCheck: number;
    editsSinceGate: number;
    readonlyStreak: number;
    readonlyRecoveries: number;
    historyMetaStreak: number;
    forceTool: boolean;
  }> {
    const editsBefore = this.state.edits;
    const r = await this.runToolTurn(
      res,
      {
        edited: carry.edited,
        editsSinceCheck: carry.editsSinceCheck,
        checkEvery: carry.checkEvery,
        readonlyStreak: carry.readonlyStreak,
        readonlyRecoveries: carry.readonlyRecoveries,
        historyMetaStreak: carry.historyMetaStreak,
      },
      turn,
      turnStart,
      sendStart
    );

    let editsSinceGate =
      carry.editsSinceGate + (this.state.edits - editsBefore);
    const carried = {
      edited: r.edited,
      editsSinceCheck: r.editsSinceCheck,
      readonlyStreak: r.readonlyStreak,
      readonlyRecoveries: r.readonlyRecoveries,
      historyMetaStreak: r.historyMetaStreak,
    };

    if (r.action !== "continue") {
      return {
        ...carried,
        editsSinceGate,
        action: r.action,
        forceTool: r.forceWriteNext,
      };
    }

    // Only force a gate when one is configured. With no gate the "gate" is empty
    // and trivially passes → forcing it would wrongly return done mid-edit, before
    // the model yields its final response (a no-gate session never terminates on a
    // gate). The churn guard exists to surface gate failures, so it's a no-op here.
    if (this.hasGate && editsSinceGate >= forcedGateInterval(this.state)) {
      editsSinceGate = 0;

      const forced = await this.gateAfterChurn(turn, turnStart, sendStart);

      if (forced !== null) {
        return { ...carried, editsSinceGate, action: forced, forceTool: false };
      }

      // Phase B checklist continue (not a red re-gate) — do not force-write.
      if (this.checklistContinuePending) {
        this.checklistContinuePending = false;

        return {
          ...carried,
          editsSinceGate,
          readonlyStreak: 0,
          readonlyRecoveries: 0,
          action: "continue",
          forceTool: false,
        };
      }

      return {
        ...carried,
        editsSinceGate,
        action: "continue",
        forceTool: true,
      };
    }

    return {
      ...carried,
      editsSinceGate,
      action: "continue",
      forceTool: r.forceWriteNext,
    };
  }

  /** Resolve a turn where the model yielded with NO tool calls: a conversational
   *  reply, the narrate-instead-of-build failure (resolveNoEditYield), or a gate
   *  confirm after edits. Returns a terminal `ISendResult` or "continue", plus the
   *  next-turn `buildNudges`/`forceTool` state for the caller to carry. Side effects
   *  (repair flag, nudge messages, timing) happen here so `drive`'s loop stays lean. */
  private async resolveYield(
    res: IModelResponse,
    edited: boolean,
    buildNudges: number,
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<{
    action: ISendResult | "continue";
    buildNudges: number;
    forceTool: boolean;
  }> {
    // With no gate it's a conversational reply; with a gate but no edits this send,
    // decide whether that's a real answer or the narrate-instead-of-build failure.
    if (!this.hasGate || !edited) {
      const outcome = this.resolveNoEditYield(res.content, turn, buildNudges);

      emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

      if (outcome.result !== null) {
        return { action: outcome.result, buildNudges, forceTool: false };
      }

      // It just narrated code — force a tool call next turn.
      return {
        action: "continue",
        buildNudges: buildNudges + 1,
        forceTool: true,
      };
    }

    // Gate confirms. Green/stuck ⇒ terminal; null ⇒ red, feedback pushed.
    // Phase B: green + open checklist ⇒ nudge and continue (not finished yet).
    const settled = await this.settleTurn(turn, turnStart, sendStart);

    if (settled !== null) {
      const next = this.continueIfChecklistOpen(settled);

      if (next === "continue") {
        return { action: "continue", buildNudges, forceTool: false };
      }

      if (next.status === "done") {
        announceTaskDone(this.report, SESSION_ID, next.turns);
      }

      return { action: next, buildNudges, forceTool: false };
    }

    // Gate came back RED → enter repair mode (think to converge on the fix), nudge
    // it to act (not narrate), and FORCE a tool call next turn so it can't narrate.
    this.repairing = true;
    this.ctx.messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });

    return { action: "continue", buildNudges, forceTool: true };
  }

  /** Force the full gate mid-edit when the model has churned `FULL_GATE_EVERY`
   *  edits without yielding (it would otherwise never run the build or tick the
   *  no-progress guards). Terminal result (done/stuck) or null when still red —
   *  settleGate has already pushed the gate errors into the conversation, so the
   *  caller just forces the model to act on them. */
  private async gateAfterChurn(
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<ISendResult | null> {
    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⚙ forcing a gate after ${String(forcedGateInterval(this.state))} edits without a checkpoint`,
    });

    const forced = await this.settleTurn(turn, turnStart, sendStart);

    if (forced === null) {
      this.repairing = true;

      return null;
    }

    const next = this.continueIfChecklistOpen(forced);

    if (next === "continue") {
      // Checklist-open continue is NOT a red gate — keep repairing off.
      return null;
    }

    if (next.status === "done") {
      announceTaskDone(this.report, SESSION_ID, next.turns);
    }

    return next;
  }

  /** Run the gate once the model has stopped after editing: a terminal result
   *  (done/stuck) or null when still red (drive then pushes feedback + continues).
   *  Keeps the done/stuck mapping out of `drive`'s loop body. */
  private async settleTurn(
    turn: number,
    turnStart: number,
    sendStart: number
  ): Promise<ISendResult | null> {
    const settled = await settleGate(this.ctx, this.state, turn);

    // The gate has now actually run over the working tree — so any edit that a prior
    // ask_user pause deferred is validated by THIS run. Clear the deferred-gate flag
    // only here (never at drive entry): if settleGate throws (e.g. abort mid-gate) we
    // never reach this line, so the flag persists and the next send re-gates. This is
    // what makes the deferral durable across a non-yielding resume (WS-C).
    this.state.pausedWithEdit = false;

    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    if (settled === null) {
      return null;
    }

    // A stuck terminal carries a handoff. With a human co-pilot present, RAISE A HAND
    // (pause + ask) on that block instead of parking on it (WS-C3) — the human's next
    // send resumes the build. Unattended (humanPresent false) → park exactly as before.
    if (settled.status !== RUN_STATUS.done && settled.handoff !== undefined) {
      // settleGate just ran, so there is no unvalidated edit pending (editedPending=false).
      return this.raiseHandOrStuck(settled.handoff, turn, false);
    }

    // Any stuck terminal from settleGate carries a handoff (checkStuck always builds
    // one), so it already returned via raiseHandOrStuck above. The only results reaching
    // here are `done` and the defensive no-handoff stuck — neither threads a handoff.
    return {
      status: settled.status === RUN_STATUS.done ? "done" : "stuck",
      turns: turn,
    };
  }

  /** WS-C3: turn a stuck terminal into a co-pilot RAISE-HAND when a human is present,
   *  else return today's park. The pure `parkOrRaiseHand` decides; here we apply the raise
   *  hand's side effects and return the terminal directly. We deliberately do NOT set
   *  `state.pendingAskUser` (that is the ask_user TOOL's handoff to runToolTurn; a gate
   *  terminal returns awaitingUser itself, so setting it would leak the pause into the next
   *  send). Headless is untouched: `settleTurn` is Session-only and the raise-hand is gated
   *  on `humanPresent`.
   *
   *  `editedPending` is whether THIS send has an unvalidated edit whose gate has not run.
   *  A read-only-spin raise-hand can fire after the model edited earlier this send (before
   *  it started only reading), so — exactly like the ask_user tool pause — we carry that
   *  across the pause (`pausedWithEdit`) so the resume send re-seeds `edited` and gates the
   *  dirty files. Ladder exhaustion passes false: settleGate JUST ran, so nothing is
   *  pending. */
  private raiseHandOrStuck(
    handoff: IHandoff,
    turn: number,
    editedPending: boolean
  ): ISendResult {
    const { result, question } = parkOrRaiseHand(
      handoff,
      this.ctx.tool.humanPresent === true,
      turn
    );

    if (question !== undefined) {
      // Carry a still-unvalidated edit across the pause so the resume gates it (WS-C).
      this.state.pausedWithEdit = editedPending;
      // The HARNESS raised this hand (not the model via a tool call), so frame it as a
      // harness injection — role:"user", exactly like resteers / nudges / expert notes.
      // Attributing it as role:"assistant" would (a) forge harness text as model output
      // and (b) on the ladder path follow acquireResponse's own assistant yield with a
      // second assistant message (a consecutive-assistant shape stricter providers 400 on).
      // The message MUST carry the actual `question` body (block, the errors that won't
      // clear, the ask) — unlike the ask_user TOOL path, there is no tool_call holding it,
      // so without it the human's next-send answer (and --continue, which persists only
      // messages) would be unanchored to any question the model can see.
      this.ctx.messages.push({
        role: "user",
        content:
          "You raised a hand to your human co-pilot — the automatic fixes couldn't clear " +
          `this wall, so the build paused with this question:\n\n${question}\n\n` +
          "Their answer is the next message — apply it and continue.",
      });
      this.report({
        kind: "ask_user",
        task: SESSION_ID,
        // Same `ask_user: <question>` shape the ask_user tool path emits — render/ansi.ts
        // renders event.message verbatim, so raise-hand and tool asks look identical.
        message: `ask_user: ${question}`,
      });
    }

    return result;
  }

  /** Drive one send to a terminal result, then mine the send's events for
   *  failure→fix lessons (best-effort, never affects the result). The buffer is
   *  reset per send so each maps to one "run". */
  private async drive(
    maxTurns: number,
    checkpointIntervalTurns: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<ISendResult> {
    this.sendEvents.length = 0;

    try {
      const result = await this.driveInner(
        maxTurns,
        checkpointIntervalTurns,
        sendStart,
        opts
      );

      if (result.status === "done") {
        // Fire-and-forget: extract + retain must not block the REPL.
        this.retainDecisionAfterGreen();
      }

      return result;
    } finally {
      await this.consolidateLessons();
    }
  }

  /** Mine the current send's events into the project's learned-rules memory. */
  private async consolidateLessons(): Promise<void> {
    try {
      const candidates = mineLessons(this.sendEvents);
      const consolidate = this.cfg.consolidateLessons ?? consolidateMemory;
      const active = await consolidate(this.ctx.cwd, candidates, MEMORY_RUN_ID);

      if (active > 0) {
        this.report({
          kind: "ttsr",
          task: SESSION_ID,
          message: `memory: ${String(active)} learned rule(s) active in .tsforge/learned-rules.json`,
        });
      }
    } catch (err) {
      // Memory is supplementary — never let it break a send.
      trace("session.memory", err);
    }
  }

  /** Bank id for decision memory, or null when no provider is configured. */
  decisionMemoryBankId(): string | null {
    return this.decisionMemory?.bankId ?? null;
  }

  /** List retained decision strings from the external provider (empty if none). */
  async listDecisionMemory(): Promise<readonly string[]> {
    if (this.decisionMemory === null) {
      return [];
    }

    try {
      return await this.decisionMemory.list();
    } catch (err) {
      trace("session.decision-memory.list", err);

      return [];
    }
  }

  /** Clear the external decision bank (fail-soft). Phase 1 ledger is separate. */
  async forgetDecisionMemory(): Promise<void> {
    if (this.decisionMemory === null) {
      return;
    }

    try {
      await this.decisionMemory.forget();
    } catch (err) {
      trace("session.decision-memory.forget", err);
    }
  }

  /** Retain a curated decision into the external bank (fail-soft, visible). */
  async retainDecision(content: string): Promise<boolean> {
    if (this.decisionMemory === null) {
      return false;
    }

    const bankId = this.decisionMemory.bankId;

    try {
      // Bound MCP/HTTP retains so a hung backend cannot stall a green send.
      const ok = await withDeadline(
        this.decisionMemory.retain(content),
        false,
        MEMORY_REQUEST_TIMEOUT_MS
      );

      this.report({
        kind: "tool",
        task: SESSION_ID,
        message: ok
          ? `decision memory: retained to bank ${bankId}`
          : `decision memory: retain failed for bank ${bankId}`,
      });

      return ok;
    } catch (err) {
      trace("session.decision-memory.retain", err);
      this.report({
        kind: "tool",
        task: SESSION_ID,
        message: `decision memory: retain failed for bank ${bankId}`,
      });

      return false;
    }
  }

  /**
   * Explicit curated retain (`/remember`). Returns false when memory is not
   * configured, the text is empty after trim, or the backend reject/timeouts.
   */
  async rememberDecision(text: string): Promise<boolean> {
    if (this.decisionMemory === null) {
      return false;
    }

    const curated = buildDecisionRetainText({
      kind: "session",
      summary: text,
    });

    if (curated === null) {
      return false;
    }

    return this.retainDecision(curated);
  }

  /**
   * After a green send, extract durable product/architecture decisions and
   * retain them (best-effort, non-blocking). On unless
   * `providers.memory.autoRetain` is set to `false`.
   *
   * Never dumps the raw user prompt — that filled banks with harness chatter.
   */
  private retainDecisionAfterGreen(): void {
    if (!this.autoRetain || this.decisionMemory === null) {
      return;
    }

    const userText = this.lastUserPrompt;
    const assistantText = lastAssistantContent(this.ctx.messages);

    void this.runExtractAndRetain(userText, assistantText);
  }

  private async runExtractAndRetain(
    userText: string,
    assistantText: string
  ): Promise<void> {
    const abort = new AbortController();

    try {
      const decisions = await withDeadline(
        extractDecisions(this.provider, userText, assistantText, {
          signal: abort.signal,
        }),
        [],
        EXTRACT_DECISION_TIMEOUT_MS,
        { abort }
      );

      for (const decision of decisions) {
        const text = buildDecisionRetainText({
          kind: "session",
          summary: decision,
        });

        if (text === null) {
          continue;
        }

        await this.retainDecision(text);
      }
    } catch (err) {
      trace("session.decision-memory.extract", err);
    }
  }

  /** The `ttsrManager` completion option, or nothing when TTSR is off. */
  private ttsrCallOption():
    { ttsrManager: TtsrManager } | Record<string, never> {
    return this.ttsrManager === null ? {} : { ttsrManager: this.ttsrManager };
  }

  /** Apply a mid-stream TTSR fire (inject guidance, retry). Returns true when it
   *  fired (the caller should `continue`). */
  private handleTtsrFired(
    res: IModelResponse,
    turn: number,
    turnStart: number,
    sendStart: number
  ): boolean {
    if (res.ttsrFired === undefined) {
      return false;
    }

    applyTtsrInterrupt(
      res.ttsrFired,
      this.state,
      this.ctx.messages,
      this.report,
      SESSION_ID,
      this.ttsrManager
    );
    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    return true;
  }

  /** Handle an ABORTED stream: a degenerate repetition loop (bounded recovery or
   *  a terminal stop) or a token-cap truncation (bounded smaller-call resteer).
   *  Returns a stop result, "retry" to continue with a forced tool, or null when
   *  the response is neither. Bumps the matching counter itself. */
  private degenerationStop(
    res: IModelResponse,
    recoveries: { degenerations: number; truncations: number },
    turn: number,
    turnStart: number,
    sendStart: number
  ): ISendResult | "retry" | null {
    if (res.degenerated === true) {
      const stop = this.degenerationRecovery(recoveries.degenerations, turn);

      recoveries.degenerations += 1;
      emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

      return stop ?? "retry";
    }

    if (
      this.truncationResteer(
        res,
        recoveries.truncations,
        turn,
        turnStart,
        sendStart
      )
    ) {
      recoveries.truncations += 1;

      return "retry";
    }

    return null;
  }

  /** True when a token-cap truncation was re-steered (bounded): pushes the
   *  smaller-call resteer + reports it. See TRUNCATION_RESTEER. */
  private truncationResteer(
    res: IModelResponse,
    truncations: number,
    turn: number,
    turnStart: number,
    sendStart: number
  ): boolean {
    if (res.truncated !== true || truncations >= MAX_TIMEOUT_RECOVERIES) {
      return false;
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: `⚠ response hit the token cap mid-tool-call — dropped the partial call, re-steering to a smaller one (${String(truncations + 1)}/${String(MAX_TIMEOUT_RECOVERIES)})`,
    });
    this.ctx.messages.push({ role: "user", content: TRUNCATION_RESTEER });
    emitTiming(this.report, SESSION_ID, turn, turnStart, sendStart);

    return true;
  }

  /** Handle a read-only spin: the model keeps calling tools but never touches an
   *  editable file, so the gate-based progress guards never get a cycle to judge
   *  and the run would otherwise grind to the turn backstop. Re-steer toward a
   *  concrete change (build) or an answer (conversational) a bounded number of
   *  times, then stop honestly. Returns a stop result, "retry" to re-steer +
   *  continue, or null when the streak is still under the limit. The caller resets
   *  the streak on "retry" so each re-steer gets a fair window before the next. */
  /** The CONCRETE outstanding gate failure(s) to inject into a read-only-spin
   *  re-steer. Observed: the model runs `bun run build`, sees exit 0, declares
   *  "done", and spins re-verifying — never acting on the gate's REAL unmet
   *  requirement (e.g. entity-coverage: 3 entities have no UI). A passing build is
   *  NOT the gate; naming the actual red turns the spin into targeted work. */
  private outstandingGateNote(): string {
    const errs = this.state.prevGateErrors;

    if (errs.length === 0) {
      return "";
    }

    // Show EVERY outstanding gate error — the model can't finish work it can't
    // see. The ceiling is only a runaway backstop for a degenerate cascade, not
    // a feedback limit (was 5, which hid most errors and caused whack-a-mole).
    const MAX_GATE_ERRORS_SHOWN = 200;
    const lines = errs
      .slice(0, MAX_GATE_ERRORS_SHOWN)
      .map((e) => `  - ${e.message}`)
      .join("\n");
    const more =
      errs.length > MAX_GATE_ERRORS_SHOWN
        ? `\n  …and ${String(errs.length - MAX_GATE_ERRORS_SHOWN)} more`
        : "";

    return (
      `\n\nA passing \`bun run build\` is NOT the gate. The gate is still RED — ` +
      `do the OUTSTANDING work now, do not re-verify the build:\n${lines}${more}`
    );
  }

  private historyMetaSpinStop(
    streak: number,
    turn: number,
    edited: boolean
  ): Promise<ISendResult | "retry" | null> {
    if (streak < HISTORY_META_RESTEER_AT) {
      return Promise.resolve(null);
    }

    if (streak >= HISTORY_META_PARK_AT) {
      const handoff = buildSyntheticHandoff(
        STUCK_REASON.historyMetaSpin,
        this.state.prevGateErrors.map((e) => e.message),
        "model kept submitting empty/incomplete create/edit args"
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message:
          "⚠ model kept submitting empty/incomplete create/edit args after " +
          "re-steering — stopped (would otherwise burn the turn cap). " +
          "Read the file and pass real content / oldString / newString.",
      });

      return Promise.resolve(this.raiseHandOrStuck(handoff, turn, edited));
    }

    if (streak !== HISTORY_META_RESTEER_AT) {
      return Promise.resolve(null);
    }

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message:
        "⚠ empty/incomplete create/edit loop — steering toward read + real write",
    });
    this.ctx.messages.push({
      role: "user",
      content: HISTORY_META_RESTEER,
    });

    return Promise.resolve("retry");
  }

  private async readonlySpinStop(
    streak: number,
    recoveries: number,
    turn: number,
    edited: boolean
  ): Promise<ISendResult | "retry" | null> {
    if (streak < READONLY_STREAK_LIMIT) {
      return null;
    }

    if (recoveries >= MAX_READONLY_RECOVERIES) {
      // This is a "stuck" exit too, so the EXPERT handoff gets its shot HERE before
      // we give up — build v3 died on exactly this path (256 turns of read-only
      // spinning) without ever reaching the expert, because the rescue was only
      // wired to settleGate's stalled-park. If a stronger model repairs the blocking
      // file, keep looping instead of stopping.
      if (
        this.hasGate &&
        (await tryExpertRescue(this.ctx, this.state, this.state.prevGateErrors))
      ) {
        return "retry";
      }

      const errorMessages = this.state.prevGateErrors.map((e) => e.message);
      const handoff = buildSyntheticHandoff(
        "readonly-spin",
        errorMessages,
        "model called only read-only tools without making progress"
      );

      this.report({
        kind: "stuck",
        task: SESSION_ID,
        message:
          "⚠ model kept calling read-only tools without making progress after " +
          "re-steering — stopped. Narrow the task or steer toward a concrete step.",
      });

      // With a human present, raise a hand on this spin instead of parking (WS-C3). The
      // spin can follow edits made earlier THIS send (before the model started only
      // reading), so carry `edited` across the pause — the resume must re-gate them.
      return this.raiseHandOrStuck(handoff, turn, edited);
    }

    const gateNote = this.hasGate ? this.outstandingGateNote() : "";

    this.report({
      kind: "tool",
      task: SESSION_ID,
      message: this.hasGate
        ? `⚠ only reading, no edits — steering toward a concrete change${gateNote.length > 0 ? ` (re-pointed at ${String(this.state.prevGateErrors.length)} outstanding gate error(s))` : ""}`
        : "⚠ only reading, no answer — steering toward a reply",
    });
    this.ctx.messages.push({
      role: "user",
      content: this.hasGate
        ? READONLY_RESTEER_BUILD + gateNote
        : READONLY_RESTEER_ANSWER,
    });

    return "retry";
  }

  private async driveInner(
    maxTurns: number,
    checkpointIntervalTurns: number,
    sendStart: number,
    opts: ISendOptions
  ): Promise<ISendResult> {
    const { report } = this;
    // The gate confirms CHANGES, not answers: it fires only once the model has
    // actually edited a file this turn. So a pure question never triggers a gate
    // run (even with one configured) — and an auto-detected gate stays unobtrusive.
    // Normally false — but if a prior send PAUSED on ask_user right after an edit,
    // re-seed so this resume send gates that still-unvalidated edit (WS-C). Do NOT
    // clear the flag here: it is cleared only when the gate actually RUNS (settleTurn).
    // A resume that exits via a non-yielding path (interrupted, stuck, degeneration,
    // read-only spin) never reaches the gate — clearing here would drop the pending
    // edit before it was validated, permanently skipping it. Leaving the flag set
    // means the NEXT send re-seeds and re-attempts the gate until it truly runs.
    let edited = this.state.pausedWithEdit === true;
    // How many times this send the model dumped file contents as a chat message
    // instead of calling `create` (the narrate-instead-of-build failure).
    let buildNudges = 0;
    // Set after we nudge a narrating model: on the NEXT turn we FORCE a tool call
    // (tool_choice "required") instead of "auto". vLLM's required path follows the
    // tool schema strictly — so the model can't narrate (or emit malformed tool
    // syntax) again on a turn where we already know a tool call is the move.
    let forceTool = false;
    // Bounded recoveries this send: repetition loops (force a concrete tool
    // call) and token-cap truncations (re-steer to a smaller call) — counted
    // in one object so the abort handler can bump the right one itself.
    const recoveries = { degenerations: 0, truncations: 0 };
    // Times a model request timed out this send — a single over-long turn must not
    // throw away prior progress; we re-steer to a small turn and continue.
    let timeouts = 0;
    // Consecutive tool-call turns this send that touched NO editable file (the
    // read-only spin), and how many times we've re-steered out of one. The
    // gate-based guards can't see this — they only fire after a write.

    this.forceWriteTools = false;
    let readonlyStreak = 0;
    let readonlyRecoveries = 0;
    let historyMetaStreak = 0;
    // Edits since the last incremental check — drives "check every few edits".
    let editsSinceCheck = 0;
    // Edits since the last FULL gate — forces a gate when the model edit-churns
    // without yielding (see FULL_GATE_EVERY), so the build runs + the guards tick.
    let editsSinceGate = 0;
    const checkEvery = this.cfg.checkEvery ?? CHECK_EVERY;

    // Each drive (a send, or a staged build PHASE) converges independently, so the
    // net-progress watermark must start fresh — otherwise phase 2 inherits phase 1's
    // low error count and the guard misfires (its errors never beat the old best).
    this.state.bestErrorCount = Number.POSITIVE_INFINITY;
    this.state.noNewLow = 0;
    // WS-B is per-drive: fresh checkpoint, watermark, and revert budget each drive (the
    // budget bounds TOTAL reverts for this drive; carrying it across drives could starve a
    // later phase or let one thrash indefinitely).
    this.state.nearGreenCheckpoint = undefined;
    this.state.nearGreenBest = undefined;
    this.state.nearGreenRollbacks = 0;
    // #77: the rotation window + flag are per-drive (a stale flag would inject the completion-only
    // steer on a fresh drive with no evidence).
    this.state.nearGreenSamples = undefined;
    this.state.nearGreenSpikeGap = undefined;
    this.state.nearGreenRotation = undefined;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      this.driveTurn = turn;
      const turnStart = performance.now();

      // Heartbeat: emit a checkpoint progress event every checkpointIntervalTurns
      // without terminating — allows checkpoint persistence + monitoring.
      emitCheckpoint(report, SESSION_ID, turn, checkpointIntervalTurns);

      // Inject any messages the user typed while the run was in flight, so they
      // steer the next model turn instead of waiting for the run to finish.
      this.injectSteer(opts.steer);
      // Append the bound-plan tree when it changed, so every turn sees current
      // checklist status without rewriting the prompt prefix.
      this.injectPlanTree();
      // History hygiene (stale read dumps, superseded write-guards) is NOT run
      // per turn: rewriting a message the model already sent invalidates the
      // server's prefix cache from that point, which costs far more prefill than
      // the tokens it reclaims. It runs inside compaction instead, where the
      // prefix is being rebuilt regardless.
      await this.maybeAutoCompact(opts.signal);

      report({
        kind: "cycle",
        task: SESSION_ID,
        cycle: turn,
        message: `turn ${turn}: asking model`,
      });

      // Ask the model, recovering from a request timeout (re-steer + continue,
      // keeping prior turns) instead of abandoning the whole build on one over-long
      // turn. A caller abort or any other error propagates to send()'s handler.
      const ask = await this.acquireResponse(
        forceTool,
        timeouts,
        turn,
        turnStart,
        sendStart,
        opts
      );

      if (ask.kind === "stop") {
        return ask.result;
      }

      if (ask.kind === "retry") {
        timeouts += 1;
        forceTool = true; // next turn: forced, thinking-off → a small clean call

        continue;
      }

      const res = ask.res;

      forceTool = false;

      // A learned/built-in TTSR rule fired mid-stream — inject its corrective
      // guidance and retry (checked before degeneration so the fix lands first).
      // This is how memory's failure→fix lessons reach an interactive session.
      if (this.handleTtsrFired(res, turn, turnStart, sendStart)) {
        continue;
      }

      // Aborted-stream recovery: a degenerate repetition loop (bounded: force a
      // concrete tool call next turn, then give up — see degenerationRecovery)
      // or a token-cap truncation (bounded smaller-call resteer; the broken
      // call was DROPPED at assembly, never executed with empty args).
      const deg = this.degenerationStop(
        res,
        recoveries,
        turn,
        turnStart,
        sendStart
      );

      if (deg === "retry") {
        forceTool = true;

        continue;
      }

      if (deg !== null) {
        return deg;
      }

      // Still working — run the calls, apply the read-only-spin guard, and keep
      // going (we gate only when it stops). The guard's bookkeeping lives in
      // runToolTurn so this loop body stays lean.
      if (res.toolCalls.length > 0) {
        const w = await this.handleWorkingTurn(
          res,
          {
            edited,
            editsSinceCheck,
            editsSinceGate,
            checkEvery,
            readonlyStreak,
            readonlyRecoveries,
            historyMetaStreak,
          },
          turn,
          turnStart,
          sendStart
        );

        edited = w.edited;
        editsSinceCheck = w.editsSinceCheck;
        editsSinceGate = w.editsSinceGate;
        readonlyStreak = w.readonlyStreak;
        readonlyRecoveries = w.readonlyRecoveries;
        historyMetaStreak = w.historyMetaStreak;
        forceTool = w.forceTool;

        if (w.action !== "continue") {
          return w.action;
        }

        continue;
      }

      // The model yielded with no tool calls: a conversational reply, the
      // narrate-instead-of-build failure, or a gate confirm. resolveYield maps it
      // to a terminal result or "continue" (carrying the next forceTool/nudge
      // state), keeping this loop body lean.
      const y = await this.resolveYield(
        res,
        edited,
        buildNudges,
        turn,
        turnStart,
        sendStart
      );

      buildNudges = y.buildNudges;
      forceTool = y.forceTool;
      // A yield runs the gate (when edited), so the churn counter starts fresh.
      editsSinceGate = 0;

      if (this.checklistContinuePending) {
        this.checklistContinuePending = false;
        readonlyStreak = 0;
        readonlyRecoveries = 0;
        this.forceWriteTools = false;
      }

      if (y.action !== "continue") {
        return y.action;
      }
    }

    report({
      kind: "stuck",
      task: SESSION_ID,
      cycles: maxTurns,
      message: `stuck (hit the ${maxTurns}-turn runaway crash-guard — progress guards never tripped, which is anomalous; re-steer or narrow the task)`,
    });

    return {
      status: "stuck",
      turns: maxTurns,
    };
  }
}

/** Emit a checkpoint heartbeat event on cadence. */
function emitCheckpoint(
  report: Reporter,
  taskId: string,
  turn: number,
  interval: number
): void {
  if (turn > 1 && turn % interval === 0) {
    report({
      kind: "checkpoint",
      task: taskId,
      cycle: turn,
      message: `checkpoint: turn ${turn}`,
    });
  }
}
