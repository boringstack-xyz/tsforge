import { basename, join, relative, isAbsolute } from "node:path";
import { rm } from "node:fs/promises";
import type { ITask } from "../spec";
import type { IChatMessage, IToolCall } from "../inference";
import {
  type validate,
  runAccept,
  sameErrorSet,
  type ErrorParser,
  type ErrorSet,
  type IErrorItem,
} from "../validate";
import { TOOL_NAME } from "../agent/agent.constants";
import { isInScope } from "../lib/scope";
import { trace } from "../lib/trace";
import type { PolicyMode, IPolicyRules } from "../policy";
import { fileExists } from "../lib/fs";
import {
  snapshotFixState,
  buildAutoFixSummary,
  type IFixCounts,
  type IAutoFixSummary,
} from "./autofix-summary";
import { RUN_STATUS, STUCK_REASON, LOOP_LIMITS } from "./loop.constants";
import type {
  IRunResult,
  Reporter,
  EscalationRung,
  IHandoff,
} from "./loop.types";
import { flags } from "../config";
import type { IStackProfile } from "../stack-detection";
import { gateFeedback } from "./feedback";
import { notifyGateRailChanged } from "./session-gate-view";
import {
  attributionLeadIn,
  classifyFromGate,
  type FailureClass,
} from "../eval/failure-class";
import type { IConventionProvider } from "./conventions-provider";
import {
  shouldCheckpoint,
  shouldRollback,
  nextCompletionPhase,
  errorSetSignature,
  isNearGreenRotation,
  NEAR_GREEN_N,
  MAX_NEAR_GREEN_ROLLBACKS,
  MAX_NEAR_GREEN_SPIKE_GAP,
  type INearGreenCheckpoint,
  type INearGreenSample,
} from "./near-green-checkpoint";
import { formPurityRollbackAppendix } from "./near-green-form-purity";
import { antiPatchNearGreenLead } from "./near-green-antipatch";
// The SHARED rollback substrate (aliased — turn.ts has its own polish-only `snapshotFiles`
// returning a plain Map). `snapshotFilesForRollback` captures an IFileSnapshot and
// `restoreFiles` rewrites edited files AND tombstones files a spray created (incl.
// binaries/assets) — a plain content map would leave those on disk and keep the gate red.
import {
  snapshotFiles as snapshotFilesForRollback,
  restoreFiles,
} from "./file-snapshot";
import {
  buildSteerMessage,
  essentialMessages,
  isTrivialDiagnosis,
  STEER_LADDER_MAX,
} from "./feedback/steer";
import {
  runExpertHandoff,
  resolveExpertAsk,
  resolveStuckFile,
  type ExpertAsk,
} from "./expert-handoff";
import {
  executeTool,
  shouldPauseForAskUser,
  askUserQuestion,
  shouldPauseForPresentPlan,
  presentPlanMessage,
  type SpawnAgentFn,
  type IToolContext,
  type ICheckOutcome,
} from "./tools";
import {
  astGrepFix,
  dropRedundantAnnotations,
  stripLiteralCasts,
} from "./astgrep-fix";
import {
  EDIT_TOOL,
  DELETE_FILE_TOOL,
  EDIT_LINES_TOOL,
  CREATE_TOOL,
  RUN_TOOL,
  READ_TOOL,
  LSP_TOOLS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WEB_BROWSE_TOOL,
  BROWSER_TABS_TOOL,
  BROWSER_ADOPT_TOOL,
  BROWSER_OPEN_TOOL,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_READ_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_CLOSE_TOOL,
  NOTE_TOOL,
  PACKAGE_INFO_TOOL,
  PACKAGE_DOCS_TOOL,
  buildPullConventionsTool,
  SCRIPT_TOOL,
  GIT_CONTEXT_TOOL,
  GIT_WRITE_TOOL,
  GITHUB_READ_TOOL,
  GITHUB_WRITE_TOOL,
  LINEAR_READ_TOOL,
  LINEAR_WRITE_TOOL,
  LINEAR_START_TOOL,
  NOTION_READ_TOOL,
  NOTION_WRITE_TOOL,
  SENTRY_READ_TOOL,
  SENTRY_WRITE_TOOL,
  READ_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  CHECK_TOOL,
  ASK_USER_TOOL,
  TASK_LIST_TOOL,
  TASK_FOCUS_TOOL,
  TASK_COMPLETE_TOOL,
  TASK_UNCOMPLETE_TOOL,
  TASK_ADD_TOOL,
  TASK_UPDATE_TOOL,
  PRESENT_PLAN_TOOL,
  PROPOSE_PRODUCT_PLAN_TOOL,
} from "../agent";
import { TsService } from "../lsp";
import type { McpRegistry } from "../mcp";
import {
  formatFiles,
  isWorkspaceContainer,
  activePackageRoots,
  packageRelativeTouched,
  packageLabel,
  capturePackageGatePolicy,
  packageLintPacks,
  type FileLinter,
  type IPackageGatePolicy,
  type IPackageGateCaptureOpts,
} from "../gate";
import type { IGate } from "../gate/gate-runner";
import {
  buildMetaRuleContext,
  runMetaRules,
  subtractMetaBaseline,
  META_RULES,
  type IMetaRuleViolation,
  type MetaBaseline,
} from "../meta-rules";
import { runWriteGuard } from "./write-guard";
import { ExternalPackDriftError } from "../rule-packs/drift-error";
import { upsertGateFeedback } from "./context-hygiene";

/**
 * The shared turn primitives — one tool-using-conversation step and the
 * deterministic gate that confirms "done". Both drivers compose these: `runTask`
 * (the RED-first, drive-to-green eval wrapper in run.ts) and the interactive
 * `Session` (the CLI's persistent conversation). Keeping them here means there is
 * exactly ONE turn-loop and ONE gate, never two implementations to drift apart.
 */

// The base tools the model always has, plus the semantic LSP/search tools
// (rename/type_at/find_references/symbol_search/diagnostics/organize_imports/
// search). The LSP set is for NAVIGATING an existing codebase. Measured (money
// vs react-board, 2026-06-06): handing the 7 nav tools to a SCRATCH create-from-
// spec task DILUTES the create path — the small model narrates/explores
// ("let me check existing files…") instead of emitting `create`, and stalls.
// react-board (existing code) used them cleanly. So gate them on whether there
// is existing code to navigate. TSFORGE_NO_LSP_TOOLS=1 forces them off entirely.
const BASE_TOOLS = [
  READ_TOOL,
  RUN_TOOL,
  EDIT_TOOL,
  CREATE_TOOL,
  DELETE_FILE_TOOL,
];

const HASHLINE_TOOLS = [EDIT_LINES_TOOL];

// The full advertisable set: base + hashline + LSP nav + the (gated) web tools.
// Its element union is also the return TYPE of toolsFor — every narrower runtime
// list below is assignable to it, so each tool stays independently gated.
/** Every tool the harness can advertise — the element union all the narrower
 *  per-context lists below are assignable to (each tool stays independently gated
 *  in toolsFor). */
type AdvertisedTool =
  | (typeof BASE_TOOLS)[number]
  | (typeof HASHLINE_TOOLS)[number]
  | (typeof LSP_TOOLS)[number]
  | typeof WEB_FETCH_TOOL
  | typeof WEB_SEARCH_TOOL
  | typeof WEB_BROWSE_TOOL
  | typeof BROWSER_TABS_TOOL
  | typeof BROWSER_ADOPT_TOOL
  | typeof BROWSER_OPEN_TOOL
  | typeof BROWSER_NAVIGATE_TOOL
  | typeof BROWSER_READ_TOOL
  | typeof BROWSER_CLICK_TOOL
  | typeof BROWSER_SCROLL_TOOL
  | typeof BROWSER_SCREENSHOT_TOOL
  | typeof BROWSER_CLOSE_TOOL
  | typeof NOTE_TOOL
  | typeof PACKAGE_INFO_TOOL
  | typeof PACKAGE_DOCS_TOOL
  | ReturnType<typeof buildPullConventionsTool>
  | typeof SCRIPT_TOOL
  | typeof GIT_CONTEXT_TOOL
  | typeof GIT_WRITE_TOOL
  | typeof GITHUB_READ_TOOL
  | typeof GITHUB_WRITE_TOOL
  | typeof LINEAR_READ_TOOL
  | typeof LINEAR_WRITE_TOOL
  | typeof LINEAR_START_TOOL
  | typeof NOTION_READ_TOOL
  | typeof NOTION_WRITE_TOOL
  | typeof SENTRY_READ_TOOL
  | typeof SENTRY_WRITE_TOOL
  | typeof READ_IMAGE_TOOL
  | typeof GENERATE_IMAGE_TOOL
  | typeof CHECK_TOOL
  | typeof ASK_USER_TOOL
  | typeof TASK_LIST_TOOL
  | typeof TASK_FOCUS_TOOL
  | typeof TASK_COMPLETE_TOOL
  | typeof TASK_UNCOMPLETE_TOOL
  | typeof TASK_ADD_TOOL
  | typeof TASK_UPDATE_TOOL
  | typeof PRESENT_PLAN_TOOL
  | typeof PROPOSE_PRODUCT_PLAN_TOOL;

/** Which extra capability backends are configured this run — decides whether the
 *  image tools are advertised. Resolved once by the driver (run.ts) so
 *  advertisement stays synchronous here. Both default off. */
export interface ICapabilityFlags {
  vision?: boolean;
  imageGen?: boolean;
  /** The `github` capability = the user's consent to git/GitHub operations
   *  (gh installed + authenticated, TSFORGE_NO_GITHUB unset). Resolved once by the
   *  driver. When on, the git/GitHub tools are advertised; the WRITE handlers also
   *  hard-check `ctx.github` so a forced call can't push/comment with it off. */
  github?: boolean;
  /** The `linear` capability = the user's consent to Linear operations (a `linear`
   *  MCP server configured + connected, TSFORGE_NO_LINEAR unset). Resolved once by
   *  the driver from the MCP registry. When on, the Linear verbs are advertised; the
   *  WRITE handlers also hard-check `ctx.linear`. */
  linear?: boolean;
  /** The `notion` / `sentry` capabilities = consent (their MCP server configured +
   *  connected). When on, their curated verbs are advertised; the write handlers
   *  also hard-check `ctx.notion` / `ctx.sentry`. */
  notion?: boolean;
  sentry?: boolean;
  /** The Chrome research bridge is listening (TSFORGE_BROWSER, port owned by this
   *  process). When on, the browser_* tools + `note` are advertised. */
  browser?: boolean;
}

/** Free, local web tools (fetch + search) — advertised only under TSFORGE_WEB so
 *  eval sweeps stay deterministic and offline by default. Available on both
 *  scratch and existing-code runs when enabled (unlike the LSP nav set). */
function webTools(): AdvertisedTool[] {
  return flags.webTools()
    ? [
        WEB_FETCH_TOOL,
        WEB_SEARCH_TOOL,
        WEB_BROWSE_TOOL,
        PACKAGE_INFO_TOOL,
        PACKAGE_DOCS_TOOL,
      ]
    : [];
}

/** Read-only git introspection — existing-code runs only (greenfield has no
 *  history), withheld under TSFORGE_NO_GIT_TOOL. Not an LSP tool (no tsconfig
 *  needed), so it survives TSFORGE_NO_LSP_TOOLS — it's gated only on history. */
function gitTools(hasExistingCode: boolean): AdvertisedTool[] {
  return hasExistingCode && !flags.noGitTool() ? [GIT_CONTEXT_TOOL] : [];
}

/** Programmatic Tool Calling — ON by default (withheld under TSFORGE_NO_SCRIPT).
 *  Available on both scratch and existing-code runs; the plan-mode path rejects it
 *  at dispatch (it's a mutating tool), so a script can't write while planning. */
function scriptTools(): AdvertisedTool[] {
  return flags.scriptTool() ? [SCRIPT_TOOL] : [];
}

/** git/GitHub first-class tools — advertised only when the `github` capability is
 *  on (gh installed + authenticated). `github_read` is read-only (vcs_read, plan-safe);
 *  `git_write`/`github_write` mutate (vcs_write, withheld/denied in plan/ci/dontAsk).
 *  Available on existing-code AND scratch runs — a fresh repo still commits/pushes. */
function githubTools(caps: ICapabilityFlags): AdvertisedTool[] {
  return caps.github === true
    ? [GITHUB_READ_TOOL, GIT_WRITE_TOOL, GITHUB_WRITE_TOOL]
    : [];
}

/** Linear first-class verbs — advertised only when the `linear` capability is on (a
 *  `linear` MCP server configured + connected). `linear_read` is read-only
 *  (integration_read, plan-safe); `linear_write`/`linear_start` mutate
 *  (withheld/denied in plan/ci/dontAsk). Curated verbs over MCP — the raw
 *  `mcp__linear__*` tools are suppressed from advertisement unless TSFORGE_LINEAR_RAW. */
function linearTools(caps: ICapabilityFlags): AdvertisedTool[] {
  return caps.linear === true
    ? [LINEAR_READ_TOOL, LINEAR_WRITE_TOOL, LINEAR_START_TOOL]
    : [];
}

/** Notion knowledge verbs — advertised only when the `notion` capability is on.
 *  Reads are plan-safe (integration_read); writes gated (integration_write). */
function notionTools(caps: ICapabilityFlags): AdvertisedTool[] {
  return caps.notion === true ? [NOTION_READ_TOOL, NOTION_WRITE_TOOL] : [];
}

/** Sentry error verbs — advertised only when the `sentry` capability is on. Read is
 *  plan-safe; the resolve write is gated (integration_write). */
function sentryTools(caps: ICapabilityFlags): AdvertisedTool[] {
  return caps.sentry === true ? [SENTRY_READ_TOOL, SENTRY_WRITE_TOOL] : [];
}

/** Chrome research bridge — the user's real browser, read + navigate only.
 *  Screenshot only with a vision backend (the model views it via read_image). */
export function browserTools(caps: ICapabilityFlags): AdvertisedTool[] {
  if (caps.browser !== true) {
    return [];
  }

  return [
    BROWSER_TABS_TOOL,
    BROWSER_ADOPT_TOOL,
    BROWSER_OPEN_TOOL,
    BROWSER_NAVIGATE_TOOL,
    BROWSER_READ_TOOL,
    BROWSER_CLICK_TOOL,
    BROWSER_SCROLL_TOOL,
    ...(caps.vision === true ? [BROWSER_SCREENSHOT_TOOL] : []),
    BROWSER_CLOSE_TOOL,
  ];
}

/** `note` — append-only research notes. Offered whenever the model can research
 *  (web or browser tools on). */
function noteTools(caps: ICapabilityFlags): AdvertisedTool[] {
  return caps.browser === true || flags.webTools() ? [NOTE_TOOL] : [];
}

/** Image capability tools — each advertised only when its backend is configured
 *  (caps resolved by the driver). read_image (vision) and generate_image are
 *  independent, so a vision-only or gen-only setup offers just the one. */
function imageTools(caps: ICapabilityFlags): AdvertisedTool[] {
  return [
    ...(caps.vision === true ? [READ_IMAGE_TOOL] : []),
    ...(caps.imageGen === true ? [GENERATE_IMAGE_TOOL] : []),
  ];
}

export function toolsFor(
  hasExistingCode: boolean,
  caps: ICapabilityFlags = {},
  offerConventions = false,
  offerCheck = false,
  offerAskUser = false,
  conventionTopics: readonly string[] = [],
  offerTaskTools = false,
  offerPresentPlan = false,
  offerProductPlan = false
): AdvertisedTool[] {
  const web = webTools();
  const git = gitTools(hasExistingCode);
  const github = githubTools(caps);
  const linear = linearTools(caps);
  const notion = notionTools(caps);
  const sentry = sentryTools(caps);
  const script = scriptTools();
  const image = imageTools(caps);
  const research = [...browserTools(caps), ...noteTools(caps)];

  // check — the callable, structured acceptance gate. Offered ONLY when the caller
  // wires a `runCheck` seam on the tool context (the boringstack build does); a
  // plain scratch/logic task leaves it off so the base set stays minimal. Same
  // per-backend opt-in shape as pull_conventions — decoupled from every flag.
  const check: AdvertisedTool[] = offerCheck ? [CHECK_TOOL] : [];

  // ask_user (WS-C1) — the co-pilot's raise-hand. Offered only when the caller opts in
  // (an interactive co-pilot session); off for autonomous eval/CI so the model isn't
  // tempted to ask a question no one will answer. The handler ALSO guards on
  // ctx.humanPresent, so a stray call in an unattended run returns "proceed" not a hang.
  // present_plan is its own opt-in: policy `interactive` must not steal the plan tool.
  // offeredToolsFor withholds present_plan outside plan mode.
  const askUser: AdvertisedTool[] = offerAskUser ? [ASK_USER_TOOL] : [];
  const presentPlan: AdvertisedTool[] = offerPresentPlan
    ? [PRESENT_PLAN_TOOL]
    : [];
  // propose_product_plan — greenfield product planning's structured-output tool.
  // Offered only during Session.setGreenfieldMode(true), independent of
  // present_plan/plan mode (a different flow: pre-approval discovery for a NEW
  // product, not read-only exploration of an existing one).
  const productPlan: AdvertisedTool[] = offerProductPlan
    ? [PROPOSE_PRODUCT_PLAN_TOOL]
    : [];

  // Session-bound checklist tools — only when a plan was approved for this session
  // (`activePlanId`). Off until then so plan-mode exploration isn't cluttered.
  const taskTools: AdvertisedTool[] = offerTaskTools
    ? [
        TASK_LIST_TOOL,
        TASK_FOCUS_TOOL,
        TASK_COMPLETE_TOOL,
        TASK_UNCOMPLETE_TOOL,
        TASK_ADD_TOOL,
        TASK_UPDATE_TOOL,
      ]
    : [];

  // pull_conventions — a read-only knowledge tool the model calls to fetch the
  // BoringStack how-to BEFORE writing that kind of code (the PULL complement to the
  // harness PUSHing guides on first violation). Offered per BUILD BACKEND, not per
  // flag: a backend with a convention library (boringstack) opts in via the session
  // config; a plain scratch/logic task leaves it off so the base tool set stays
  // minimal (tools-gating). Decoupled from the web flag on purpose — the conventions
  // are the stack's, not "web".
  const conventions: AdvertisedTool[] = offerConventions
    ? [buildPullConventionsTool(conventionTopics)]
    : [];

  if (flags.noLspTools() || !hasExistingCode) {
    return [
      ...BASE_TOOLS,
      ...HASHLINE_TOOLS,
      ...conventions,
      ...check,
      ...askUser,
      ...presentPlan,
      ...productPlan,
      ...taskTools,
      ...web,
      ...git,
      ...github,
      ...linear,
      ...notion,
      ...sentry,
      ...script,
      ...image,
      ...research,
    ];
  }

  // existing-code: base + LSP nav + (gated) web + (gated) git + (gated) script.
  return [
    ...BASE_TOOLS,
    ...HASHLINE_TOOLS,
    ...conventions,
    ...check,
    ...askUser,
    ...presentPlan,
    ...taskTools,
    ...LSP_TOOLS,
    ...web,
    ...git,
    ...github,
    ...linear,
    ...notion,
    ...sentry,
    ...script,
    ...image,
    ...research,
  ];
}

/** The model wrote prose but issued NO tool call while the gate is still red —
 *  a narration-without-action turn (seen on money + react-board). Nudge it to ACT. */
export const NO_TOOL_CALL_NUDGE =
  "You replied with text but called no tool. Writing code or a plan in your " +
  "message does NOT change any file. Don't describe the next step — emit the " +
  "actual tool call now (create/edit to change a file, read/search to inspect one).";

/** A build turn ended with the model writing whole files INTO its chat message
 *  (fenced code blocks) instead of calling `create` — the narrate-instead-of-build
 *  failure. A chat message is never written to disk, so this nudges it to act. */
export const BUILD_NUDGE =
  "STOP — you wrote file contents in your message, but that does NOT create any " +
  "files on disk and cannot run. Write them for real now: call `create` once per " +
  "file (relative path + full contents), ONE file per call, starting with the " +
  "first. Do not paste code into your reply again — emit the create tool call.";

/** Tool-EXECUTION options — the fields `toolContextFor` threads into every
 *  IToolContext (grouped so the spread is `...ctx.tool`, not eight conditional
 *  spreads). Always-present and mutable: the Session flips these mid-run
 *  (plan mode, per-send signal, setupWeb wiring). */
export interface ILoopCtxTool {
  /**
   * Extra absolute dirs allowed for read/run/search beyond cwd (see
   * {@link IToolContext.extraRoots}). Default absent/`[]`.
   */
  extraRoots?: readonly string[];
  /** The build ADAPTER's convention library (injected seam). Spread into every
   *  IToolContext (so `pull_conventions` reads it) and read by the reactive PUSH
   *  (`injectFeedback`). Absent ⇒ no stack conventions. Keeps stack CONTENT out of
   *  the core loop. */
  conventions?: IConventionProvider;
  /** Topic ids successfully pulled this session (pull-before-first-write). */
  pulledTopics?: Set<string>;
  /** Cancellation for the in-flight turn — threaded into tool `run` commands and
   *  the gate so a Ctrl-C (or a kill-timeout) reaches the child processes, not
   *  just the model call. Set per-send by the Session. */
  signal?: AbortSignal;
  /** PLAN MODE (set via Session.setPlanMode): threaded into the tool context so
   *  mutating tools are rejected at dispatch — the model only plans. */
  readOnly?: boolean;
  /** Active policy mode for the unified action-policy layer (executeTool). Plan
   *  mode forces `"plan"`; otherwise the base mode from CLI/config (default
   *  `"default"`). Threaded into the tool context. */
  policyMode?: PolicyMode;
  /** Config-driven policy rules (deny/allow/ask) threaded to the tool context. */
  policyRules?: IPolicyRules;
  /** Whether an interactive per-action approval path exists (false today) — a POLICY
   *  signal, threaded to the tool context. NOT "a human is watching". */
  interactive?: boolean;
  /** WS-C: a human is present to answer `ask_user` (the interactive REPL). Threaded to
   *  the tool context; distinct from `interactive` so co-pilot presence never loosens
   *  policy. Absent ⇒ ask_user proceeds without pausing. */
  humanPresent?: boolean;
  /** Connected MCP servers (opt-in via tsforge.config.json `mcpServers`). Threaded
   *  into the tool context so `mcp__<server>__<tool>` calls dispatch to them. */
  mcpRegistry?: McpRegistry;
  /** Chrome research bridge state (TSFORGE_BROWSER). Threaded into the tool
   *  context so the browser_* handlers route through it. */
  browser?: IToolContext["browser"];
  /** GitHub capability = consent (gh installed + authenticated). Threaded into the
   *  tool context so the git/GitHub WRITE handlers can hard-check it and fail closed
   *  when off — even on a salvaged/forced call. See {@link IToolContext.github}. */
  github?: boolean;
  /** Linear capability = consent (a `linear` MCP server configured + connected).
   *  Threaded into the tool context so the Linear WRITE handlers hard-check it and
   *  fail closed when off. See {@link IToolContext.linear}. */
  linear?: boolean;
  /** Notion / Sentry capabilities = consent, threaded into the tool context so the
   *  write handlers hard-check them. See {@link IToolContext.notion}/{@link IToolContext.sentry}. */
  notion?: boolean;
  sentry?: boolean;
  /** Files the agent created/edited this session (cwd-relative, forward slashes).
   *  Accumulated by `runToolCalls`; change-scoped meta-rules (test-sibling-required)
   *  enforce on this set, so they cover what the agent wrote regardless of git.
   *  Shared BY REFERENCE with the tool context. */
  touched?: Set<string>;
  /** Successful `read` paths this send — survey grace for readonly-spin. */
  surveyed?: Set<string>;
  /** Wired by the interactive CLI: run one read-only specialist subagent (the
   *  `spawn_agent` tool). Threaded into the tool context. */
  spawnAgent?: SpawnAgentFn;
  /** Wired by the interactive CLI: preview a just-generated image inline (the
   *  `generate_image` tool calls it). Threaded into the tool context. */
  previewImage?: IToolContext["previewImage"];
  /** Optional edit guard set by a build backend (e.g. boringstack) to veto a
   *  destructive edit. Threaded into the tool context so `edit`/`edit_lines`
   *  enforce it; declared here so the seam is typed, not accidental. */
  editGuard?: IToolContext["editGuard"];
  /** Optional callable-gate runner set by a build backend (WS-G): runs the gate on
   *  demand for the `check` tool. Threaded into the tool context; declared here so
   *  the seam is typed, not accidental. Absent ⇒ `check` isn't offered. */
  runCheck?: IToolContext["runCheck"];
  /** Gate runner for `task_complete` — separate from `runCheck` so checklist
   *  completion does not enable the model's on-demand `check` tool. */
  runTaskGate?: IToolContext["runTaskGate"];
  /** Session-bound plan id — task_* tools read/write this plan. */
  activePlanId?: string | null;
  /** Fired after a task_* tool persists a plan change (Tasks rail refresh). */
  onPlanChanged?: IToolContext["onPlanChanged"];
  /** present_plan proposal callback (REPL renders pending plan). */
  onPlanPresented?: IToolContext["onPlanPresented"];
  /** propose_product_plan's schema-aware validator — a closure
   *  runGreenfieldPlanning builds with the concrete stack schema in scope. Set
   *  only while Session.setGreenfieldMode(true) is active. */
  productPlanValidate?: IToolContext["productPlanValidate"];
  /** propose_product_plan proposal callback (REPL renders the PLAN card). */
  onProductPlanProposed?: IToolContext["onProductPlanProposed"];
  /** Gate rail refresh after settle / rollback. */
  onGateChanged?: IToolContext["onGateChanged"];
}

/** Gate/VALIDATION options — what `settleGate` and the write-guard consume. */
export interface ILoopCtxGate {
  parse: ErrorParser | undefined;
  /** Write-time single-file linter (the gate's eslint rules, applied per write so
   *  moat violations tsc can't see surface inline). Omitted ⇒ type-only guard. */
  lintFile?: FileLinter;
  /** Opt into the SCOPED format janitor in the auto-fix step: a strict eslint --fix +
   *  prettier over the files the model wrote this session (`ctx.tool.touched`), deferring
   *  to the project's own prettier. Set by the interactive CLI. Off ⇒ no formatter
   *  subprocess per turn (bare test/eval loops stay fast). */
  coreFormat?: boolean;
  /** Detected stack profile — determines which rule packs are enabled. */
  stackProfile?: IStackProfile;
  /** Rule severity overrides from tsforge.config.json (maps rule ID to "error" | "warn" | "off"). */
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>;
  /** When set, the gate's command output is streamed here live (the CLI wires
   *  this so a slow gate like `vite build` + browser isn't silent dead air).
   *  Omitted on the eval path, where output is just captured for scoring.
   *  `flush()` (when present) is called once the gate exits to emit any final
   *  line the process printed without a trailing newline. */
  onGateChunk?: ((text: string) => void) & { flush?: () => void };
  /** The composed gate the loop runs each cycle. Always set by the driver
   *  (runTask/Session) — defaults to a command gate from task.accept. */
  runner: IGate;
  /** Explicit editable file the expert should repair when the stuck error set is
   *  entirely out of the model's scope (set per feature, e.g. the resource service).
   *  Avoids re-guessing from `task.files` and keeps the expert inside scope. */
  expertRescueTarget?: string;
  /** Meta-rule violations present on the PRISTINE scaffold, captured once at build
   *  start. Subtracted from each cycle's violations so pre-existing scaffold debt the
   *  model is frozen out of never blocks a feature or clutters feedback. */
  metaBaseline?: MetaBaseline;
  /** Per-package frozen policies for workspace-container fan-out (meta + gate). */
  workspacePolicies?: Map<string, IPackageGatePolicy>;
  /** CLI overlays (--profile / --strict-floor-only) applied on first package capture. */
  workspaceCapture?: IPackageGateCaptureOpts;
  /** Per-package meta baselines for workspace containers (keyed by package abs path). */
  workspaceMetaBaselines?: Map<string, MetaBaseline>;
}

/** The coordinator's per-task working context: the flat identity/reporting core,
 *  plus the tool-execution (`tool`) and gate/validation (`gate`) option groups. */
export interface ILoopCtx {
  task: ITask;
  cwd: string;
  tsService: TsService | null;
  report: Reporter;
  messages: IChatMessage[];
  tool: ILoopCtxTool;
  gate: ILoopCtxGate;
}

/** Mutable state threaded across turns (the gradient the loop descends). */
export interface ILoopState {
  prevGateErrors: ErrorSet;
  gateNoProgress: number;
  /** WS-C: set when the model called `ask_user` this turn — carries the question. The
   *  drive loop ENDS the send (surfacing the question) so the human's next send is the
   *  reply. Cleared once consumed. Absent on autonomous runs (ask_user isn't offered). */
  pendingAskUser?: string;
  /** Set when a present_plan proposal VALIDATED this turn: the plan is rendered and
   *  awaiting the human, so the send ends here — real models otherwise keep exploring
   *  and the human's "approve" typed meanwhile is swallowed as mid-send steering.
   *  Unlike pendingAskUser this ends the send NORMALLY (no awaitingUser), so the next
   *  line routes through plan-approval detection, not answer routing. */
  pendingPlanPause?: boolean;
  /** WS-C: an ask_user pause ended a send that had ALSO edited a file. The `edited`
   *  accumulator is per-send, so the resume send would start `edited=false` and skip the
   *  gate — leaving that edit unvalidated. This flag re-seeds `edited` on the resume send
   *  so the pending edit IS gated. */
  pausedWithEdit?: boolean;
  /** Fewest gate errors seen so far (the convergence watermark) + how many cycles
   *  since it last hit a NEW low. Drives the net-progress stop: a churning build
   *  whose error SET keeps shuffling (so `gateNoProgress` resets) and whose errors
   *  never survive `samePersist` consecutive cycles evades both other guards — but
   *  if the count isn't trending DOWN it isn't converging, regardless of turn count. */
  bestErrorCount: number;
  noNewLow: number;
  /** Per-error-key (file:rule) survival count: how many consecutive gate cycles
   *  each error has persisted. Drives the primary `samePersist` no-progress stop. */
  errorAge: Map<string, number>;
  lastGateCount: number;
  /** Gate error count from the previous settle (before lastGateCount was updated).
   *  Feeds progress-aware steer headers when the count dropped but a block remains. */
  priorGateCount?: number;
  edits: number;
  regressions: number;
  /** Count of TTSR rule interrupts this task. Hard cap at 3 to prevent loops. */
  ttsrInterrupts: number;
  /** Steering ladder: how many times a convergence guard has tripped and escalated
   *  a steer this run (0 = never stalled). Each escalation resets the guards so the
   *  model gets fresh cycles at a more directive steer; a run only parks once this
   *  exceeds the ladder (see checkStuck). */
  steerLevel: number;
  /** The steer message to inject on the NEXT feedback push (set when a guard trips,
   *  cleared once injected). Undefined when no steer is pending. */
  pendingSteer?: string;
  /** Set at the top steer rung: the NEXT feedback push first PRUNES the flailing
   *  conversation to its essentials (system + original task), so the model's new
   *  strategy isn't anchored to the dead-end transcript. Cleared once applied. */
  resetContext?: boolean;
  /** Convention topics already PUSHED this run (dedupe): the boringstack how-to for
   *  a rule is attached the FIRST time it's tripped, once per topic — see
   *  `unseenGuidesForErrors`. */
  pushedGuides?: Set<string>;
  /** The backend ships a convention library, so the loop may PUSH its how-to guides
   *  beside gate errors. Set from `ISessionConfig.pullConventions` — the SAME signal
   *  that offers the `pull_conventions` tool, so push + pull activate together. A
   *  plain build (no convention backend) leaves it off and gets neither. */
  conventionsEnabled?: boolean;
  /** PLATEAU backstop (oscillation detector): consecutive gate cycles since the error
   *  count last hit a new ALL-TIME low. Unlike the fine guards it does NOT reset on an
   *  error-set rotation or a non-improving re-visit — only genuine progress (a new low)
   *  clears it — so an oscillating model can't hide from it. See `LOOP_LIMITS.plateauGates`. */
  redGates?: number;
  /** Lowest gate-error count seen this run, NEVER reset on escalation (unlike
   *  `bestErrorCount`) — the stable baseline the plateau backstop measures against. */
  plateauBest?: number;
  /** WS-B near-green checkpoint: the on-disk scope-file snapshot captured at the last
   *  near-green low (1..N errors). If a later gate SPRAYS past it, the loop reverts to
   *  this state instead of letting the model build on the regression. Flag-gated. */
  nearGreenCheckpoint?: INearGreenCheckpoint;
  /** WS-B: TOTAL reverts this DRIVE (reset only at the drive boundary — resetDriveConvergence
   *  / driveInner — NOT on capture). At MAX_NEAR_GREEN_ROLLBACKS, WS-B stops reverting AND
   *  capturing and hands the stall to the escalation ladder; monotonic-per-drive so a model
   *  that sprays → reverts → re-settles can't earn a fresh budget each re-arm and thrash. */
  nearGreenRollbacks?: number;
  /** WS-B: the best (lowest) error count the CURRENT checkpoint protects. WS-B's OWN
   *  watermark — NOT checkStuck's plateauBest, which uses commonGatePhase and is unreliable
   *  with meta errors — so the checkpoint refreshes to a better OR lateral near-green count
   *  (e.g. 2→1, or 1→1 different error) instead of a spray reverting to a worse/older saved
   *  state. Reset on green and at the drive boundary; lowered as the checkpoint refreshes. */
  nearGreenBest?: number;
  /** WS-B: the model is in the COMPLETION phase — it reached an all-completion-class state
   *  (only add-code errors: unused i18n keys / not reachable) and is now building the demanded
   *  create/edit/delete UI. This PERSISTS across the resulting error spike (which is MIXED —
   *  new compile errors + the shrinking completion errors), because a per-cycle all-completion
   *  check flips false the moment the model starts adding code, re-arming the rollback + the
   *  "undo" banner mid-add. Set when all errors are completion-class; held while ANY completion
   *  error remains; cleared when none remain (completion done → WS-B re-engages) or on green /
   *  at the drive boundary. While set, WS-B does not roll back and the banner says "build it". */
  completionPhase?: boolean;
  /** WS-B rotation (#77): the trailing {count, error-set signature} samples of the near-green
   *  cycles the drive has visited (curr in 1..N). Spikes above N are ignored (not pushed, not
   *  cleared) so a transient regression between two near-green visits doesn't reset the window;
   *  completion-phase cycles are NOT recorded (their churn is legitimate, not rotation); cleared on
   *  green / at the drive boundary. `isNearGreenRotation` reads the last ROTATION_WINDOW of these —
   *  it needs the COUNT (to require a plateau) as well as the signature (the changing identity). */
  nearGreenSamples?: INearGreenSample[];
  /** WS-B rotation (#77): count of CONSECUTIVE spikes (cycles above N) since the last near-green
   *  sample. Reset to 0 on each near-green sample; past MAX_NEAR_GREEN_SPIKE_GAP the window is
   *  stale and cleared so far-apart near-green visits can't combine into a false rotation. */
  nearGreenSpikeGap?: number;
  /** WS-B rotation (#77): true when the near-green error set has been ROTATING (fixing one error
   *  spawns another at the same low count). Set from `isNearGreenRotation(nearGreenSamples)`; while
   *  set, injectFeedback prepends the completion-only steer. Cleared on green. Flag-gated. */
  nearGreenRotation?: boolean;
  /** Guard-specific identity of the current stuck block (canonical, not the raw error
   *  set). Derived from the guard that fired: samePersist → single error key,
   *  gateStuckRepeats → sorted-join of current keys, plateau → normalized count|keys
   *  over the oscillation window. Empty string when no stall is active. */
  blockFingerprint?: string;
  /** Ring buffer (length = LOOP_LIMITS.noProgressCycles = 12) of sorted error key-sets,
   *  one per gate cycle. The plateau branch of fingerprintFor reads "recurring keys"
   *  (present in ≥2 window entries) over this window to detect stable oscillation blocks
   *  that don't improve. Pushed each gate, cleared when the block fingerprint moves. */
  recentGateFingerprints?: string[];
  /** Which escalation rungs have been tried for each block fingerprint. A rung is
   *  recorded tried only when: (1) it was applied on a previous cycle, (2) the next
   *  gate shows the block fingerprint unchanged, and (3) the pending pair is recorded
   *  here. Per-rung state so the ladder doesn't re-fire a rung for the same block. */
  triedLeversByBlock?: Map<string, Set<EscalationRung>>;
  /** The rung applied on the previous cycle, paired with its block fingerprint at
   *  application time. On the NEXT gate, if the recomputed fingerprint equals
   *  pendingBlockFingerprint, the rung is recorded into triedLeversByBlock (block
   *  unmoved → lever failed); either way both are cleared. */
  pendingRung?: EscalationRung | null;
  /** Fingerprint of the block when pendingRung was applied. */
  pendingBlockFingerprint?: string | null;
  /** R1 (self-diagnose) is two-phase: Phase A diagnosis-only (no writes, sets this),
   *  Phase B act-on-diagnosis (sets pendingRung = R1). Only recorded tried after Phase B.
   *  Cleared once Phase B runs or escalation fires. */
  pendingDiagnosisSteer?: string | null;
  /** Captured when samePersist identifies the persisted key (in checkStuck). Used by
   *  R3 (narrow) to filter gate feedback down to the single most-persistent error,
   *  shrinking the surface the model must reason about. Cleared when the block
   *  fingerprint moves (genuine progress). */
  focusError?: string | null;
  /** Per-call model overrides (temperature, reasoning effort, thinking budget) applied
   *  on the NEXT askModel call, then cleared. Set by R2 (reason-more) rung entry.
   *  Provider-aware: best-effort, no-op where unsupported. Auxiliary calls (planning,
   *  judge, compaction, expert) stay on defaults. */
  pendingModelOverride?: {
    temperature?: number;
    reasoningEffort?: "low" | "medium" | "high";
    enableThinking?: boolean;
    thinkingTokenBudget?: number;
  } | null;
  /** Harness-owned failure class from the last settleGate classifyFromGate call.
   *  Cleared to `none` on green. Feeds feedback lead-in and handoff. */
  lastFailureClass?: FailureClass;
  /** Dominant rule/code accompanying lastFailureClass when present. */
  lastFailureDetail?: string;
}

/** Build the in-process TS LanguageService if the project has a tsconfig. Guarded
 *  so a setup failure can't break the loop (the `tsc -p` gate stays authority).
 *  Never at a workspace-container root: any tsconfig there governs NO package
 *  (often litter from an old greenfield write), and a whole-monorepo program
 *  with broken per-package resolution makes every LSP answer a phantom while
 *  its synchronous typechecks stall the interactive event loop for minutes. */
export async function buildTsService(cwd: string): Promise<TsService | null> {
  try {
    if (
      (await fileExists(cwd, "tsconfig.json")) &&
      !isWorkspaceContainer(cwd)
    ) {
      return new TsService(cwd);
    }
  } catch (err) {
    // degrade silently — the gate runs regardless
    trace("buildTsService", err);
  }

  return null;
}

export { isPhantomRouteError } from "./write-guard";

/** Whether a `mutated` path counts toward re-gating + the change scope. Mutating
 *  handlers self-enforce scope before they write, so this is mostly a backstop —
 *  EXCEPT package.json: `add_dependency` is sanctioned to rewrite the manifest even
 *  when it sits outside the task's editable globs, and that change MUST re-gate so
 *  the supply-chain meta-rules run (unpinned / git / tarball deps). A narrow-scoped
 *  task would otherwise let a `bun add` bypass the gate entirely. */
export function countsAsMutation(file: string, taskFiles: string[]): boolean {
  return basename(file) === "package.json" || isInScope(file, taskFiles);
}

/** Add paths (cwd-relative, forward-slashed) to the session's change set — the
 *  scope change-scoped gate rules (test-sibling-required) enforce on. Lazy-inits
 *  `touched` so a custom loop runner that forgot to seed it self-heals rather than
 *  silently dropping enforcement. */
function recordTouched(ctx: ILoopCtx, files: readonly string[]): void {
  const touched = (ctx.tool.touched ??= new Set<string>());

  for (const f of files) {
    const rel = isAbsolute(f) ? relative(ctx.cwd, f) : f;

    touched.add(rel.replaceAll("\\", "/"));
  }
}

/** Build the per-call tool context from the loop context. `ctx.tool` groups
 *  exactly the optional fields IToolContext threads through, so ONE spread
 *  replaces the old eight per-field conditional spreads. `touched` rides the
 *  spread BY REFERENCE, so `create` sees files the model authored in PRIOR turns
 *  (recordTouched mutates this same Set post-write). */
function toolContextFor(ctx: ILoopCtx, report: Reporter): IToolContext {
  return {
    cwd: ctx.cwd,
    files: ctx.task.files,
    report,
    task: ctx.task.id,
    tsService: ctx.tsService,
    ...ctx.tool,
  };
}

/** Stable per-call key, matching the `toolCallId` the loop emits below. */
function callKey(call: IToolCall, index: number): string {
  return call.id ?? `call_${index}`;
}

/** One position in the tool-call list, kept with its original index so the tool
 *  reply carries the right `toolCallId` even after we group spawns. */
interface IIndexedCall {
  readonly call: IToolCall;
  readonly index: number;
}

/** WS-C: the model raised its hand via ask_user. Record the question so the drive loop
 *  ends this send, surface it as an `ask_user` event, and feed a CLEAN tool result back
 *  (NEVER the raw sentinel) — the tool_call still gets its result (no dangling call →
 *  400) and the human's next send is the answer. */
function interceptAskUser(
  call: IToolCall,
  index: number,
  result: string,
  ctx: ILoopCtx,
  state: ILoopState
): void {
  const question = askUserQuestion(result);

  state.pendingAskUser = question;
  ctx.report({
    kind: "ask_user",
    task: ctx.task.id,
    message: `ask_user: ${question}`,
  });
  ctx.messages.push({
    role: "tool",
    content:
      "Your question was posed to the human; their answer arrives as the next " +
      "message. Stop here and wait for it.",
    toolCallId: callKey(call, index),
  });
}

/**
 * Run ONE non-spawn tool call: execute it, apply the write-guard + mutation
 * accounting, and push its tool reply. Returns whether it touched an editable
 * file (⇒ the caller re-gates). `state.edits` is bumped per in-scope write.
 */
async function runOneToolCall(
  call: IToolCall,
  index: number,
  ctx: ILoopCtx,
  state: ILoopState
): Promise<boolean> {
  let touchedEditable = false;
  // EVERY in-scope file written during this tool call — a Set, not a single
  // path, because ONE call can write MANY files (a `script` program's edit/create
  // stubs each report through this callback). We read the path from the handler's
  // `edit`/`create` event (already normalized), not the raw arg, so a write the
  // handler normalized into scope still counts. Fires only on a successful write.
  const wrote = new Set<string>();
  // Files mutated by a tool the model did NOT hand-write (semantic ops, scaffolds):
  // they re-gate and join the change scope but skip the per-write guard.
  const mutated: string[] = [];

  const report: Reporter = (event) => {
    if (
      (event.kind === "edit" || event.kind === "create") &&
      event.file !== undefined &&
      isInScope(event.file, ctx.task.files)
    ) {
      wrote.add(event.file);
    }

    if (event.mutated !== undefined) {
      for (const f of event.mutated) {
        if (countsAsMutation(f, ctx.task.files)) {
          mutated.push(f);
        }
      }
    }

    ctx.report(event);
  };

  const result = await executeTool(call, toolContextFor(ctx, report));

  // WS-C: the model raised its hand — record the question, surface it, feed a clean
  // tool result, and end here (no editable file touched). Gated on the CALL being
  // ask_user (shouldPauseForAskUser) so a forged sentinel from another tool can't hijack
  // control flow.
  if (shouldPauseForAskUser(call.name, result)) {
    interceptAskUser(call, index, result, ctx, state);

    return false;
  }

  // A VALIDATED present_plan is the same kind of boundary: the proposal is rendered
  // and awaiting the human, so the send must end — feed the clean (sentinel-stripped)
  // result back and stop. Gated on the CALL being present_plan so no other tool can
  // forge an end-of-send. Rejected proposals return plain text and fall through, so
  // the model revises in the same send.
  if (shouldPauseForPresentPlan(call.name, result)) {
    state.pendingPlanPause = true;
    ctx.messages.push({
      role: "tool",
      content: presentPlanMessage(result),
      toolCallId: callKey(call, index),
    });

    return false;
  }

  let feedback = "";
  // F19 plugin drift is a HARD failure the guard deliberately rethrows — but
  // the tool has already executed by now, so the throw must not unwind before
  // the tool RESPONSE message lands: an assistant tool_calls with no matching
  // tool message is invalid history strict APIs 400 on ever after (and it gets
  // persisted). Capture, push the response, THEN rethrow.
  let driftError: ExternalPackDriftError | null = null;

  if (wrote.size > 0) {
    touchedEditable = true;
    state.edits += wrote.size;
    const written = [...wrote];

    recordTouched(ctx, written);

    for (const path of written) {
      try {
        feedback += await runWriteGuard(ctx, path);
      } catch (err) {
        if (err instanceof ExternalPackDriftError) {
          driftError = err;
          feedback += `\n[write-guard] ${err.message}`;
          break;
        }

        throw err;
      }
    }
  }

  if (mutated.length > 0) {
    touchedEditable = true;
    recordTouched(ctx, mutated);
  }

  const toolContent = `${result}${feedback}`;

  ctx.messages.push({
    role: "tool",
    content: toolContent,
    toolCallId: callKey(call, index),
  });

  // Write-guard appendices age out in pruneEphemeralToolResidue; create/edit
  // args stay full on the wire (stubbing them taught empty resubmits).

  if (driftError !== null) {
    throw driftError;
  }

  return touchedEditable;
}

/**
 * Run a CONSECUTIVE run of read-only `spawn_agent` calls concurrently — they
 * never write, so ordering among them is irrelevant and overlapping them is the
 * whole point (the CLI callback caps real concurrency + emits tree events). A
 * failure is isolated to its own tool reply (never rejects the batch), and
 * replies are pushed in submission order. Non-spawn tools are NOT part of a batch
 * (the caller treats them as ordering barriers), so an `edit` before a spawn is
 * applied first and the subagent reads post-edit state.
 */
async function runSpawnBatch(
  group: readonly IIndexedCall[],
  ctx: ILoopCtx
): Promise<void> {
  const results = await Promise.all(
    group.map(async ({ call }) => {
      try {
        return await executeTool(call, toolContextFor(ctx, ctx.report));
      } catch (err) {
        return `spawn_agent failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    })
  );

  group.forEach(({ call, index }, k) => {
    ctx.messages.push({
      role: "tool",
      content: results[k] ?? "",
      toolCallId: callKey(call, index),
    });
  });
}

/**
 * Run the model's tool calls in order, reporting whether any touched an editable
 * file (⇒ re-gate). A maximal run of consecutive `spawn_agent` calls executes
 * concurrently as one batch; every other tool runs sequentially and acts as an
 * ordering barrier, so tool effects (edits/mutations) never get reordered around
 * delegation.
 */
export async function runToolCalls(
  toolCalls: readonly IToolCall[],
  ctx: ILoopCtx,
  state: ILoopState
): Promise<boolean> {
  let touchedEditable = false;
  let i = 0;

  while (i < toolCalls.length) {
    const call = toolCalls[i];

    if (call === undefined) {
      i += 1;
      continue;
    }

    if (call.name === TOOL_NAME.spawnAgent) {
      const group: IIndexedCall[] = [];

      while (
        i < toolCalls.length &&
        toolCalls[i]?.name === TOOL_NAME.spawnAgent
      ) {
        const c = toolCalls[i];

        if (c !== undefined) {
          group.push({ call: c, index: i });
        }

        i += 1;
      }

      await runSpawnBatch(group, ctx);
      continue;
    }

    touchedEditable =
      (await runOneToolCall(call, i, ctx, state)) || touchedEditable;
    i += 1;

    // WS-C: ask_user is a real execution BOUNDARY — the human must answer before
    // anything else runs. If this call raised the hand, do NOT execute the sibling
    // calls in the SAME model response (a `[ask_user, create]` batch must not write the
    // file before the human replies); STUB the rest (so no tool_call dangles → no 400)
    // and stop. The model re-issues them, with the answer in hand, on the next send.
    // A validated present_plan is the same boundary: the plan awaits the human.
    if (state.pendingAskUser !== undefined || state.pendingPlanPause === true) {
      stubUnrunCalls(toolCalls, i, ctx);
      break;
    }
  }

  return touchedEditable;
}

/** Push a "not run" tool_result for every remaining tool call from `from` onward, so a
 *  batch cut short by ask_user leaves no dangling tool_call (which the next API request
 *  rejects). Purely bookkeeping — none of the stubbed calls execute. */
function stubUnrunCalls(
  toolCalls: readonly IToolCall[],
  from: number,
  ctx: ILoopCtx
): void {
  for (let i = from; i < toolCalls.length; i += 1) {
    const skipped = toolCalls[i];

    if (skipped !== undefined) {
      ctx.messages.push({
        role: "tool",
        content:
          "Not run: you asked the human a question — wait for their answer, " +
          "then re-issue this call if it's still needed.",
        toolCallId: callKey(skipped, i),
      });
    }
  }
}

/**
 * Deterministic auto-fixes applied before the gate — mechanical fixes the model
 * shouldn't burn turns on. TypeScript's own safe quick-fixes (missing imports,
 * unused) + ast-grep SAFE idiom rewrites (`new Array(n).fill` → `Array.from`).
 * The `tsc -p` gate re-validates, so a bad fix can't ship; never throws.
 */
/** Lazily-initialized per-file fixer counters over a shared map. */
function fixCountsFor(counts: Map<string, IFixCounts>, f: string): IFixCounts {
  let c = counts.get(f);

  if (c === undefined) {
    c = { tsQuickFixes: 0, importsOrganized: 0, idiomRewrites: 0 };
    counts.set(f, c);
  }

  return c;
}

/** Hand the event loop one macrotask turn so stdin/paint stay alive between
 *  synchronous language-service chunks (the janitor runs in the TUI process). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** TS quick-fixes + import hygiene over `files`; returns the total applied. */
async function applyTsQuickFixes(
  ctx: ILoopCtx,
  files: readonly string[],
  counts: Map<string, IFixCounts>
): Promise<number> {
  const { cwd, tsService } = ctx;
  let tsFixed = 0;

  if (tsService === null) {
    return 0;
  }

  for (const f of files) {
    try {
      if (await fileExists(cwd, f)) {
        // The language-service passes below are synchronous CPU work on the
        // interactive process's ONLY thread — without a yield per file, a
        // multi-file janitor pass freezes the TUI (no paint, no input) for
        // its whole duration.
        await yieldToEventLoop();
        tsService.refresh(f);
        const quick = tsService.fixAll(f);
        // Dedupe/sort imports + drop unused ones the model left behind — free
        // mechanical cleanup so it never spends a repair turn on import hygiene.
        const imports = tsService.organizeImports(f);

        tsFixed += quick + imports;

        if (quick > 0) {
          fixCountsFor(counts, f).tsQuickFixes += quick;
        }

        if (imports > 0) {
          fixCountsFor(counts, f).importsOrganized += imports;
        }
      }
    } catch (err) {
      // degrade silently — the gate still runs below
      trace("applyDeterministicFixes.quickFix", err);
    }
  }

  return tsFixed;
}

/** ast-grep idiom rewrites + literal-cast strips; returns the total applied. */
async function applyIdiomRewrites(
  ctx: ILoopCtx,
  files: readonly string[],
  counts: Map<string, IFixCounts>
): Promise<number> {
  const { cwd } = ctx;
  let astFixed = 0;

  for (const f of files) {
    try {
      if (await fileExists(cwd, f)) {
        // Same per-file yield as applyTsQuickFixes — ast-grep parses run on
        // the TUI thread too.
        await yieldToEventLoop();
        let idioms = await astGrepFix(join(cwd, f));

        // Backstop the write-time strip (covers files changed via rename/organize
        // or any path that skipped the write-guard).
        idioms += await stripLiteralCasts(join(cwd, f));
        astFixed += idioms;

        if (idioms > 0) {
          fixCountsFor(counts, f).idiomRewrites += idioms;
        }
      }
    } catch (err) {
      // degrade silently — gate is the authority
      trace("applyDeterministicFixes.astGrep", err);
    }
  }

  return astFixed;
}

async function applyDeterministicFixes(
  ctx: ILoopCtx
): Promise<Map<string, IFixCounts>> {
  const { task, report } = ctx;
  // Scoped to files the model ACTUALLY wrote this session (`ctx.tool.touched`) —
  // never the whole tree. `task.files` defaults to `["**/*"]` in the interactive
  // REPL, and resolving that glob re-expanded to the entire scaffold (capped at
  // MAX_GLOB_FILES) on EVERY gate cycle, so the TS language service re-scanned
  // and "fixed" hundreds of untouched template files each turn — the same
  // whole-repo trap the format step below was already fixed to avoid (see its
  // comment). Matches that precedent instead of duplicating the bug.
  const files = touchedInScope(ctx);
  const counts = new Map<string, IFixCounts>();

  const tsFixed = await applyTsQuickFixes(ctx, files, counts);

  if (tsFixed > 0) {
    report({
      kind: "tool",
      task: task.id,
      message: `tsFixAll: applied ${tsFixed} TypeScript quick-fix(es)`,
    });
  }

  const astFixed = await applyIdiomRewrites(ctx, files, counts);

  if (astFixed > 0) {
    report({
      kind: "tool",
      task: task.id,
      message: `astGrepFix: applied ${astFixed} idiom rewrite(s)`,
    });
  }

  return counts;
}

/** Drop redundant annotations across `files`, degrading silently per-file. */
async function dropRedundantAcross(
  cwd: string,
  files: readonly string[]
): Promise<number> {
  let dropped = 0;

  for (const f of files) {
    if (await fileExists(cwd, f)) {
      try {
        dropped += await dropRedundantAnnotations(join(cwd, f));
      } catch (err) {
        // degrade silently — we revalidate and revert below
        trace("polishOnGreen.dropAnnotations", err);
      }
    }
  }

  return dropped;
}

/**
 * Re-gate after a polish drop using the SAME gate the loop uses
 * (`ctx.gate.runner`), NOT `validate(task, …)`. `validate` runs `task.accept`,
 * which is EMPTY for the boringstack build — it drives an INJECTED gate via
 * `setGate`, not `task.accept` — so `validate` returned a VACUOUS pass and the
 * "revert if regressed" guarantee was dead: dropping a load-bearing annotation
 * (e.g. `: unknown` on `await res.json()`, which suppresses `no-unsafe-*`)
 * shipped green, and only final acceptance caught it — after the feature was
 * already verified. The injected gate runs the real checks (including its own
 * format/autofix), so a drop that changed an inferred type fails here. For
 * `runTask` this is equivalent (its gate runs `accept`).
 *
 * The injected gate can THROW (its composed stages include a judge MODEL call
 * whose provider request can fail transiently). A throw must NOT be trusted as a
 * pass. Returns `passed=false` on any transient failure so the caller reverts.
 * A caller CANCELLATION is not a transient failure — it is captured as `abortErr`
 * and re-thrown by the caller AFTER the rollback, honoring the signal contract.
 */
async function recheckAfterPolish(
  ctx: ILoopCtx,
  cwd: string
): Promise<{ passed: boolean; abortErr: unknown }> {
  let passed = false;
  let abortErr: unknown = null;

  try {
    const recheck = await ctx.gate.runner.run(cwd, {
      ...(ctx.gate.onGateChunk === undefined
        ? {}
        : { onChunk: ctx.gate.onGateChunk }),
      ...(ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }),
    });

    passed = recheck.passed;
  } catch (err) {
    if (ctx.tool.signal?.aborted === true) {
      abortErr = err;
    } else {
      // Transient gate/judge failure → do not trust the drop; caller reverts.
      trace("polishOnGreen.recheck", err);
    }
  } finally {
    // Flush any final newline-less gate line the stream filter still holds
    // (mirrors runGateStep). GUARDED: a throwing flush must never mask the
    // caller's rollback.
    try {
      ctx.gate.onGateChunk?.flush?.();
    } catch (err) {
      trace("polishOnGreen.flush", err);
    }
  }

  return { passed, abortErr };
}

/**
 * On a GREEN task, strip the redundant `const` annotations no stock lint rule
 * catches (over-annotation of call/expression-initialized locals) — then re-gate
 * and REVERT the whole file if anything regressed. Verified-safe: the structural
 * rewrite only sticks when the full gate (incl. prettier --check) stays green,
 * so a drop that changed an inferred type can never ship. Runs once, on the turn
 * the task goes green; a no-op when ast-grep is off or nothing is redundant.
 */
export async function polishOnGreen(ctx: ILoopCtx): Promise<void> {
  const { task, cwd, report } = ctx;

  // Scope the DROP + FORMAT to the files the model WROTE this session that are STILL in
  // the editable scope (`touchedInScope`) — NOT task.files, which defaults to the whole
  // repo in the interactive REPL. dropRedundantAnnotations mutates each file (stripping
  // the dropped annotation's semicolon), so scanning the whole tree would rewrite files
  // the model never touched (the exact thing #103 forbids), and a session-lifetime
  // `touched` could drop annotations in a file `/files` has since removed from scope,
  // which the re-gate wouldn't cover.
  const files = touchedInScope(ctx);

  // The revert SNAPSHOT must cover everything polish could mutate, so a failed re-gate
  // rolls back cleanly. The drop/format only touch `files`, but a spec-provided `task.fix`
  // is an arbitrary command that may EDIT any in-scope file or CREATE new ones — so when
  // one is set, snapshot the whole task scope with the robust rollback substrate: it is
  // uncapped, binary-safe, and TOMBSTONES files the fix created (a plain content map would
  // leave those on disk). No fix ⇒ snapshot just the touched files the drop edits.
  const snapshotScope =
    task.fix !== undefined && task.fix.length > 0
      ? [...new Set([...files, ...task.files])]
      : files;
  const snapshot = await snapshotFilesForRollback(cwd, snapshotScope);
  const dropped = await dropRedundantAcross(cwd, files);

  if (dropped === 0) {
    return;
  }

  // Re-format (the drop strips trailing semicolons) before re-gating. Scoped to the
  // files the model wrote (`ctx.tool.touched`), deferring to the project's own
  // prettier — same guarantee as the auto-fix janitor. A spec-provided `task.fix`
  // still runs too.
  if (task.fix !== undefined && task.fix.length > 0) {
    await runAccept(
      { ...task, accept: task.fix },
      cwd,
      ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }
    );
  }

  if (ctx.gate.coreFormat === true) {
    await formatFiles(cwd, files, {
      timeoutMs: JANITOR_TIMEOUT_MS,
      ...(ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }),
    });
  }

  const { passed, abortErr } = await recheckAfterPolish(ctx, cwd);

  if (passed) {
    report({
      kind: "tool",
      task: task.id,
      message: `polish: dropped ${dropped} redundant annotation(s)`,
    });

    return;
  }

  // A drop changed an inferred type (or the recheck failed/was aborted) — roll the whole
  // file set back to the pre-polish green state (rewrites edited files and tombstones any
  // the fix created).
  await restoreFiles(snapshot);

  // Cancellation was deferred past the rollback so the tree is restored — now honor it.
  if (abortErr !== null) {
    throw abortErr instanceof Error
      ? abortErr
      : new Error("polishOnGreen: re-gate aborted by caller signal");
  }
}

/** Max auto-fixed files to name in the notice before eliding. */
const MAX_AUTOFIX_NAMED = 20;

/** Tell the model which files the janitor reformatted — and WHAT changed in
 *  each (fixer kind + changed-line count) — so the next edit anchors on disk,
 *  not pre-format text, without re-reading files to discover the new state.
 *  Keep the exact `NOTE: auto-fixed` lead: HARNESS_USER_PREFIXES matches it. */
function autoFixNotice(summary: string[]): string {
  const shown = summary.slice(0, MAX_AUTOFIX_NAMED).join(", ");
  const more =
    summary.length > MAX_AUTOFIX_NAMED
      ? ` (+${String(summary.length - MAX_AUTOFIX_NAMED)} more)`
      : "";

  return `NOTE: auto-fixed — ${shown}${more} — the harness rewrote these on disk; re-read before editing; fix only the errors below.`;
}

/**
 * Net-progress guard step: track the fewest gate errors ever seen (the convergence
 * watermark). A new low = real progress → reset the counter; otherwise count a
 * cycle of no improvement. Returns true once the count hasn't beaten its best in
 * `noProgressCycles` cycles — the model is churning without converging (errors
 * shuffle so the whole-set guard resets, and no single error survives `samePersist`,
 * yet it never gets closer to green). Convergence — not a turn count — bounds a run,
 * so a large app may take any number of turns as long as the error count trends down.
 */
export function trackNetProgress(
  state: ILoopState,
  errorCount: number
): boolean {
  if (errorCount < state.bestErrorCount) {
    state.bestErrorCount = errorCount;
    state.noNewLow = 0;
  } else {
    state.noNewLow += 1;
  }

  return state.noNewLow >= LOOP_LIMITS.noProgressCycles;
}

/**
 * Advance each error's per-(file:rule) survival count and return the first error
 * that has now persisted for `samePersist` consecutive gate cycles — the model
 * keeps failing at the SAME thing — or null. Rebuilds the map from the CURRENT
 * keys, so a fixed error's age drops out (no stale growth) and an error that
 * comes back later starts fresh. Catches "stuck on X" even while OTHER errors
 * churn around it (which the whole-set `gateNoProgress` guard misses).
 */
export function trackErrorAges(
  state: ILoopState,
  gateErrors: ErrorSet
): IErrorItem | null {
  const next = new Map<string, number>();
  let stuck: IErrorItem | null = null;

  for (const e of gateErrors) {
    const age = (state.errorAge.get(e.key) ?? 0) + 1;

    next.set(e.key, age);

    if (age >= LOOP_LIMITS.samePersist && stuck === null) {
      stuck = e;
    }
  }

  state.errorAge = next;

  return stuck;
}

/** Derive a guard-specific, stable block identity from loop state + current gate errors.
 *  Returns an empty string when no stall is active. Mirrors checkStuck's guard logic
 *  (samePersist → gateStuckRepeats → plateau) but returns a fingerprint string.
 *
 * PURE HELPER: reads state.errorAge but does NOT mutate it. The call contract
 * is: checkStuck calls trackErrorAges (which increments ages) on the SAME cycle,
 * THEN fingerprintFor reads those incremented ages. This avoids double-increment.
 * In unit tests, seed state.errorAge directly or call trackErrorAges before
 * fingerprintFor so ages are current. Fingerprint string is deterministic: given
 * the same state and errors, always returns the same result. */
export function fingerprintFor(
  state: ILoopState,
  gateErrors: IErrorItem[]
): string {
  // Check samePersist: a single error key surviving >= LOOP_LIMITS.samePersist cycles.
  // READ the already-computed age (set by trackErrorAges this cycle) without re-incrementing.
  // Mirrors checkStuck's logic: return the first error with age >= samePersist.
  let persistedKey: string | null = null;

  for (const e of gateErrors) {
    const age = state.errorAge.get(e.key) ?? 0;

    if (age >= LOOP_LIMITS.samePersist && persistedKey === null) {
      persistedKey = e.key;
    }
  }

  if (persistedKey !== null) {
    return persistedKey;
  }

  // Check gateStuckRepeats: identical error set for >= LOOP_LIMITS.gateStuckRepeats
  // consecutive cycles. sameErrorSet already handles the comparison.
  if (state.gateNoProgress >= LOOP_LIMITS.gateStuckRepeats) {
    const keys = gateErrors.map((e) => e.key).sort();

    return keys.join("|");
  }

  // Plateau / oscillation identity — the FALLBACK block identity for a run that is
  // stuck without a single persisted key or a frozen set. It must fire for ANY active
  // no-new-low streak (`redGates >= 1`), NOT only once `plateauGates` is crossed:
  // once steering begins, escalations re-trip on the faster `steerRetrigger` cadence
  // (which resets `redGates` before it reaches `plateauGates`), so gating on the higher
  // threshold left the identity empty at the exact cycles rungs are applied — rungs then
  // recorded under "" and never accumulated. `redGates` is 0 (and the window cleared)
  // ONLY on genuine progress (a new all-time low), so this correctly returns "" when
  // converging and a STABLE identity while stuck. The window gives recurring keys across
  // the streak (keys present in >= 2 entries) so an A<->B oscillation resolves stably.
  if ((state.redGates ?? 0) >= 1) {
    const window = state.recentGateFingerprints ?? [];

    if (window.length === 0) {
      return "";
    }

    // Count key occurrences across the window.
    const keyCount = new Map<string, number>();

    for (const fingerprint of window) {
      // Each fingerprint in the window is either a single key (from samePersist),
      // a pipe-separated key list (from gateStuckRepeats), or empty.
      if (fingerprint === "") {
        continue;
      }

      const keys = fingerprint.split("|");

      for (const k of keys) {
        keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
      }
    }

    // Recurring keys: present in >= 2 window entries.
    const recurringKeys = Array.from(keyCount.entries())
      .filter(([_k, count]) => count >= 2)
      .map(([k]) => k)
      .sort();

    // Construct the plateau fingerprint: lowWaterCount | sorted recurring keys.
    const lowWater = state.plateauBest ?? 0;

    return `${lowWater}|${recurringKeys.join(";")}`;
  }

  // No stall active.
  return "";
}

/** Push this cycle's sorted error-key set into the oscillation ring buffer that the
 *  plateau branch of `fingerprintFor` reads. Without this the window is always empty
 *  and the plateau branch returns "" — so an OSCILLATING block (rotating error sets,
 *  the 150-turn-thrash case) would have no stable identity and never record rungs.
 *  Capped at `noProgressCycles`; the window is what lets an A<->B oscillation resolve
 *  to a STABLE plateau fingerprint (`${lowWater}|${recurring keys}`). */
function pushGateFingerprint(
  state: ILoopState,
  gateErrors: IErrorItem[]
): void {
  const entry = gateErrors
    .map((e) => e.key)
    .sort()
    .join("|");
  const window = state.recentGateFingerprints ?? [];

  window.push(entry);

  if (window.length > LOOP_LIMITS.noProgressCycles) {
    window.shift();
  }

  state.recentGateFingerprints = window;
}

/** The blocker diagnosis surfaced when a single error persists too long — names
 *  the rule + file + attempt count + the last message, so an interactive session
 *  hands back something the user can act on. */
export function persistDetail(e: IErrorItem): string {
  const where = e.file !== undefined ? ` in ${e.file}` : "";
  const rule = e.rule ?? "the same error";

  return `stuck on ${rule}${where} after ${String(LOOP_LIMITS.samePersist)} attempts (last: ${e.message.slice(0, 140)})`;
}

/**
 * The deterministic gate — the only authority on "done". Auto-fix, run the
 * optional fix command, validate, and return a terminal result (done/stuck) or
 * null to keep going (having fed the failures back into the conversation).
 */
/** Timeout for the scoped format janitor. Higher than the per-write ceiling
 *  (`FORMAT_TIMEOUT_MS`, 30s) because it may format a whole task scope at once (many
 *  files), where a per-write path formats exactly one. */
const JANITOR_TIMEOUT_MS = 120_000;

/** The files the model WROTE this session that are ALSO still in the editable scope.
 *  `ctx.tool.touched` is session-lifetime, but `/files` can narrow `task.files`
 *  mid-session — so the janitor/polish intersect the two: only mutate files the model
 *  wrote AND that the gate (scoped to task.files) will re-validate, never a now-out-of-
 *  scope leftover. With the default whole-repo glob scope this is just `touched`. */
function touchedInScope(ctx: ILoopCtx): string[] {
  return [...(ctx.tool.touched ?? [])].filter((f) =>
    isInScope(f, ctx.task.files)
  );
}

/** STEP 1 — deterministic auto-fix: run the janitor fixers (TS quick-fixes,
 *  ast-grep, the optional `task.fix` command, then a scoped eslint --fix + prettier)
 *  and return which files they changed, so the model is told exactly what moved under
 *  it (else it re-fixes already-fixed style and edits now-stale text → rejects).
 *  Exported for unit tests. */
export async function autoFixStep(ctx: ILoopCtx): Promise<IAutoFixSummary> {
  const { task, cwd, report } = ctx;
  const beforeFix = await snapshotFixState(cwd, task.files);

  const fixCounts = await applyDeterministicFixes(ctx);

  if (task.fix !== undefined && task.fix.length > 0) {
    await runAccept(
      { ...task, accept: task.fix },
      cwd,
      ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }
    );
  }

  // Scoped format janitor: strict eslint --fix + prettier over the files the model
  // ACTUALLY wrote this session (`ctx.tool.touched`) — never the whole tree, and NOT
  // `task.files`, which in the interactive REPL defaults to the whole repo (`["**/*"]`)
  // and would re-expand to it. The old whole-repo `prettier --write .` reformatted
  // thousands of untouched files (with tsforge's bundled prettier, not the project's),
  // producing huge spurious diffs in real repos. `formatFiles` defers to the project's
  // own prettier. Opt-in (the CLI sets it) so a bare test/eval loop doesn't spawn a
  // formatter every turn.
  if (ctx.gate.coreFormat === true) {
    await formatFiles(cwd, touchedInScope(ctx), {
      timeoutMs: JANITOR_TIMEOUT_MS,
      ...(ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }),
    });
  }

  // Content-verified change set: a touched-but-identical file is NOT reported
  // (the mtime-only detector sent the model re-reading files that never changed).
  const autoFix = buildAutoFixSummary(
    beforeFix,
    await snapshotFixState(cwd, task.files),
    fixCounts,
    task.fix !== undefined && task.fix.length > 0
  );

  if (autoFix.files.length > 0) {
    report({
      kind: "tool",
      task: task.id,
      message: `auto-fixed ${String(autoFix.files.length)} file(s) (prettier/eslint/imports) — noted to the model`,
    });
  }

  return autoFix;
}

/** STEP 2 — run the gate command (tsc/eslint/tests/…): announce it on live
 *  streams, run the injected gate runner, and flush any final newline-less output line. */
async function runGateStep(
  ctx: ILoopCtx,
  turn: number
): Promise<Awaited<ReturnType<typeof validate>>> {
  const { task, report } = ctx;

  if (ctx.gate.onGateChunk !== undefined) {
    report({
      kind: "tool",
      task: task.id,
      message:
        turn > 0 ? `⚙ running gate · turn ${String(turn)}…` : "⚙ running gate…",
    });
  }

  const gate = await ctx.gate.runner.run(ctx.cwd, {
    ...(ctx.gate.onGateChunk === undefined
      ? {}
      : { onChunk: ctx.gate.onGateChunk }),
    ...(ctx.tool.signal === undefined ? {} : { signal: ctx.tool.signal }),
  });

  // The gate process has exited — flush any final newline-less line the stream
  // filter is still holding so it reaches the terminal.
  ctx.gate.onGateChunk?.flush?.();

  return gate;
}

/** STEP 3 — meta-rules: project structure invariants the gate command can't
 *  express (e.g. test-sibling-required), change-scoped to the files the AGENT
 *  wrote this session. Best-effort: a throwing rule degrades to no violations.
 *  Workspace containers run meta per touched child package (not the bag root). */
async function runMetaRulesStep(ctx: ILoopCtx): Promise<IMetaRuleViolation[]> {
  try {
    const changed = [...(ctx.tool.touched ?? [])];

    if (isWorkspaceContainer(ctx.cwd)) {
      return await runWorkspaceMetaRules(ctx, changed);
    }

    const metaContext = buildMetaRuleContext(
      ctx.cwd,
      ctx.gate.stackProfile?.packs ?? [],
      changed
    );

    const violations = runMetaRules(
      META_RULES,
      metaContext,
      ctx.gate.ruleOverrides
    );

    // Subtract pristine-scaffold debt the model is frozen out of (no-op if unset).
    return subtractMetaBaseline(violations, ctx.gate.metaBaseline);
  } catch (err) {
    // Degrade silently — meta-rules are supplementary to the gate
    trace("runMetaRules", err);

    return [];
  }
}

/** Fan meta-rules out to each touched package under a workspace container. */
async function runWorkspaceMetaRules(
  ctx: ILoopCtx,
  changed: readonly string[]
): Promise<IMetaRuleViolation[]> {
  const packages = activePackageRoots(ctx.cwd, changed);

  if (packages.length === 0) {
    return [];
  }

  const policies =
    ctx.gate.workspacePolicies ?? new Map<string, IPackageGatePolicy>();
  const capture = ctx.gate.workspaceCapture ?? {};

  ctx.gate.workspacePolicies ??= policies;

  const all: IMetaRuleViolation[] = [];

  for (const pkg of packages) {
    let policy = policies.get(pkg);

    if (policy === undefined) {
      policy = await capturePackageGatePolicy(pkg, capture);
      policies.set(pkg, policy);
    }

    const pkgTouched = packageRelativeTouched(ctx.cwd, pkg, changed);
    const packs = packageLintPacks(policy);
    const violations = runMetaRules(
      META_RULES,
      buildMetaRuleContext(pkg, packs, pkgTouched),
      policy.ruleOverrides
    );
    const label = packageLabel(pkg);
    const relocated = violations.map((v) => ({
      ...v,
      file: join(label, v.file.replace(/^\.\//u, "")).replaceAll("\\", "/"),
    }));
    const baseline =
      ctx.gate.workspaceMetaBaselines?.get(pkg) ?? ctx.gate.metaBaseline;

    all.push(...subtractMetaBaseline(relocated, baseline));
  }

  return all;
}

/** The FULL gate evaluation — autofix, then the gate command, then the harness
 *  meta-rules — combined into ONE pass/fail with the union error set. This is the
 *  authoritative "is it green?" answer; `settleGate` (the end-of-turn settle) and
 *  the callable `check` tool (WS-G, mid-turn) BOTH go through here so they can never
 *  disagree — the model can't see `check` say green while the settle path is red
 *  (e.g. a `test-sibling-required` meta-error the gate command alone doesn't emit).
 *  Signal-forwarding and gate streaming come for free via `runGateStep`. */
export async function evaluateGate(
  ctx: ILoopCtx,
  turn: number
): Promise<{
  passed: boolean;
  errors: IErrorItem[];
  output: string;
  metaViolations: IMetaRuleViolation[];
  autoFixed: string[];
  /** Per-file annotated one-liners, same order as `autoFixed`. */
  autoFixSummary: string[];
}> {
  const autoFix = await autoFixStep(ctx);
  const gate = await runGateStep(ctx, turn);
  const metaViolations = await runMetaRulesStep(ctx);

  const metaErrors = metaViolations.filter((v) => v.severity === "error");
  const errors = gate.errors.concat(
    metaErrors.map((v) => ({
      // Key stays `file:ruleId` — the R3 escalation focus contract (gateFeedback
      // filters metaViolations by exactly this) depends on it. Distinct-message
      // collapse is handled by the `check` tool's dedupe (full-identity), NOT by
      // widening this key, so the ladder's focus matching is untouched.
      key: `${v.file}:${v.ruleId}`,
      file: v.file,
      rule: v.ruleId,
      message: v.message,
    }))
  );

  return {
    // Green only when BOTH the gate command AND the meta-rules are clean.
    passed: gate.passed && metaErrors.length === 0,
    errors,
    output: gate.output,
    metaViolations,
    autoFixed: autoFix.files,
    autoFixSummary: autoFix.summary,
  };
}

/** The callable-gate seam the `check` tool (WS-G) runs: the SAME full evaluation
 *  `settleGate` uses, projected to the {@link ICheckOutcome} the tool returns —
 *  including `autoFixed`, so `check` can warn the model that mid-turn autofix
 *  rewrote files (the desync guard `settleGate` gives via its autofix notice).
 *  Wired onto the tool context by the build overlay (Session).
 *  `turn` is the current drive turn (1-based) so the live progress line matches
 *  settle — never hardcode 0 (that made task_complete/`check` look stuck on
 *  "turn 0" for the whole gate run). */
export async function runCheckGate(
  ctx: ILoopCtx,
  turn: number
): Promise<ICheckOutcome> {
  const { passed, errors, output, autoFixed, autoFixSummary } =
    await evaluateGate(ctx, turn);

  return {
    passed,
    errors,
    output,
    autoFixed,
    autoFixSummary,
    command: ctx.task.accept,
    packs: ctx.gate.stackProfile?.packs ?? [],
  };
}

/** Pure helper: derive the handoff ask string from the final steer message and
 *  persisting error set. Produces a non-empty, informative ask for human/stronger-model
 *  handoff. */
export function buildHandoffAsk(
  finalSteer: string,
  persistingErrors: string[]
): string {
  const trimmedSteer = finalSteer.trim();
  const errorSummary =
    persistingErrors.length > 0
      ? `Persisting after all escalations: ${persistingErrors.slice(0, 3).join(", ")}${persistingErrors.length > 3 ? ` (+${persistingErrors.length - 3} more)` : ""}.`
      : "Unable to make progress with local model escalations.";

  if (trimmedSteer.length === 0) {
    return `The model was unable to fix the gate errors. ${errorSummary}`;
  }

  return `${trimmedSteer.replace(/\.$/, "")}. ${errorSummary}`;
}

/** A terminal STUCK result — shared shape for every convergence guard. When the
 *  ladder is exhausted, builds a handoff to a stronger model. The `block` is
 *  captured before guard reset so it includes the current error context. */
function stuckResult(
  ctx: ILoopCtx,
  state: ILoopState,
  gateErrors: IErrorItem[],
  turn: number,
  detail: string,
  messagePrefix: string,
  finalSteer: string,
  block: string
): IRunResult {
  const rungHistory = Array.from(
    state.triedLeversByBlock?.get(block) ?? []
  ).sort();
  const errorKeys = gateErrors.map((e) => e.message);
  const ask = buildHandoffAsk(finalSteer, errorKeys);
  const failureClass = state.lastFailureClass;
  const failureDetail = state.lastFailureDetail;
  const attribution =
    failureClass !== undefined
      ? attributionLeadIn({
          failureClass,
          detail: failureDetail,
        })
      : "";
  const askWithClass = attribution.length > 0 ? `${attribution} ${ask}` : ask;

  const handoff: IHandoff = {
    block,
    rungHistory,
    errors: errorKeys,
    ask: askWithClass,
    resumable: true,
    resume: { triedLevers: rungHistory },
    failureClass,
    failureDetail,
  };

  ctx.report({
    kind: "stuck",
    task: ctx.task.id,
    cycles: turn,
    detail,
    message: `task ${ctx.task.id}: ${messagePrefix}${detail}`,
    handoff,
  });

  return {
    task: ctx.task.id,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: turn,
    reason: STUCK_REASON.handoff,
    detail,
    handoff,
  };
}

/** Before accepting a stalled PARK, try the expert handoff (the rung ABOVE the
 *  steering ladder): hand the single most-blocking failing FILE to the configured
 *  `capabilities.expert` model, apply its fix, and let the primary model continue.
 *  Returns true when a fix was applied (→ keep looping). No expert configured, no
 *  failing file, R4 already tried for this block, or the expert declining all fall
 *  through to false (→ park as before). Never throws — a handoff hiccup must not
 *  crash the run. Expert re-enters only on a NOVEL block fingerprint (novelty gate). */
/** Whether `settleGate` should attempt the expert (R4) for this terminal result.
 *  The ladder-exhaustion terminal carries `STUCK_REASON.handoff` (NOT `.stalled`, which
 *  it used to — a stale check there made the expert UNREACHABLE), and the runaway-backstop
 *  anomaly (`.cap`) must NEVER consult the expert. Pure + exported so the exact trigger
 *  condition is unit-locked (this is the class of seam that silently regressed once). */
export function shouldTryExpertRescue(stuck: IRunResult): boolean {
  return (
    stuck.status === RUN_STATUS.stuck && stuck.reason === STUCK_REASON.handoff
  );
}

export async function tryExpertRescue(
  ctx: ILoopCtx,
  state: ILoopState,
  gateErrors: IErrorItem[],
  resolveAsk: () => Promise<ExpertAsk | null> = resolveExpertAsk
): Promise<boolean> {
  // Every bail is REPORTED — a silent skip here is what hid, for a whole run, WHY
  // the expert never fired (it turned out to be one of these branches). Now the log
  // always says why we parked instead of calling the expert.
  const skip = (why: string): false => {
    ctx.report({
      kind: "tool",
      task: ctx.task.id,
      message: `expert handoff skipped — ${why}; parking`,
    });

    return false;
  };

  // Novelty gate: prefer the STICKY block identity (the same key checkStuck records rungs
  // under) so the R4 gate is consistent with recording; fall back to a momentary
  // derivation only when no sticky identity exists (nothing has been recorded then, so
  // there's no inconsistency). If R4 is already recorded for this block, the expert has
  // already tried and failed on this exact block; escalate to R5 instead.
  let block =
    (state.blockFingerprint ?? "") !== ""
      ? (state.blockFingerprint ?? "")
      : fingerprintFor(state, gateErrors);

  // The expert is the LAST resort before parking. Callers OUTSIDE checkStuck reach here without
  // its `escalation-N` guard — notably the read-only-spin park (session.ts) — so BOTH identity
  // sources can be empty at once (observed live, build12: a near-green rollback reset errorAge so
  // fingerprintFor derives nothing, and blockFingerprint was never set on this path). The old code
  // then SKIPPED the expert and parked, wasting the rung. Derive a per-error-set identity from the
  // failing error KEYS (the dialect fingerprintFor/samePersist use — NOT e.file, which would
  // collapse distinct errors in one file). This local id is used for BOTH the R4 lookup below and
  // the record-on-success — so the SAME error set skips (fires once) while a DIFFERENT set gets a
  // distinct id and its own shot. It is deliberately NOT written to state.blockFingerprint: this
  // fallback only fires on the settleGate-less callers (settleGate always has escalation-N), so
  // persisting would only leave a stale id that makes a later, different stall skip the expert.
  if (block === "") {
    block = gateErrors
      .map((e) => e.key)
      .sort()
      .join("|");
  }

  if (block === "") {
    return skip("no block fingerprint computed");
  }

  state.triedLeversByBlock ??= new Map();

  if (state.triedLeversByBlock.get(block)?.has("R4") === true) {
    return skip("expert already tried for this block; escalating to R5");
  }

  // Resolve the file to repair: prefer a populated `.file`, else parse it from the
  // error MESSAGE (type-aware-lint names the file in text but doesn't set `.file` —
  // which skipped the expert on a whole live run). See resolveStuckFile.
  const targetFile = await resolveStuckFile(
    ctx.cwd,
    gateErrors,
    ctx.task.files,
    ctx.gate.expertRescueTarget
  );

  if (targetFile === null) {
    return skip("no file could be resolved from the failing error(s)");
  }

  const ask = await resolveAsk();

  if (ask === null) {
    return skip(
      "no expert model configured (set capabilities.expert in models.json)"
    );
  }

  const content = await Bun.file(join(ctx.cwd, targetFile))
    .text()
    .catch(() => "");
  // All error messages: file-less errors (type-aware-lint) can't be filtered by
  // file, and the extra context doesn't hurt the expert's single-file fix.
  const errorText = gateErrors.map((e) => e.message).join("\n");

  ctx.report({
    kind: "tool",
    task: ctx.task.id,
    message: `🆘 expert handoff: ${targetFile}`,
  });

  const outcome = await runExpertHandoff(
    ctx.cwd,
    { file: targetFile, content, error: errorText, goal: ctx.task.id },
    ask,
    ctx.task.files
  );

  ctx.report({ kind: "tool", task: ctx.task.id, message: outcome.note });

  if (!outcome.applied) {
    return false;
  }

  // Record the expert's write in the change-set. Every model-driven write goes
  // through recordTouched; the expert write did not, so a file the expert
  // created/repaired (that the model never touched itself) was invisible to the
  // change-scoped meta-rules (runMetaRulesStep reads ctx.tool.touched) — e.g. a
  // logic module the expert introduced would skip logic-files-require-test-sibling.
  recordTouched(ctx, [targetFile]);

  // The expert fixed it — give the primary model a fresh run at the ladder to
  // verify and finish (reset guards + steer level; record R4 as tried for this block).
  state.triedLeversByBlock.set(
    block,
    new Set([...(state.triedLeversByBlock.get(block) ?? []), "R4"])
  );
  state.steerLevel = 0;
  resetConvergenceGuards(state, gateErrors.length);
  // Rebase the plateau backstop too (fresh baseline after the expert's fix). This is
  // ONE of only two places it resets (here + a new all-time low) — deliberately NOT in
  // resetConvergenceGuards, or a steer escalation would reset the oscillation detector.
  state.redGates = 0;
  state.plateauBest = gateErrors.length;
  ctx.messages.push({
    role: "user",
    content: `An expert engineer just repaired \`${targetFile}\` for you. Run the gate to verify, then finish the remaining work.`,
  });

  return true;
}

/** Reset the convergence guards so the model gets fresh cycles after a steer
 *  escalation — else a guard that just tripped would trip again next cycle and
 *  race up the ladder in a few turns. Ages clear, the whole-set counter zeroes,
 *  and the net-progress watermark rebases to the current count (so any real drop
 *  from here counts as progress). */
function resetConvergenceGuards(state: ILoopState, errorCount: number): void {
  state.errorAge = new Map();
  state.gateNoProgress = 0;
  state.noNewLow = 0;
  state.bestErrorCount = errorCount;
}

/** STEP 4 — the three convergence guards, in escalating coarseness: a single
 *  (file,rule) persisting `samePersist` cycles; the WHOLE error set unchanged
 *  `gateStuckRepeats` cycles; and no new error-count low in `noProgressCycles`
 *  cycles. When one trips, the model has STALLED — but instead of killing the run
 *  (the old behaviour, which discarded hours of work on a wall it could climb with
 *  a nudge), we ESCALATE A STEER: a more directive message telling it to stop
 *  flailing and HOW to fix the rule it keeps failing. Only once the steer ladder is
 *  exhausted (`STEER_LADDER_MAX`) does the run park. Returns the terminal (park)
 *  result, or null to keep looping — with `state.pendingSteer` set when a steer
 *  should be injected this cycle. Exported for unit tests. */
/** Set up rung-specific logic for escalation rungs. R1 uses diagnosis-only call,
 *  R2 sets per-call model overrides, R3 narrows to focused error.
 *  R2 and R3 set pendingRung so they are recorded tried when the next gate is unmoved. */
function applyRungLogic(
  state: ILoopState,
  rungLevel: number,
  gateErrors: readonly IErrorItem[],
  reason: string,
  blockFp: string,
  progress?: { readonly current: number; readonly prior: number }
): void {
  const webEnabled = flags.webTools();

  // Escalating past R1 clears any stale diagnosis marker so it can't linger and be
  // re-injected forever (matters on paths without the headless capture, e.g. interactive).
  if (rungLevel !== 1) {
    state.pendingDiagnosisSteer = undefined;
  }

  if (rungLevel === 1) {
    // R1 Phase A (self-diagnose): diagnosis-only, no writes, no tools
    state.pendingDiagnosisSteer = buildSteerMessage(
      rungLevel,
      gateErrors,
      reason,
      webEnabled,
      true, // diagnosisOnly
      progress
    );
    // Phase A does NOT set pendingRung — it's recorded tried only after Phase B

    return;
  }

  if (rungLevel === 2) {
    // R2: set per-call model overrides (temperature + reasoning effort)
    state.pendingModelOverride = {
      temperature: 1.2, // perturb sampling: raise temperature
      reasoningEffort: "high", // reason-more
    };
    // R2 is recorded tried when the next gate is unmoved
    state.pendingRung = "R2";
    state.pendingBlockFingerprint = blockFp !== "" ? blockFp : null;
  }

  if (rungLevel === 3) {
    // R3: narrow to the single most-persistent error
    // R3 is recorded tried when the next gate is unmoved
    state.pendingRung = "R3";
    state.pendingBlockFingerprint = blockFp !== "" ? blockFp : null;
  }

  // R2, R3, and higher levels set pendingSteer (R1 returns early above)
  state.pendingSteer = buildSteerMessage(
    rungLevel,
    gateErrors,
    reason,
    webEnabled,
    false,
    progress
  );
}

/** Determine the stall reason from guard states. Returns null if not stalled. */
export function getStuckReason(
  persisted: IErrorItem | null,
  wholeSetStuck: boolean,
  noNetProgress: boolean,
  plateaued: boolean,
  setCap: number,
  progressCap: number,
  gateErrors: IErrorItem[],
  state: ILoopState
): string | null {
  if (persisted !== null) {
    return persistDetail(persisted);
  }

  if (wholeSetStuck) {
    return `gate unchanged ${String(setCap)} cycles (${String(gateErrors.length)} error(s) not converging)`;
  }

  if (noNetProgress) {
    // Show the true ALL-TIME low (plateauBest), not bestErrorCount — the latter is the
    // fine guard's local watermark that resetConvergenceGuards rebases to the current
    // count on every steer escalation, so it would tell the model "best 17" after an
    // escalation even though it once reached 6. The guard logic still uses the local
    // watermark; only this displayed number is the honest all-time best.
    const bestEver = Math.min(
      state.bestErrorCount,
      state.plateauBest ?? state.bestErrorCount
    );

    return `no net progress: ${String(gateErrors.length)} error(s) open, none cleared in ${String(progressCap)} cycles (best ever ${String(bestEver)})`;
  }

  if (plateaued) {
    return `oscillating: ${String(gateErrors.length)} error(s) open, no NEW low in ${String(state.redGates ?? 0)} gate cycles (best ever ${String(state.plateauBest ?? 0)})`;
  }

  return null;
}

export function checkStuck(
  ctx: ILoopCtx,
  state: ILoopState,
  gateErrors: IErrorItem[],
  turn: number
): IRunResult | null {
  // Advance ALL three trackers every cycle (they mutate state), then decide which,
  // if any, tripped — the coarsest-first order preserves the old diagnosis text.
  const persisted = trackErrorAges(state, gateErrors);

  const previousPhase = commonGatePhase(state.prevGateErrors);
  const currentPhase = commonGatePhase(gateErrors);
  const frontierAdvanced =
    previousPhase !== undefined &&
    currentPhase !== undefined &&
    currentPhase > previousPhase;

  state.gateNoProgress = sameErrorSet(state.prevGateErrors, gateErrors)
    ? state.gateNoProgress + 1
    : 0;
  state.prevGateErrors = gateErrors;

  // Update the net-progress watermark (mutates noNewLow / bestErrorCount).
  trackNetProgress(state, gateErrors.length);

  // PLATEAU tracker: count gate cycles since the last ALL-TIME-low error count. A new
  // low is genuine progress (reset); anything else — an error-set rotation, or a return
  // to a count already seen — is oscillation (climb). `plateauBest` is NEVER rebased on
  // escalation (unlike the fine guards' `bestErrorCount`), so re-reaching a count the
  // model already hit doesn't look like progress — which is exactly how a flailing model
  // evades the fine guards and crawls the ladder over 150+ turns. `redGates` DOES reset
  // on each escalation (below) so escalations stay spaced, but it climbs right back under
  // oscillation because no new all-time low arrives — driving the ladder to the expert in
  // a handful of gates instead of ~150 turns (observed live: v8 still L2 at turn 153).
  // Genuine progress is normally a new all-time-low error count. A composed,
  // short-circuiting gate has one additional proof: reaching a later phase means the
  // earlier phase went green. That downstream phase may legitimately reveal MORE
  // errors, so comparing counts alone would retain an exhausted API block when the UI
  // first becomes reachable (the exact greenfield-revisit failure).
  const madeNewLow =
    gateErrors.length < (state.plateauBest ?? Number.POSITIVE_INFINITY);
  const madeProgress = madeNewLow || frontierAdvanced;

  if (madeProgress) {
    state.plateauBest = gateErrors.length;
    state.redGates = 0;
    state.bestErrorCount = gateErrors.length;
    state.noNewLow = 0;
    // Genuine progress — the oscillation history is stale; clear the window so the
    // plateau fingerprint reflects only the CURRENT stuck streak.
    state.recentGateFingerprints = [];
  } else {
    state.redGates = (state.redGates ?? 0) + 1;
    // No new low — feed the oscillation window so the plateau branch of fingerprintFor
    // (computed just below) has a populated history to derive a stable block identity.
    pushGateFingerprint(state, gateErrors);
  }

  // Momentary derivation of the block identity from the guards. Its DERIVATION matures
  // over a streak (plateau -> gateStuckRepeats -> samePersist), so we do NOT use it
  // directly as the block key — see the sticky identity below.
  const momentaryFp = fingerprintFor(state, gateErrors);

  // STICKY BLOCK IDENTITY: a stuck streak keeps ONE identity for its whole life, even as
  // the guard that derives the fingerprint changes. Only genuine progress (`madeProgress`)
  // moves the block; a derivation change must NOT read as progress or the ladder would
  // reset mid-climb and never reach exhaustion (and rungs would record under a shifting
  // key). This is the single key used for recording, the R4 novelty gate, and the handoff.
  if (madeProgress) {
    // Block moved (or resolved) — reset the ladder so the next stall starts fresh at R1.
    state.blockFingerprint = "";
    state.focusError = null;
    state.steerLevel = 0;
    state.pendingRung = null;
    state.pendingBlockFingerprint = null;
    state.pendingDiagnosisSteer = null;
  } else if ((state.blockFingerprint ?? "") === "" && momentaryFp !== "") {
    // Start of a stuck streak — adopt the first non-empty identity and HOLD it.
    state.blockFingerprint = momentaryFp;
  }

  const block = state.blockFingerprint ?? "";

  // PENDING RUNG RECORDING: if a rung was applied last cycle and the block is UNMOVED
  // (same sticky identity), record it as tried — the lever failed. On progress the
  // pending pair was already cleared above. Either way clear the pending pair.
  if (state.pendingRung !== null && state.pendingRung !== undefined) {
    if (block !== "" && block === state.pendingBlockFingerprint) {
      state.triedLeversByBlock ??= new Map();

      const tried = state.triedLeversByBlock.get(block) ?? new Set();

      tried.add(state.pendingRung);
      state.triedLeversByBlock.set(block, tried);
    }

    state.pendingRung = null;
    state.pendingBlockFingerprint = null;
  }

  // Once steering has begun, the two coarse guards re-trip on a MUCH smaller window
  // (`steerRetrigger`) so the ladder actually climbs L1→L2→L3 within a few gates —
  // otherwise, over sparse forced-gates, the useful rungs (esp. the L2 playbook)
  // never arrive (observed live: only L1 by turn 105). The finer per-error guard
  // keeps its own threshold (it resets fully each escalation).
  const stalling = state.steerLevel > 0;
  const setCap = stalling
    ? LOOP_LIMITS.steerRetrigger
    : LOOP_LIMITS.gateStuckRepeats;
  const progressCap = stalling
    ? LOOP_LIMITS.steerRetrigger
    : LOOP_LIMITS.noProgressCycles;
  const wholeSetStuck = state.gateNoProgress >= setCap;
  const noNetProgress = state.noNewLow >= progressCap;
  // The plateau: no NEW ALL-TIME low for `plateauGates` gate cycles. This is the guard
  // the others miss — it drives escalation under oscillation (rotating error sets + a
  // count that bounces but never actually improves), so the ladder reaches the expert
  // fast instead of crawling. Checked LAST so the finer diagnoses win when they apply.
  const plateaued = (state.redGates ?? 0) >= LOOP_LIMITS.plateauGates;

  const reason = getStuckReason(
    persisted,
    wholeSetStuck,
    noNetProgress,
    plateaued,
    setCap,
    progressCap,
    gateErrors,
    state
  );

  if (reason === null) {
    return null;
  }

  // Stalled. Ensure the sticky identity is set — adopt a stable fallback ONCE if the
  // guards produced no fingerprint yet (held for the streak, so recording + handoff use
  // one consistent key). `blockKey` is what rungs record under and the handoff reports.
  if ((state.blockFingerprint ?? "") === "") {
    state.blockFingerprint = `escalation-${String(state.steerLevel + 1)}`;
  }

  const blockKey = state.blockFingerprint ?? "";

  // R3 narrow: capture the single most-persistent error key for focusError filtering
  // (only when samePersist is the guard that fired).
  if (persisted !== null) {
    state.focusError = persisted.key;
  }

  // Escalate a steer and give the model fresh cycles at the new level. Reset the
  // plateau COUNTER too (spacing — one escalation per plateau window) but NOT plateauBest,
  // so oscillation keeps re-tripping it and the ladder climbs to the expert.
  state.steerLevel += 1;
  state.redGates = 0;
  resetConvergenceGuards(state, gateErrors.length);

  if (state.steerLevel > STEER_LADDER_MAX) {
    // Ladder exhausted — the run parks (an expert-model handoff slots in here).
    const finalSteer =
      state.pendingSteer ??
      buildSteerMessage(state.steerLevel, gateErrors, reason, flags.webTools());

    return stuckResult(
      ctx,
      state,
      gateErrors,
      turn,
      `${reason} — steering exhausted after ${String(STEER_LADDER_MAX)} escalations`,
      "parked — ",
      finalSteer,
      blockKey
    );
  }

  // Set up rung-specific logic: R1 diagnosis-only, R2 model overrides, R3 narrow.
  // Pass the sticky block key so a rung's pendingBlockFingerprint matches what the
  // recording hook will compare against next cycle.
  applyRungLogic(state, state.steerLevel, gateErrors, reason, blockKey, {
    current: gateErrors.length,
    prior: state.priorGateCount ?? state.lastGateCount,
  });

  // At the TOP rung (change-strategy), also RESET the conversation: the flailing
  // history anchors the model to the dead-end approach it's been repeating. Pruning
  // to the essentials + a fresh directive breaks that "context poisoning" so the new
  // strategy isn't fighting the old transcript. injectFeedback does the actual prune.
  if (state.steerLevel >= STEER_LADDER_MAX) {
    state.resetContext = true;
  }

  ctx.report({
    kind: "tool",
    task: ctx.task.id,
    message: `⤴ steer L${String(state.steerLevel)}/${String(STEER_LADDER_MAX)}: ${reason}`,
  });

  // blockFingerprint is the STICKY identity, already set above and held for the whole
  // streak — do NOT overwrite it here with a momentary value.
  return null; // keep looping, with the steer injected this cycle
}

/** Return the single ordered phase represented by an error set. Mixed or
 * unannotated sets are deliberately unknown and keep the conservative count-based
 * convergence behavior. */
function commonGatePhase(errors: readonly IErrorItem[]): number | undefined {
  const first = errors[0]?.phase;

  if (first === undefined) {
    return undefined;
  }

  return errors.every((error) => error.phase === first) ? first : undefined;
}

/** R1 Phase B (feed-forward): after Phase A's diagnosis-only call, check if the
 *  diagnosis is trivial. If trivial (too short or just restates errors), mark R1
 *  tried and escalate to R2 immediately. If not trivial, save it as the next steer
 *  with pendingRung = R1 so the model acts on its own diagnosis (Phase B).
 *  Returns true if escalation occurred (continue with next turn), false if Phase B
 *  proceeds normally. */
export function hasPendingDiagnosis(state: {
  readonly pendingDiagnosisSteer?: string | null;
}): boolean {
  return typeof state.pendingDiagnosisSteer === "string";
}

export function handleR1Diagnosis(
  state: ILoopState,
  diagnosis: string,
  gateErrors: IErrorItem[]
): boolean {
  if (!hasPendingDiagnosis(state)) {
    return false; // Not in R1 Phase A
  }

  // Check if the diagnosis is trivial
  if (isTrivialDiagnosis(diagnosis, gateErrors)) {
    // Trivial diagnosis: mark R1 tried and escalate directly to R2
    const block = state.blockFingerprint ?? "unknown";

    state.triedLeversByBlock ??= new Map();

    const tried = state.triedLeversByBlock.get(block) ?? new Set();

    tried.add("R1");
    state.triedLeversByBlock.set(block, tried);

    // Clear Phase A marker and escalate
    state.pendingDiagnosisSteer = null;
    state.steerLevel += 1;

    // Set up R2 overrides
    if (state.steerLevel === 2) {
      state.pendingModelOverride = {
        temperature: 1.2,
        reasoningEffort: "high",
      };
    }

    state.pendingSteer = buildSteerMessage(
      state.steerLevel,
      gateErrors,
      "diagnosis was trivial — escalating",
      flags.webTools()
    );

    return true; // Skip normal flow, use escalated steer
  }

  // Non-trivial diagnosis: Phase B (act on diagnosis)
  state.pendingDiagnosisSteer = null;
  state.pendingRung = "R1";
  state.pendingBlockFingerprint = state.blockFingerprint ?? null;

  state.pendingSteer =
    `Your own diagnosis last cycle:\n«${diagnosis}»\n\n` +
    `Act on that different approach now. Don't repeat what you tried before.`;

  return false; // Continue normally with Phase B steer set
}

/** At/under this many open errors the loop is NEAR-GREEN: the model must stop
 *  opening new fronts and land the last few. The dominant late-run failure mode is
 *  "spray after best" — reach 1-2 errors, then create files / add routes / refactor
 *  and balloon back to 5-7 (bshands7/9/10 all did this). */
const NEAR_GREEN_LOCKDOWN = 3;

/** A lockdown/regression banner for the top of the feedback, or "" when far from
 *  green and not regressing. `total` = open errors this cycle; `best` = the all-time
 *  low (watermark). Regression = this cycle is WORSE than the best already reached.
 *  (The #77 rotation caller suppresses this banner entirely while rotation is active — the steer
 *  owns the finishing discipline there — so this function need not special-case rotation.) */
export function nearGreenBanner(
  total: number,
  best: number,
  completionOnly = false
): string {
  const regressed = Number.isFinite(best) && total > best;
  const near = total > 0 && total <= NEAR_GREEN_LOCKDOWN;

  if (!near && !regressed) {
    return "";
  }

  // When EVERY remaining error clears only by ADDING code (unused i18n keys / not reachable —
  // see allCompletionClass), the normal near-green lockdown ("smallest change, do NOT create
  // files or add features") is exactly BACKWARDS: it forbids the create/edit/delete UI the
  // feature must have. Emit the opposite instruction so the model builds it (WS-B has already
  // stood its checkpoint down for this state, so the resulting spike won't be reverted).
  if (completionOnly) {
    return (
      `⚠ ${String(total)} error(s) left, and they clear only by ADDING the code the feature is ` +
      "missing — it declared UI it hasn't built (unused i18n keys / not reachable). BUILD the " +
      "create/edit/delete UI, the success/error toasts that reference those keys, and the route " +
      "wiring. The error count WILL rise as you add these files — that's expected progress here, " +
      "NOT a regression to undo. Keep going until the added code references everything.\n\n"
    );
  }

  const lines: string[] = [];

  if (regressed) {
    lines.push(
      `⚠ REGRESSION: you were at ${String(best)} error(s), now ${String(total)}. ` +
        "Your last change re-broke something that was working. UNDO that collateral " +
        `first to get back to ${String(best)}, then fix only what remains.`
    );
  }

  if (near) {
    lines.push(
      `⚠ NEAR-GREEN — only ${String(total)} error(s) from done. Fix ONLY the error(s) ` +
        "listed below, with the SMALLEST possible change. Do NOT create new files, add " +
        "features/routes, refactor, rename, or touch anything not named in an error. " +
        "Land these; don't open new fronts."
    );
  }

  return `${lines.join("\n")}\n\n`;
}

/** STEP 5 — inject the red-gate feedback (rule docs + the auto-fix notice) into
 *  the conversation as the next user message, so the model fixes in-context.
 *  Exported for unit testing (like checkStuck/autoFixStep) — the convention PUSH
 *  delivery is a seam we need to assert actually reaches the model's messages. */
/** #77 near-green ROTATION emit decision, extracted from injectFeedback to keep that function's
 *  branching under the cognitive-complexity ceiling. Returns the two leading text blocks:
 *   • `rotation` — the completion-only steer, emitted only when rotation is ACTIVE and the current
 *     cycle is actually near green (≤ N). Rotation is active when ALL of: the kill-switch flag is on
 *     (read HERE too so it's authoritative at the emit point regardless of tracker ordering); the
 *     detector fired (`state.nearGreenRotation`); and it is NOT the completion phase (that state
 *     legitimately wants the model to ADD the missing UI, which the "do NOT create new files" steer
 *     would contradict). The steer's "one or two errors from done" wording only holds at a near-green
 *     count, so above N (the model executing the steered atomic completion) it is withheld.
 *   • `banner` — the near-green lockdown / regression callout that otherwise leads (the finishing
 *     discipline that stops "spray after best"). SUPPRESSED entirely while rotation is active (near
 *     green OR spike): its "don't create new files" lockdown and its "UNDO that collateral" callout
 *     BOTH contradict the steer's "create the required siblings/tests together, complete atomically"
 *     — stacking them is the spray→revert loop build17 parked on. WS-B has already stood down, so
 *     there is nothing to "undo". When not rotating, the banner flips to "build the missing UI" in
 *     the completion phase instead of "don't create files" (else it fights the completeness guard). */
function rotationEmit(
  state: ILoopState,
  errorCount: number
): { rotation: string; banner: string } {
  const rotationActive =
    flags.nearGreenRotation() &&
    state.nearGreenRotation === true &&
    state.completionPhase !== true;
  const rotating = rotationActive && errorCount <= NEAR_GREEN_N;
  const rotation = rotating ? `${NEAR_GREEN_ROTATION_STEER}\n\n` : "";
  const banner = rotationActive
    ? ""
    : nearGreenBanner(
        errorCount,
        state.bestErrorCount,
        state.completionPhase === true
      );

  return { rotation, banner };
}

export async function injectFeedback(
  ctx: ILoopCtx,
  state: ILoopState,
  gateErrors: IErrorItem[],
  metaViolations: IMetaRuleViolation[],
  autoFixSummary: string[]
): Promise<void> {
  const feedback = await gateFeedback(
    gateErrors,
    ctx.task,
    ctx.cwd,
    metaViolations,
    state.focusError ?? null,
    ctx.gate.stackProfile?.packs ?? []
  );
  const attribution =
    state.lastFailureClass !== undefined
      ? attributionLeadIn({
          failureClass: state.lastFailureClass,
          detail: state.lastFailureDetail,
        })
      : "";
  const attributionBlock = attribution.length > 0 ? `${attribution}\n\n` : "";
  const notice =
    autoFixSummary.length > 0 ? `${autoFixNotice(autoFixSummary)}\n\n` : "";
  // A pending steer (the model stalled) leads the feedback so it can't be missed.
  // R1 Phase A's diagnosis-only instruction takes precedence when set, and is NOT
  // cleared here: the next (no-tools) call reads `pendingDiagnosisSteer` to hide tools
  // and capture the diagnosis, and the capture clears it (headless). Without injecting
  // it the model got a tool-less turn with NO instruction to diagnose. The normal
  // pendingSteer stays one-shot (cleared after injecting).
  const steerText = state.pendingDiagnosisSteer ?? state.pendingSteer;
  const steer = steerText !== undefined ? `${steerText}\n\n` : "";

  state.pendingSteer = undefined;

  // Context reset (top steer rung): prune the poisoned transcript to its essentials
  // IN PLACE (keep the array reference the loop holds), so the fresh directive lands
  // on a clean slate instead of after dozens of dead-end turns.
  if (state.resetContext === true) {
    const before = ctx.messages.length;

    ctx.messages.splice(
      0,
      ctx.messages.length,
      ...essentialMessages(ctx.messages)
    );
    state.resetContext = false;
    // Observable (the reset used to be silent — the same blindness that hid the
    // expert bug): log that the poisoned transcript was pruned.
    ctx.report({
      kind: "tool",
      task: ctx.task.id,
      message: `↺ context reset — pruned ${String(before)} messages to ${String(ctx.messages.length)} (fresh start for the change-strategy rung)`,
    });
  }

  // PUSH the boringstack HOW-TO the first time a gate error maps to a convention —
  // right beside the error, not after the steering ladder escalates. Deduped per
  // run (once per topic), so it teaches without becoming a wall. Gated on the
  // backend's convention library (symmetric with the pull_conventions tool): a
  // plain build never gets boringstack-flavored guidance injected.
  state.pushedGuides ??= new Set<string>();
  const guides =
    state.conventionsEnabled === true && ctx.tool.conventions !== undefined
      ? ctx.tool.conventions.unseenForErrors(gateErrors, state.pushedGuides)
      : [];
  const how =
    guides.length > 0
      ? `\n\nHOW TO WRITE THIS RIGHT (boringstack):\n${guides.join("\n\n")}`
      : "";

  // Observable (was silent — the same blindness that hid the expert bug and made it
  // impossible to tell from a build log whether the model was ever taught a
  // convention). Log which topics were pushed this cycle so adoption is measurable.
  if (guides.length > 0) {
    ctx.report({
      kind: "tool",
      task: ctx.task.id,
      message: `📐 pushed ${String(guides.length)} convention guide(s) beside the gate errors`,
    });
  }

  // #77 + near-green finishing discipline: the completion-only rotation steer that leads when the
  // frontier is rotating, and whether the lockdown/regression banner must be suppressed (both
  // contradict the steer). Extracted into rotationEmit so injectFeedback stays under the
  // cognitive-complexity ceiling — see that helper for the full reasoning.
  const { rotation, banner: baseBanner } = rotationEmit(
    state,
    gateErrors.length
  );
  // Persistent near-green errors: "smallest change" lockdown rewards patch-until-green.
  // Prefer rewrite/invert; suppress the lockdown banner when this fires (same idea as rotation).
  const antiPatch = antiPatchNearGreenLead(state.errorAge, gateErrors);
  const banner = antiPatch.length > 0 ? antiPatch : baseBanner;

  const injected = `${rotation}${banner}${steer}${notice}${attributionBlock}${feedback}${how}`;

  // Ledger the FULL injected text (`model_inject`): the `--log` stream recorded
  // gate verdicts but never what the model was TOLD, so a run log couldn't
  // verify the feedback the model acted on. Renders to nothing on screen.
  ctx.report({ kind: "inject", task: ctx.task.id, message: injected });

  // One live gate-feedback user slot (replace prior settle walls — do not append forever).
  upsertGateFeedback(ctx.messages, injected);
}

/** Settle a turn against the gate: auto-fix → gate → meta-rules → (green? done :
 *  stuck-check → feedback). A thin orchestrator over the exported steps above —
 *  the signature and `IRunResult | null` contract (null ⇒ keep looping) are the
 *  same as ever, so both drivers (run.ts / session.ts) are untouched. */
/** Out-of-scope files WS-B also snapshots/reverts: the harness lets the model mutate these
 *  (add_dependency writes package.json + the lockfile) even though they're outside the
 *  editable `task.files`, so a dependency-induced spray must be reverted with them too. */
const ROLLBACK_EXTRA_FILES: readonly string[] = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/** WS-B: snapshot the scope files at a fresh near-green low so a later spray can revert to
 *  this best state. The editable source scope goes through the SHARED IFileSnapshot substrate
 *  (text-backed, tombstone-aware). The out-of-scope dependency files the harness lets the model
 *  mutate (package.json + lockfiles via add_dependency) are captured SEPARATELY as raw bytes
 *  (depFiles) — a fixed tiny set the shared substrate can't faithfully restore (binary
 *  lockfiles), kept self-contained here so the shared substrate needs no raw-backing/memory
 *  caps. Stores the open errors + the change-scoping set for the revert steer and realignment. */
export async function captureNearGreenCheckpoint(
  ctx: ILoopCtx,
  errorCount: number,
  gateErrors: readonly IErrorItem[]
): Promise<INearGreenCheckpoint> {
  const snapshot = await snapshotFilesForRollback(ctx.cwd, ctx.task.files);

  // Raw-capture the out-of-scope dependency files (bounded, small set) so a dependency-induced
  // spray can be reverted byte-for-byte — else those mutations survive and the gate stays red.
  const depFiles = new Map<string, Uint8Array>();

  for (const rel of ROLLBACK_EXTRA_FILES) {
    const handle = Bun.file(join(ctx.cwd, rel));

    if (await handle.exists()) {
      depFiles.set(rel, new Uint8Array(await handle.arrayBuffer()));
    }
  }

  ctx.report({
    kind: "tool",
    task: ctx.task.id,
    message: `⚑ near-green checkpoint: locked the ${String(errorCount)}-error best state`,
  });

  return {
    errorCount,
    errors: [...gateErrors],
    snapshot,
    // Copy the change-scoping set so rollback restores it (see INearGreenCheckpoint.touched).
    touched: new Set(ctx.tool.touched ?? []),
    depFiles,
  };
}

/** WS-B: a spray past the near-green checkpoint — restore the best on-disk state (rewriting
 *  edited files AND tombstoning any the spray created), reset the CONVERGENCE guards so the
 *  next cycle measures from the restored best (not the spray's inflated ages/plateau
 *  counters, which would otherwise escalate the ladder right after a revert), and steer a
 *  SMALL targeted fix. The caller returns WITHOUT running checkStuck, so a revert never
 *  advances the steer ladder or resets the block fingerprint. */
export async function rollbackNearGreen(
  ctx: ILoopCtx,
  state: ILoopState,
  sprayCount: number,
  sprayErrors: readonly IErrorItem[] = []
): Promise<void> {
  const cp = state.nearGreenCheckpoint;

  if (cp === undefined) {
    return;
  }

  await restoreFiles(cp.snapshot);

  // Byte-restore the out-of-scope dependency files (package.json + lockfiles) the shared
  // text/tombstone snapshot doesn't cover, so a dependency-induced spray is fully reverted.
  for (const [rel, bytes] of cp.depFiles) {
    await Bun.write(join(ctx.cwd, rel), bytes);
  }

  // Tombstone dependency files the spray CREATED — add_dependency can create a lockfile where
  // none existed at the near-green low (so it isn't in depFiles). They're out of task scope, so
  // the shared tombstone scan can't see them; delete them here or a spray-created lockfile stays
  // on disk and the restored gate diverges (a dependency-spray hole).
  for (const rel of ROLLBACK_EXTRA_FILES) {
    if (
      !cp.depFiles.has(rel) &&
      (await Bun.file(join(ctx.cwd, rel)).exists())
    ) {
      await rm(join(ctx.cwd, rel), { force: true });
    }
  }

  // Restore the change-scoping set to the checkpoint's, so change-scoped meta-rules see the
  // same touched files as at the checkpoint (a spray-touched file whose contents were just
  // reverted must not stay "touched"). ctx.tool.touched is a live Set — clear + refill it.
  if (ctx.tool.touched !== undefined) {
    ctx.tool.touched.clear();

    for (const f of cp.touched) {
      ctx.tool.touched.add(f);
    }
  }

  // Realign ALL convergence guards to the RESTORED near-green state: prev errors + count,
  // and — via resetConvergenceGuards — errorAge / gateNoProgress / noNewLow / bestErrorCount
  // (the spray's aged keys and climbed counters are stale now). redGates too, or the plateau
  // guard would fire on the first post-revert cycle. Deliberately NOT touched: steerLevel,
  // blockFingerprint, plateauBest (a revert is not a NEW block and not ladder progress).
  state.prevGateErrors = [...cp.errors];
  state.lastGateCount = cp.errorCount;
  resetConvergenceGuards(state, cp.errorCount);
  state.redGates = 0;
  // settleGate counted this spray as a regression on entry; it's being reverted, so it's
  // not a real regression of the metric — undo that increment.
  state.regressions = Math.max(0, state.regressions - 1);
  // Purge the stale SPRAY fingerprints so the next checkStuck can't derive a wrong block
  // identity from spray-cycle keys. The escalation-ladder bookkeeping (steerLevel,
  // blockFingerprint, pendingRung, pendingBlockFingerprint) is left UNTOUCHED: the rung was
  // applied on a PRIOR cycle and legitimately advanced steerLevel; clearing pendingRung while
  // keeping steerLevel desynced the two (rung never recorded tried, yet the ladder advanced),
  // burning levers and exhausting the ladder early. A revert reverses files, not ladder state.
  state.recentGateFingerprints = [];
  state.focusError = null;
  // A stale steer from the spray cycle would otherwise be injected on the next non-rollback
  // cycle (injectFeedback reads pendingDiagnosisSteer ?? pendingSteer), fighting — or even
  // re-triggering — the approach that caused the spray, against the rollback's "make a SMALL
  // targeted fix" message. The rollback path skips injectFeedback, so clear BOTH here.
  state.pendingDiagnosisSteer = null;
  state.pendingSteer = undefined;
  state.nearGreenRollbacks = (state.nearGreenRollbacks ?? 0) + 1;

  ctx.report({
    kind: "tool",
    task: ctx.task.id,
    message: `↩ near-green rollback ${String(state.nearGreenRollbacks)}/${String(MAX_NEAR_GREEN_ROLLBACKS)}: reverted a ${String(sprayCount)}-error spray to the ${String(cp.errorCount)}-error best; steering a targeted fix`,
  });

  const errorList = cp.errors
    .slice(0, 20)
    .map((e) => `  - ${e.message}`)
    .join("\n");

  // Show the model the NEW errors its reverted change INTRODUCED (the spray delta), not just the
  // errors it was already at — otherwise it's a blind random walk: it can't learn which pattern to
  // avoid because the evidence was just reverted off disk. Keyed diff against the checkpoint so
  // only genuinely-new errors show. (4-model panel: hiding the spray was a core reason it circled.)
  const cpKeys = new Set(cp.errors.map((e) => e.key));
  const introduced = sprayErrors.filter((e) => !cpKeys.has(e.key));
  const introducedNote =
    introduced.length > 0
      ? `\n\nThose reverted edits INTRODUCED these new error(s) — do NOT re-introduce them:\n${introduced
          .slice(0, 20)
          .map((e) => `  - ${e.message}`)
          .join("\n")}`
      : "";

  const formPurityNote = formPurityRollbackAppendix(cp.errors, introduced);

  ctx.messages.push({
    role: "user",
    content:
      `Your last change made things WORSE — the gate went from ${String(cp.errorCount)} ` +
      `to ${String(sprayCount)} error(s) — so I reverted those edits back to your best ` +
      `state (${String(cp.errorCount)} error(s) left). Do NOT rewrite files or start over. ` +
      `Make a SMALL, targeted fix for ONLY these remaining errors, one at a time:\n${errorList}` +
      introducedNote +
      formPurityNote,
  });

  notifyGateRailChanged(ctx, state);
}

/** WS-B: the red-gate rollback step. If the current result is a count SPRAY past a near-green
 *  checkpoint (no phase heuristic — see shouldRollback), revert to the best on-disk state.
 *  Returns true when it rolled back (caller returns null to keep looping — a revert is not a
 *  checkStuck attempt). Flag-gated: a no-op when the flag is off, so no path changes. */
async function nearGreenRollbackStep(
  ctx: ILoopCtx,
  state: ILoopState,
  curr: number,
  gateErrors: readonly IErrorItem[]
): Promise<boolean> {
  if (!flags.nearGreenCheckpoint()) {
    return false;
  }

  // During the COMPLETION phase the model is ADDING the demanded UI, so the error spike is
  // progress, not a spray — never roll it back (this runs before checkpointStep, so the flag,
  // not a per-cycle all-completion check, is what protects the mixed-error spike).
  if (state.completionPhase === true) {
    return false;
  }

  // #77: while the near-green error set is ROTATING, injectFeedback is steering the model to
  // COMPLETE a file atomically — create its required companion/sibling files + colocated test in
  // ONE change. That coordinated edit transiently spikes the count past the checkpoint, exactly
  // like a completion-phase add. Rolling it back would undo the completion the steer just asked
  // for — the very spray→revert loop build17 parked on, with the steer and WS-B fighting. So WS-B
  // stands its rollback down here too. It is not defenceless: if the spike does NOT resolve back
  // to near green within MAX_NEAR_GREEN_SPIKE_GAP cycles, trackNearGreenRotation clears the
  // rotation flag (the streak is stale), WS-B re-arms, and the held near-green checkpoint reverts
  // the persistent spray on the next cycle. Re-check the kill-switch HERE too (not only in the
  // tracker) so disabling it is authoritative at this decision point regardless of call ordering —
  // symmetric with injectFeedback's emit-path check.
  if (flags.nearGreenRotation() && state.nearGreenRotation === true) {
    return false;
  }

  if (
    shouldRollback(
      state.nearGreenCheckpoint,
      curr,
      state.nearGreenRollbacks ?? 0
    )
  ) {
    await rollbackNearGreen(ctx, state, curr, gateErrors);

    return true;
  }

  return false;
}

/** WS-B: after end-of-cycle feedback, re-arm the near-green checkpoint. Captures a fresh
 *  snapshot when the state is near green (1..N) AND it's worth protecting — either no checkpoint
 *  is held (`needsReArm`: re-establishes after a resume, since the snapshot isn't serialized) OR
 *  the count STRICTLY improves (`isBetter`) on WS-B's `nearGreenBest` watermark. A same-count
 *  settle deliberately does NOT refresh: the checkpoint protects the best-by-count state, and a
 *  spray then reverts to it — at worst the model redoes a small same-count delta, which is far
 *  simpler and more robust than trying to signal "did the model do real work at the same count"
 *  (every such signal — error keys, edit counters — misses cases like add_dependency). The
 *  watermark is WS-B's own, NOT checkStuck's plateauBest (which uses commonGatePhase and stalls
 *  with meta errors). Flag-gated no-op. */
async function nearGreenCheckpointStep(
  ctx: ILoopCtx,
  state: ILoopState,
  curr: number,
  gateErrors: readonly IErrorItem[]
): Promise<void> {
  if (!flags.nearGreenCheckpoint()) {
    return;
  }

  // The revert budget is a per-DRIVE TOTAL (reset in driveInner), NOT reset on capture.
  // Once spent, WS-B is done for this drive — stop capturing too, or it would re-arm into a
  // fresh checkpoint and a model that sprays→reverts→re-settles could thrash to maxTurns.
  // The escalation ladder now owns the stall.
  if ((state.nearGreenRollbacks ?? 0) >= MAX_NEAR_GREEN_ROLLBACKS) {
    return;
  }

  // Never protect a HOLLOW state while in the COMPLETION phase — the model is adding the
  // demanded create/edit/delete UI (wiring i18n keys / reachability), so a checkpoint here
  // would revert it to the list-only page (observed: 1→27 spray reverted, model re-does it →
  // thrash). CLEAR any checkpoint (drops an earlier compile-state one too — its fixable errors
  // are already resolved, so it's stale) and don't capture; WS-B re-engages when the phase ends
  // (no completion error remains). completionPhase was advanced at the top of settleGate.
  if (state.completionPhase === true) {
    state.nearGreenCheckpoint = undefined;

    return;
  }

  const needsReArm = state.nearGreenCheckpoint === undefined;
  // A strictly-lower near-green count → refresh (a new best worth protecting).
  const isBetter = curr < (state.nearGreenBest ?? Number.POSITIVE_INFINITY);

  if (shouldCheckpoint(curr, needsReArm || isBetter)) {
    state.nearGreenCheckpoint = await captureNearGreenCheckpoint(
      ctx,
      curr,
      gateErrors
    );
    // The new best this checkpoint protects. Deliberately do NOT reset nearGreenRollbacks —
    // it bounds TOTAL reverts this drive.
    state.nearGreenBest = curr;
  }
}

/** #77 completion-only steer text — GENERIC (no stack knowledge). Injected while the near-green
 *  error set is ROTATING: the model is ~1 error from done but each fix spawns another at the same
 *  low count (e.g. it extracts a component, so that component's required siblings/tests are now
 *  missing). The fix is to stop opening new surface and COMPLETE existing files atomically. */
export const NEAR_GREEN_ROTATION_STEER =
  "You are only one or two errors from done, but the errors keep ROTATING — each fix spawns a " +
  "different error at the same low count, so the build never reaches zero. This happens when a fix " +
  "OPENS NEW SURFACE that carries its own requirements. Two rules until the count reaches zero:\n" +
  "1. Do NOT open new surface: do not extract components, split existing code into new modules/" +
  "units, or add new features/routes/schemas that no current error requires. That is what keeps " +
  "spawning the next error.\n" +
  "2. But DO finish what the current errors demand, ATOMICALLY: when you fix a file that has an " +
  "error, create ALL the companion/sibling files and the colocated test that satisfying it " +
  "requires in the SAME change — even though those files are not themselves in the error list yet " +
  "— so the fix can't leave a fresh gap that becomes the next error.\n" +
  "Resolve exactly the listed errors and the siblings/tests they require — nothing else.";

/** #77: a cheap, INDEPENDENT worktree revision of the scope files — a content hash over the
 *  glob-resolved scope-file set (each path + its text, plus the existed-set so a created/deleted
 *  file moves the rev even when surviving files are byte-identical). trackNearGreenRotation stamps
 *  it on each near-green sample so isNearGreenRotation can require a GENUINE per-cycle EDIT (the rev
 *  must move) before it treats a rotating error signature as real: a flaky/stateful gate re-run over
 *  UNCHANGED files leaves the rev fixed and therefore cannot fake a fix-one→spawn-another rotation
 *  (and cannot wrongly stand the WS-B rollback net down). Reuses the SAME snapshot substrate WS-B
 *  rolls back with, so "what counts as the scope" can never drift between detection and revert. */
async function scopeRevision(
  cwd: string,
  files: readonly string[]
): Promise<string> {
  const snap = await snapshotFilesForRollback(cwd, files);
  const parts: string[] = [];

  for (const path of [...snap.existed].sort()) {
    parts.push(`${path}\0${snap.contents.get(path) ?? ""}`);
  }

  return String(Bun.hash(parts.join("")));
}

/** #77: update the near-green ROTATION signal for this cycle. Records this cycle's {count, error-set
 *  signature} on the drive's near-green window ONLY when `curr` is near green (1..N) — spikes above
 *  N are IGNORED (not pushed, not cleared) so a transient regression between two near-green visits
 *  doesn't reset the window (build17's real pattern is 1↔3↔6: only the 1s are near green, and they
 *  rotate). COMPLETION-PHASE cycles are also skipped: a hollow state legitimately churns its error
 *  identity while the model ADDS the missing UI, and recording that churn would pre-fill the window
 *  and mis-fire the "don't create new files" steer the moment completion ends. Green clears it. Sets
 *  `state.nearGreenRotation` from the window (needs the count → plateau AND the signature → changing
 *  identity; see isNearGreenRotation). When the flag is OFF this CLEARS the sticky state (so a
 *  mid-run kill-switch flip is authoritative — the steer stops), not just early-returns. GENERIC:
 *  keyed only on the stack-agnostic rule/file via errorSetSignature. Exported for tests. */
export function trackNearGreenRotation(
  state: ILoopState,
  curr: number,
  gateErrors: readonly IErrorItem[],
  rev: string
): void {
  // Flag off OR a green cycle OR the completion phase: clear the window + flag. Clearing (not just
  // returning) makes the kill-switch authoritative mid-run and prevents completion-phase churn from
  // filling the window and firing on the first post-completion near-green cycle.
  if (
    !flags.nearGreenRotation() ||
    curr === 0 ||
    state.completionPhase === true
  ) {
    state.nearGreenSamples = [];
    state.nearGreenRotation = false;
    state.nearGreenSpikeGap = 0;

    return;
  }

  // Spikes above the near-green ceiling are transient — tolerate a FEW between near-green visits so
  // the rotating near-green states on either side of a spray→revert still accumulate. But a LONG
  // run of them means the earlier near-green streak is stale (a later near-green state is a fresh
  // episode, not the same rotation), so past the gap bound clear the window rather than let far-
  // apart samples combine into a false rotation.
  if (curr > NEAR_GREEN_N) {
    const gap = (state.nearGreenSpikeGap ?? 0) + 1;

    state.nearGreenSpikeGap = gap;

    if (gap > MAX_NEAR_GREEN_SPIKE_GAP) {
      state.nearGreenSamples = [];
      state.nearGreenRotation = false;
    }

    return;
  }

  // A near-green sample resets the spike gap (the streak is contiguous again).
  state.nearGreenSpikeGap = 0;

  const samples = state.nearGreenSamples ?? [];
  // The gate FRONTIER phase this cycle sits at (a short-circuiting composed gate emits only the
  // current phase's errors). A phase move across the window is frontier PROGRESS, not rotation —
  // isNearGreenRotation requires a constant phase. 0 when the gate tags no phase (→ no-op).
  const phase = Math.max(0, ...gateErrors.map((err) => err.phase ?? 0));

  samples.push({ count: curr, phase, sig: errorSetSignature(gateErrors), rev });

  // Bound the window — only the last few matter to isNearGreenRotation.
  const MAX_SAMPLES = 8;

  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }

  state.nearGreenSamples = samples;
  state.nearGreenRotation = isNearGreenRotation(samples);
}

export async function settleGate(
  ctx: ILoopCtx,
  state: ILoopState,
  turn: number
): Promise<IRunResult | null> {
  const { task, report } = ctx;
  // The FULL evaluation (autofix → gate command → meta-rules), shared verbatim with
  // the `check` tool via evaluateGate so the two never disagree.
  const {
    passed: gatePassed,
    errors: gateErrors,
    metaViolations,
    autoFixSummary,
  } = await evaluateGate(ctx, turn);

  const curr = gateErrors.length;

  // WS-B: advance the completion-phase flag BEFORE the rollback/banner/checkpoint steps read
  // it — so the phase set at the hollow state survives the mixed-error spike that follows
  // (the rollback step runs first, and a per-cycle all-completion check would already be false
  // there once the model started adding code).
  state.completionPhase = nextCompletionPhase(
    state.completionPhase ?? false,
    gateErrors
  );

  // WS-B rotation (#77): update the near-green rotation signal BEFORE injectFeedback reads it,
  // and before the green branch (curr===0 clears it). Ignores spikes above N, so the rotating
  // near-green states accumulate across the transient regressions between them. The worktree
  // rev is only consumed on the near-green record branch (1..N), so compute it there only — a
  // deep-red or green cycle skips the scope read entirely.
  const rev =
    curr >= 1 && curr <= NEAR_GREEN_N
      ? await scopeRevision(ctx.cwd, ctx.task.files)
      : "";

  trackNearGreenRotation(state, curr, gateErrors, rev);

  if (state.lastGateCount >= 0 && curr > state.lastGateCount) {
    state.regressions += 1;
  }

  state.priorGateCount = state.lastGateCount;
  state.lastGateCount = curr;

  // Harness-owned attribution from the CURRENT gate (events optional — mid-run
  // settle usually has only the ErrorSet; behavioral classes still work when the
  // caller later passes a fuller event stream via classifyFromGate directly).
  const failure = classifyFromGate(gateErrors);

  state.lastFailureClass = failure.failureClass;
  state.lastFailureDetail = failure.detail;

  // On red, surface the ACTUAL errors (codes + messages) into the event — so the
  // log records WHAT failed at the gate, not just a count (the analysis substrate
  // for finding systematic mistakes to fix in the harness).
  const gateDetail = gatePassed
    ? ""
    : `:\n${gateErrors
        .slice(0, 20)
        .map((e) => `  ${e.message}`)
        .join("\n")}`;

  report({
    kind: "validated",
    task: task.id,
    cycle: turn,
    passed: gatePassed,
    errors: gateErrors.length,
    // Structured rule/code list (not just a count) so the failure classifier can
    // tell a type error from a lint rule without re-parsing the gate output.
    rules: gateErrors.flatMap((e) => (e.rule === undefined ? [] : [e.rule])),
    failureClass: failure.failureClass,
    failureDetail: failure.detail,
    message: gatePassed
      ? `task ${task.id} · turn ${turn}: GREEN`
      : `task ${task.id} · turn ${turn}: red (${String(gateErrors.length)} error(s))${gateDetail}`,
  });

  if (gatePassed) {
    // Gate passed — clear block tracking AND the last red ErrorSet. Leaving
    // prevGateErrors populated made Phase-B continues (checklist still open)
    // cite ghost "outstanding gate error(s)" on readonly-spin / handoff after
    // GREEN (DeepSeek dogfood: model correctly called the message stale).
    state.blockFingerprint = "";
    state.focusError = null;
    state.prevGateErrors = [];
    state.errorAge = new Map();
    state.lastFailureClass = undefined;
    state.lastFailureDetail = undefined;
    // WS-B: the build is green — there's no near-green state left to protect.
    state.nearGreenCheckpoint = undefined;
    state.nearGreenBest = undefined;
    state.nearGreenRollbacks = 0;

    await polishOnGreen(ctx);

    notifyGateRailChanged(ctx, state);

    // Do NOT emit kind:"done" here — Session Phase B may continue with an open
    // checklist (`⊙ gate green — checklist still open; continuing`). Callers that
    // truly finish announce via {@link announceTaskDone}.
    return {
      task: task.id,
      redConfirmed: true,
      status: RUN_STATUS.done,
      cycles: turn,
    };
  }

  // WS-B: revert a count spray to the best on-disk near-green state (returning BEFORE
  // checkStuck — a revert must not advance the ladder).
  if (await nearGreenRollbackStep(ctx, state, curr, gateErrors)) {
    return null;
  }

  const stuck = checkStuck(ctx, state, gateErrors, turn);

  if (stuck !== null) {
    notifyGateRailChanged(ctx, state);

    // Ladder exhaustion is the rung where the EXPERT (R4) gets a shot before R5: if a
    // stronger model repairs the blocking file, keep looping instead of handing off.
    // The novelty gate inside tryExpertRescue prevents re-firing on the same block.
    if (
      shouldTryExpertRescue(stuck) &&
      (await tryExpertRescue(ctx, state, gateErrors))
    ) {
      return null;
    }

    return stuck;
  }

  await injectFeedback(ctx, state, gateErrors, metaViolations, autoFixSummary);

  await nearGreenCheckpointStep(ctx, state, curr, gateErrors);

  notifyGateRailChanged(ctx, state);

  return null;
}

/** Emit the terminal `done` ledger event — only after the caller knows the
 *  drive will not Phase-B continue (open checklist). */
export function announceTaskDone(
  report: Reporter,
  taskId: string,
  turns: number
): void {
  report({
    kind: "done",
    task: taskId,
    cycles: turns,
    message: `task ${taskId}: done in ${String(turns)} turn(s)`,
  });
}

/** Handle a non-gate exit (timeout, degeneration, readonly-spin, malformed-tool-call)
 *  with a small recovery budget per synthetic block. Once budget spent → R5 handoff.
 *  Synthetic fingerprints are SEPARATE namespace from real gate fingerprints.
 *  Returns a terminal result or null to continue. */
export function settleSyntheticBlock(
  ctx: ILoopCtx,
  state: ILoopState,
  syntheticFingerprint: string,
  exitKind: string,
  turn = 1
): IRunResult | null {
  const { task, report } = ctx;

  // Synthetic blocks have a small fixed recovery budget (not full escalation ladder)
  const budgetPerExitKind: Record<string, number> = {
    "readonly-spin": 1, // one nudge to act
    timeout: 1, // one retry
    degeneration: 0, // no retry, go straight to R5
    "malformed-tool-call": 0,
  };

  const recoveryBudget = budgetPerExitKind[exitKind] ?? 0;

  // Initialize the synthetic block's tried-lever tracking (separate namespace)
  state.triedLeversByBlock ??= new Map();
  const tried = state.triedLeversByBlock.get(syntheticFingerprint) ?? new Set();

  // Count how many times this synthetic block has been visited (recovery attempts)
  const recoveryAttempts = tried.size;

  // If we've exhausted the budget, hand off
  if (recoveryAttempts >= recoveryBudget) {
    const message = `synthetic block "${exitKind}" exhausted recovery budget`;

    report({
      kind: "stuck",
      task: task.id,
      message,
    });

    // Synthetic blocks don't use real escalation rungs, so handoff reports empty rungHistory
    const rungHistory: EscalationRung[] = [];

    const handoff: IHandoff = {
      block: syntheticFingerprint,
      rungHistory,
      errors: [exitKind],
      ask: `${exitKind}: recovery attempts exhausted; needs manual intervention or a different approach`,
      resumable: true,
      resume: { triedLevers: rungHistory },
    };

    return {
      task: task.id,
      redConfirmed: false,
      status: RUN_STATUS.stuck,
      reason: STUCK_REASON.handoff,
      handoff,
      detail: message,
      cycles: turn,
    };
  }

  // Record this recovery attempt using sentinel rungs (synthetic blocks use markers, not the full R1-R4 ladder)
  tried.add("R1");
  state.triedLeversByBlock.set(syntheticFingerprint, tried);

  // Continue — the caller will apply a small nudge/retry before looping again
  return null;
}

/** Report how long a turn took (and cumulative). */
export function emitTiming(
  report: Reporter,
  task: string,
  turn: number,
  turnStart: number,
  taskStart: number
): void {
  const turnMs = Math.round(performance.now() - turnStart);
  const totalMs = Math.round(performance.now() - taskStart);

  report({
    kind: "timing",
    task,
    cycle: turn,
    ms: turnMs,
    message: `turn ${turn} took ${secs(turnMs)} (total ${secs(totalMs)})`,
  });
}

/** Human-readable duration: ms under a second, else seconds with one decimal. */
function secs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
