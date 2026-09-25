import type { ITask } from "../spec";
import type {
  IChatMessage,
  IModelResponse,
  IProvider,
  ITokenUsage,
  IToolCall,
} from "../inference";
import { assistantMessage } from "./assistant-message";
import { usageEvent } from "./model-call";
import {
  autoCompactPct,
  compactConversation,
  compactSummaryLine,
} from "./context-hygiene";
import {
  validate,
  type ErrorParser,
  type IValidateResult,
  type IErrorItem,
} from "../validate";
import { commandGate } from "../gate/gate-runner";
import { readFiles, type IFileView } from "../lib/fs";
import { trace } from "../lib/trace";
import {
  DEFAULT_TEMPERATURE,
  RUN_STATUS,
  STUCK_REASON,
  LOOP_LIMITS,
  READONLY_STREAK_LIMIT,
  MAX_READONLY_RECOVERIES,
} from "./loop.constants";
import {
  nextReadonlyStreak,
  streakAfterReadonlyResteer,
  toolCallsAttemptWrite,
  WRITE_FORCE_TOOL_NAMES,
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
import type {
  IRunResult,
  IRunOptions,
  Reporter,
  ILoopEvent,
  IHandoff,
} from "./loop.types";
import { mineLessons, consolidate as consolidateMemory } from "./memory";
import type { ITsforgeProjectConfig } from "../config";
import type { ProfileId } from "../config/profiles";
import type { IConventions } from "../infer-rules/conventions.types";
import type { PolicyMode, IPolicyRules } from "../policy";
import { buildSystemPrompt, seedPrompt } from "./prompt";
import { buildScoutContext } from "./scout";
import { detectStack } from "../stack-detection";
import type { TtsrManager } from "./ttsr";
import {
  initTtsrManager,
  loadProjectTtsrRules,
  applyTtsrInterrupt,
} from "./ttsr-init";
import { resolveImageCapabilityFlags } from "./tools/image-tools";
import { resolveGithubCapability } from "./tools/github-ops";
import { resolveLinearCapability } from "./tools/linear-ops";
import { resolveNotionCapability } from "./tools/notion-ops";
import { resolveSentryCapability } from "./tools/sentry-ops";
import { connectMcpServers, mergeMcpServers } from "../mcp";
import { openBrowserSession } from "../chrome-bridge";
import { BROWSER_RESEARCH_GUIDANCE } from "../agent/agent.constants";
import type { IMcpServerConfig } from "../mcp";
import { loadGlobalMcpServers } from "../models-config";
import { formatReport } from "./review/review-change";
import { review } from "./review/review-agents";
import { flags } from "../config";
import {
  type ILoopCtx,
  type ILoopState,
  toolsFor,
  buildTsService,
  runToolCalls,
  settleGate,
  announceTaskDone,
  emitTiming,
  handleR1Diagnosis,
  hasPendingDiagnosis,
  NO_TOOL_CALL_NUDGE,
} from "./turn";

/** Report any salvaged malformed tool calls, then stop the task if the stream
 *  degenerated into a repetition loop (returns a terminal stuck result; null to
 *  keep going) — mirrors the interactive Session's degeneration handling. */
function handleDegeneration(
  res: IModelResponse,
  ctx: ILoopCtx,
  state: ILoopState,
  at: { turn: number; turnStart: number; taskStart: number }
): IRunResult | null {
  const { report } = ctx;
  const { id } = ctx.task;

  if (res.salvaged !== undefined && res.salvaged > 0) {
    report({
      kind: "tool",
      task: id,
      message: `recovered ${res.salvaged} malformed tool call(s) (server tool-call parser mismatch)`,
    });
  }

  if (res.degenerated !== true) {
    return null;
  }

  const errorMessages = state.prevGateErrors.map((e) => e.message);
  const handoff: IHandoff = {
    block: "degeneration",
    rungHistory: [],
    errors: errorMessages.slice(0, 3),
    ask: "model fell into a repetition loop and needs a different approach",
    resumable: true,
    resume: { triedLevers: [] },
  };

  report({
    kind: "stuck",
    task: id,
    cycles: at.turn,
    message:
      "model fell into a repetition loop - stopped. Try a smaller task or steer it with a narrower instruction.",
  });
  emitTiming(report, id, at.turn, at.turnStart, at.taskStart);

  return {
    task: id,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: at.turn,
    reason: STUCK_REASON.handoff,
    detail: "degeneration",
    handoff,
    edits: state.edits,
    regressions: state.regressions,
  };
}

/** Degeneration (terminal stuck) or token-cap truncation (re-steer +
 *  continue) — the aborted-stream shapes handled before tool execution.
 *  Truncated calls were DROPPED at assembly (never executed with silently-
 *  empty args); the resteer mirrors the Session's TRUNCATION_RESTEER. */
function abortedTurnAction(args: {
  res: IModelResponse;
  ctx: ILoopCtx;
  state: ILoopState;
  messages: IChatMessage[];
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
  turn: number;
  turnStart: number;
  taskStart: number;
  report: Reporter;
  taskId: string;
}): {
  action: "continue" | IRunResult;
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
  forceWriteNext: boolean;
} | null {
  const looped = handleDegeneration(args.res, args.ctx, args.state, {
    turn: args.turn,
    turnStart: args.turnStart,
    taskStart: args.taskStart,
  });

  if (looped !== null) {
    return {
      action: looped,
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
      historyMetaStreak: args.historyMetaStreak,
      forceWriteNext: false,
    };
  }

  return args.res.truncated === true ? truncationContinue(args) : null;
}

/** Report + re-steer a token-cap truncation, then continue the loop. */
function truncationContinue(args: {
  report: Reporter;
  taskId: string;
  messages: IChatMessage[];
  turn: number;
  turnStart: number;
  taskStart: number;
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
}): {
  action: "continue";
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
  forceWriteNext: boolean;
} {
  args.report({
    kind: "tool",
    task: args.taskId,
    message:
      "⚠ response hit the token cap mid-tool-call — dropped the partial call, re-steering to a smaller one",
  });
  args.messages.push({
    role: "user",
    content:
      "Your tool call was CUT OFF by the response token limit — its arguments " +
      "never arrived intact and it was NOT executed. Emit a smaller call now: " +
      "write the file in smaller pieces (create the first part, then extend " +
      "with edit), or split the work across multiple calls. No prose.",
  });
  emitTiming(
    args.report,
    args.taskId,
    args.turn,
    args.turnStart,
    args.taskStart
  );

  return {
    action: "continue",
    readonlyStreak: args.readonlyStreak,
    readonlyRecoveries: args.readonlyRecoveries,
    historyMetaStreak: args.historyMetaStreak,
    forceWriteNext: false,
  };
}

// TTSR init + project/learned-rule loading live in the shared ttsr-init module
// (the interactive session uses the same loaders). Re-exported here so existing
// importers (and tests) keep their path.
export { initTtsrManager, loadProjectTtsrRules };

/** Handle a TTSR interrupt in the headless loop: apply the shared interrupt
 *  (count, report, inject corrective guidance, disable at the cap) then emit
 *  timing for the interrupted turn. */
function handleTtsrInterrupt(
  ttsrFired: { ruleName: string; guidance: string },
  state: ILoopState,
  messages: IChatMessage[],
  report: Reporter,
  taskId: string,
  turn: number,
  turnStart: number,
  taskStart: number,
  ttsrManager: TtsrManager | null
): void {
  applyTtsrInterrupt(ttsrFired, state, messages, report, taskId, ttsrManager);
  emitTiming(report, taskId, turn, turnStart, taskStart);
}

/**
 * MEMORY post-run hook: mine this run's events for failure→fix lessons and
 * consolidate them into `.tsforge/`. Best-effort: a memory failure never
 * affects the run's result. `runId` is unique per run so the same task re-run
 * counts as a distinct session for the recurrence gate.
 */
async function consolidateLessons(
  cwd: string,
  events: readonly ILoopEvent[],
  runId: string,
  report: Reporter
): Promise<void> {
  try {
    const candidates = mineLessons(events);
    const active = await consolidateMemory(cwd, candidates, runId);

    if (active > 0) {
      report({
        kind: "ttsr",
        task: runId,
        message: `memory: ${String(active)} learned rule(s) active in .tsforge/learned-rules.json`,
      });
    }
  } catch (err) {
    // Memory is supplementary — never let it break a run.
    trace("run.memory", err);
  }
}

/** Narrow headless tool schemas to the write-force set (post-readonly-resteer). */
function writeForceToolsOrAll(tools: readonly unknown[]): unknown[] {
  const forced = tools.filter((tool) => {
    if (typeof tool !== "object" || tool === null || !("function" in tool)) {
      return false;
    }

    const fn = tool.function;

    return (
      typeof fn === "object" &&
      fn !== null &&
      "name" in fn &&
      typeof fn.name === "string" &&
      WRITE_FORCE_TOOL_NAMES.has(fn.name)
    );
  });

  return forced.length > 0 ? forced : [...tools];
}

/** Assemble per-call completion options, leaving optional knobs unset when absent. */
function completionOptionsFor(args: {
  tools: unknown[];
  temperature: number;
  enableThinking: boolean | undefined;
  thinkingTokenBudget: number | undefined;
  reasoningEffort: "low" | "medium" | "high" | undefined;
  ttsrManager: TtsrManager | null;
  report: Reporter;
  taskId: string;
  toolChoice?: "auto" | "required";
}): Parameters<IProvider["complete"]>[1] {
  return {
    tools: args.tools,
    temperature: args.temperature,
    toolChoice: args.toolChoice ?? "auto",
    ...(args.enableThinking === undefined
      ? {}
      : { enableThinking: args.enableThinking }),
    ...(args.thinkingTokenBudget === undefined
      ? {}
      : { thinkingTokenBudget: args.thinkingTokenBudget }),
    ...(args.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: args.reasoningEffort }),
    ...(args.ttsrManager === null ? {} : { ttsrManager: args.ttsrManager }),
    onToken: (text) => {
      args.report({ kind: "token", task: args.taskId, message: text });
    },
  };
}

function effectiveParserFor(
  parse: ErrorParser | undefined
): ErrorParser | undefined {
  return parse;
}

/** Detect the stack and fold in tsforge.config.json pack/rule overrides, plus any
 *  rule packs from configured external plugins. */
/** The optional policy fields for the loop context (kept off `runTask` so its
 *  `exactOptionalPropertyTypes` spreads don't inflate its cognitive complexity). */
export function policyCtxFields(
  policy: ITsforgeProjectConfig["policy"],
  override?: PolicyMode
): {
  policyMode?: PolicyMode;
  policyRules?: IPolicyRules;
} {
  // A `--policy-mode` CLI override wins over the config's `policy.mode` for this
  // run; the config still supplies the rules.
  const mode = override ?? policy?.mode;

  return {
    ...(mode === undefined ? {} : { policyMode: mode }),
    ...(policy?.rules === undefined ? {} : { policyRules: policy.rules }),
  };
}

async function resolveStackForRun(
  cwd: string,
  report: (message: string) => void,
  profile?: ProfileId
): Promise<{
  stackProfile: Awaited<ReturnType<typeof detectStack>>;
  ruleOverrides: Readonly<Record<string, "error" | "warn" | "off">>;
  policy: ITsforgeProjectConfig["policy"];
  conventions: IConventions;
  mcpServers: Readonly<Record<string, IMcpServerConfig>>;
}> {
  const detectedProfile = await detectStack(cwd);
  const {
    loadTsforgeConfig,
    resolveActivePacks,
    normalizeRuleOverrides,
    withProfileOverride,
  } = await import("../config/tsforge-config");
  const { resolveConventions } = await import("../infer-rules/conventions");
  const { loadAndRegisterPlugins } = await import("../config/external-plugins");
  const cfg = withProfileOverride(await loadTsforgeConfig(cwd), profile);
  const activePacks = resolveActivePacks(detectedProfile.packs, cfg);
  const externalIds =
    cfg.plugins === undefined
      ? []
      : await loadAndRegisterPlugins(cfg.plugins, cwd, report);
  // The global registry (`~/.tsforge/models.json`) merged with this project's
  // `tsforge.config.json` (project entries win on a name collision) — same
  // precedence as the interactive Session.create path.
  const globalMcpServers = await loadGlobalMcpServers();
  const mcpServers = mergeMcpServers(globalMcpServers, cfg.mcpServers ?? {});

  return {
    stackProfile: {
      ...detectedProfile,
      packs:
        externalIds.length > 0 ? [...activePacks, ...externalIds] : activePacks,
    },
    ruleOverrides: normalizeRuleOverrides(cfg),
    policy: cfg.policy,
    conventions: resolveConventions(cfg.conventions),
    mcpServers,
  };
}

/** Helper for readonly-spin limit reached: report the stuck state and return terminal result. */
function handleExhaustedRecoveries(args: {
  readonlyRecoveries: number;
  turn: number;
  report: Reporter;
  taskId: string;
  turnStart: number;
  taskStart: number;
  gateErrors: IErrorItem[];
}): { action: IRunResult; readonlyRecoveries: number } {
  const handoff: IHandoff = {
    block: "readonly-spin",
    rungHistory: [],
    errors: args.gateErrors.map((e) => e.message).slice(0, 3),
    ask: "model called only read-only tools without making progress toward the goal",
    resumable: true,
    resume: { triedLevers: [] },
  };

  args.report({
    kind: "stuck",
    task: args.taskId,
    cycles: args.turn,
    message:
      "⚠ model kept calling read-only tools without making progress after re-steering — stopped. Narrow the task or steer toward a concrete step.",
  });

  emitTiming(
    args.report,
    args.taskId,
    args.turn,
    args.turnStart,
    args.taskStart
  );

  return {
    action: {
      task: args.taskId,
      redConfirmed: true,
      status: RUN_STATUS.stuck,
      cycles: args.turn,
      reason: STUCK_REASON.readonlySpin,
      handoff,
      edits: 0,
      regressions: 0,
    },
    readonlyRecoveries: args.readonlyRecoveries,
  };
}

/** Helper for readonly-spin retry case: push steering message and return retry. */
function handleReadonlyRetry(args: {
  report: Reporter;
  taskId: string;
  messages: IChatMessage[];
  readonlyRecoveries: number;
}): { action: "retry"; readonlyRecoveries: number } {
  args.report({
    kind: "tool",
    task: args.taskId,
    message: "⚠ only reading, no edits — steering toward a concrete change",
  });

  args.messages.push({
    role: "user",
    content:
      "STOP READING. You already have enough context — further survey reads will be rejected. " +
      "Your ONLY allowed tools now are create / edit / edit_lines / check. Call `check` if you " +
      "need the current gate errors, then emit ONE write with real file contents. Do not call " +
      "read, run, or search.",
  });

  return {
    action: "retry",
    readonlyRecoveries: args.readonlyRecoveries + 1,
  };
}

/** Determine the action for readonly-spin guard: null to keep looping, "retry" to
 *  re-steer and continue with incremented recoveries, or an IRunResult to stop.
 *  Extracted to keep runTask under cognitive-complexity 20. */
function readonlySpinStop(args: {
  readonlyStreak: number;
  readonlyRecoveries: number;
  turn: number;
  report: Reporter;
  taskId: string;
  turnStart: number;
  taskStart: number;
  messages: IChatMessage[];
  gateErrors: IErrorItem[];
}): {
  action: IRunResult | "retry" | null;
  readonlyRecoveries: number;
} {
  if (args.readonlyStreak < READONLY_STREAK_LIMIT) {
    return { action: null, readonlyRecoveries: args.readonlyRecoveries };
  }

  if (args.readonlyRecoveries >= MAX_READONLY_RECOVERIES) {
    return handleExhaustedRecoveries({
      readonlyRecoveries: args.readonlyRecoveries,
      turn: args.turn,
      report: args.report,
      taskId: args.taskId,
      turnStart: args.turnStart,
      taskStart: args.taskStart,
      gateErrors: args.gateErrors,
    });
  }

  return handleReadonlyRetry({
    report: args.report,
    taskId: args.taskId,
    messages: args.messages,
    readonlyRecoveries: args.readonlyRecoveries,
  });
}

/** Process a tool-call turn: run the calls and apply read-only-spin guard. Returns
 *  the action to take (continue/retry/stop) and updated streak/recovery counters.
 *  Extracted to keep runTask under cognitive-complexity 20. */
async function processToolCallTurn(args: {
  toolCalls: readonly IToolCall[];
  ctx: ILoopCtx;
  state: ILoopState;
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
  turn: number;
  turnStart: number;
  taskStart: number;
}): Promise<{
  action: "continue" | "retry" | "check-gate" | IRunResult;
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
  forceWriteNext: boolean;
}> {
  const messagesStart = args.ctx.messages.length;
  const touchedEditable = await runToolCalls(
    args.toolCalls,
    args.ctx,
    args.state
  );
  const hadHistoryMeta = turnHadHistoryMetaReject(
    args.ctx.messages,
    messagesStart
  );
  const historyMetaStreak = nextHistoryMetaStreak({
    previous: args.historyMetaStreak,
    hadHistoryMeta,
    successfulWrite: touchedEditable,
  });

  const meta = historyMetaSpinStop({
    historyMetaStreak,
    report: args.ctx.report,
    taskId: args.ctx.task.id,
    turn: args.turn,
    turnStart: args.turnStart,
    taskStart: args.taskStart,
    messages: args.ctx.messages,
  });

  if (meta.action === "retry") {
    return {
      action: "retry",
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
      historyMetaStreak: streakAfterHistoryMetaResteer(),
      forceWriteNext: false,
    };
  }

  if (meta.action !== null) {
    return {
      action: meta.action,
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
      historyMetaStreak,
      forceWriteNext: false,
    };
  }

  const attemptedWrite =
    toolCallsAttemptWrite(args.toolCalls) &&
    !isHistoryMetaOnlyWriteTurn({
      calls: args.toolCalls,
      hadHistoryMeta,
      successfulWrite: touchedEditable,
    });
  const updatedStreak = nextReadonlyStreak({
    previous: args.readonlyStreak,
    progressed: touchedEditable,
    attemptedWrite,
  });

  // Read-only-spin guard: consecutive read-only turns without edits.
  if (updatedStreak === 0) {
    return {
      action: touchedEditable ? "check-gate" : "continue",
      readonlyStreak: 0,
      readonlyRecoveries: args.readonlyRecoveries,
      historyMetaStreak,
      forceWriteNext: false,
    };
  }

  const spin = readonlySpinStop({
    readonlyStreak: updatedStreak,
    readonlyRecoveries: args.readonlyRecoveries,
    turn: args.turn,
    report: args.ctx.report,
    taskId: args.ctx.task.id,
    turnStart: args.turnStart,
    taskStart: args.taskStart,
    messages: args.ctx.messages,
    gateErrors: args.state.prevGateErrors,
  });

  if (spin.action === "retry") {
    return {
      action: "retry",
      readonlyStreak: streakAfterReadonlyResteer(READONLY_STREAK_LIMIT),
      readonlyRecoveries: spin.readonlyRecoveries,
      historyMetaStreak,
      forceWriteNext: true,
    };
  }

  if (spin.action !== null) {
    return {
      action: spin.action,
      readonlyStreak: updatedStreak,
      readonlyRecoveries: spin.readonlyRecoveries,
      historyMetaStreak,
      forceWriteNext: false,
    };
  }

  return {
    action: "continue",
    readonlyStreak: updatedStreak,
    readonlyRecoveries: args.readonlyRecoveries,
    historyMetaStreak,
    forceWriteNext: false,
  };
}

function historyMetaSpinStop(args: {
  historyMetaStreak: number;
  report: Reporter;
  taskId: string;
  turn: number;
  turnStart: number;
  taskStart: number;
  messages: IChatMessage[];
}): { action: IRunResult | "retry" | null } {
  if (args.historyMetaStreak < HISTORY_META_RESTEER_AT) {
    return { action: null };
  }

  if (args.historyMetaStreak >= HISTORY_META_PARK_AT) {
    const handoff: IHandoff = {
      block: STUCK_REASON.historyMetaSpin,
      rungHistory: [],
      errors: [],
      ask: "model kept submitting empty/incomplete create/edit args (L3 / history stub)",
      resumable: true,
      resume: { triedLevers: [] },
    };

    args.report({
      kind: "stuck",
      task: args.taskId,
      cycles: args.turn,
      message:
        "⚠ model kept submitting empty/incomplete create/edit args after " +
        "re-steering — stopped (would otherwise burn the turn cap).",
    });

    emitTiming(
      args.report,
      args.taskId,
      args.turn,
      args.turnStart,
      args.taskStart
    );

    return {
      action: {
        task: args.taskId,
        redConfirmed: true,
        status: RUN_STATUS.stuck,
        cycles: args.turn,
        reason: STUCK_REASON.historyMetaSpin,
        handoff,
        edits: 0,
        regressions: 0,
      },
    };
  }

  if (args.historyMetaStreak !== HISTORY_META_RESTEER_AT) {
    return { action: null };
  }

  args.report({
    kind: "tool",
    task: args.taskId,
    message:
      "⚠ empty/incomplete create/edit loop — steering toward read + real write",
  });
  args.messages.push({ role: "user", content: HISTORY_META_RESTEER });

  return { action: "retry" };
}

/** Handle a model response: check TTSR/degeneration, run tools or settle gate.
 *  Returns the action to take (continue loop / stop with result) plus updated state.
 *  Extracted to reduce runMainLoop complexity. */
async function handleModelResponse(args: {
  res: IModelResponse;
  ctx: ILoopCtx;
  state: ILoopState;
  messages: IChatMessage[];
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
  turn: number;
  turnStart: number;
  taskStart: number;
  report: Reporter;
  taskId: string;
  ttsrManager: Awaited<ReturnType<typeof initTtsrManager>> | null;
  finish: (result: IRunResult) => Promise<IRunResult>;
}): Promise<{
  action: "continue" | IRunResult;
  readonlyStreak: number;
  readonlyRecoveries: number;
  historyMetaStreak: number;
  forceWriteNext: boolean;
}> {
  // TTSR interrupt: continue without settling gate
  if (args.res.ttsrFired !== undefined) {
    handleTtsrInterrupt(
      args.res.ttsrFired,
      args.state,
      args.messages,
      args.report,
      args.taskId,
      args.turn,
      args.turnStart,
      args.taskStart,
      args.ttsrManager
    );

    return {
      action: "continue",
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
      historyMetaStreak: args.historyMetaStreak,
      forceWriteNext: false,
    };
  }

  // Aborted-stream shapes: degeneration (terminal stuck) or a token-cap
  // truncation (re-steer + continue). Grouped so the loop body stays lean.
  const aborted = abortedTurnAction(args);

  if (aborted !== null) {
    return aborted;
  }

  // No tool calls: settle gate or nudge
  if (args.res.toolCalls.length === 0) {
    // R1 Phase A: if pendingDiagnosisSteer is set, this response contains the diagnosis.
    // Capture it, check if trivial, and decide whether to proceed to Phase B or escalate.
    if (hasPendingDiagnosis(args.state)) {
      const escalated = handleR1Diagnosis(
        args.state,
        args.res.content,
        args.state.prevGateErrors
      );

      if (escalated) {
        args.report({
          kind: "tool",
          task: args.taskId,
          message: `R1 diagnosis was trivial — escalating to R2 (reason-more)`,
        });
      }
    }

    const settled = await settleGate(args.ctx, args.state, args.turn);

    emitTiming(
      args.report,
      args.taskId,
      args.turn,
      args.turnStart,
      args.taskStart
    );

    if (settled !== null) {
      if (settled.status === RUN_STATUS.done) {
        announceTaskDone(args.report, args.taskId, settled.cycles);
      }

      // Merge edits/regressions like the tool-call and readonly terminals below
      // — settleGate's result omits them, relying on the caller to attach. This
      // branch used to return `settled` RAW, so a run that edited + regressed and
      // then parked via narration-while-red (or flipped green on a non-edit turn)
      // reported regressions:undefined, which the sweep sums as 0 — zeroing the
      // regression signal for exactly the runs that stalled after regressing.
      return {
        action: {
          ...settled,
          edits: args.state.edits,
          regressions: args.state.regressions,
        },
        readonlyStreak: args.readonlyStreak,
        readonlyRecoveries: args.readonlyRecoveries,
        historyMetaStreak: args.historyMetaStreak,
        forceWriteNext: false,
      };
    }

    // Stopped with no tool call while still red → nudge it to act, not narrate.
    args.messages.push({ role: "user", content: NO_TOOL_CALL_NUDGE });

    return {
      action: "continue",
      readonlyStreak: args.readonlyStreak,
      readonlyRecoveries: args.readonlyRecoveries,
      historyMetaStreak: args.historyMetaStreak,
      forceWriteNext: false,
    };
  }

  // Tool calls: process with history-meta + read-only-spin guards and possibly settle gate
  const tool = await processToolCallTurn({
    toolCalls: args.res.toolCalls,
    ctx: args.ctx,
    state: args.state,
    readonlyStreak: args.readonlyStreak,
    readonlyRecoveries: args.readonlyRecoveries,
    historyMetaStreak: args.historyMetaStreak,
    turn: args.turn,
    turnStart: args.turnStart,
    taskStart: args.taskStart,
  });

  // Re-steering: continue without gate — next turn write-forces.
  if (tool.action === "retry") {
    return {
      action: "continue",
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
      historyMetaStreak: tool.historyMetaStreak,
      forceWriteNext: tool.forceWriteNext,
    };
  }

  // Terminal readonly-spin stop
  if (tool.action instanceof Object && "status" in tool.action) {
    return {
      action: {
        ...tool.action,
        edits: args.state.edits,
        regressions: args.state.regressions,
      },
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
      historyMetaStreak: tool.historyMetaStreak,
      forceWriteNext: false,
    };
  }

  // Tool without edit: continue without gate
  if (tool.action === "continue") {
    emitTiming(
      args.report,
      args.taskId,
      args.turn,
      args.turnStart,
      args.taskStart
    );

    return {
      action: "continue",
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
      historyMetaStreak: tool.historyMetaStreak,
      forceWriteNext: false,
    };
  }

  // Edited file: settle the gate
  const settled = await settleGate(args.ctx, args.state, args.turn);

  emitTiming(
    args.report,
    args.taskId,
    args.turn,
    args.turnStart,
    args.taskStart
  );

  if (settled !== null) {
    if (settled.status === RUN_STATUS.done) {
      announceTaskDone(args.report, args.taskId, settled.cycles);
    }

    return {
      action: {
        ...settled,
        edits: args.state.edits,
        regressions: args.state.regressions,
      },
      readonlyStreak: tool.readonlyStreak,
      readonlyRecoveries: tool.readonlyRecoveries,
      historyMetaStreak: tool.historyMetaStreak,
      forceWriteNext: false,
    };
  }

  return {
    action: "continue",
    readonlyStreak: tool.readonlyStreak,
    readonlyRecoveries: tool.readonlyRecoveries,
    historyMetaStreak: tool.historyMetaStreak,
    forceWriteNext: false,
  };
}

/** Mid-drive compact for the headless loop when prompt tokens cross the window.
 *  Returns true when a compact ran (caller should clear stale lastUsage). */
async function maybeHeadlessAutoCompact(args: {
  messages: IChatMessage[];
  ctx: ILoopCtx;
  provider: IProvider;
  report: Reporter;
  taskId: string;
  lastUsage: ITokenUsage | undefined;
  contextWindow: number | undefined;
  autoCompactAt: number;
}): Promise<boolean> {
  if (args.lastUsage === undefined || args.contextWindow === undefined) {
    return false;
  }

  const pct = autoCompactPct(
    args.lastUsage.promptTokens,
    args.contextWindow,
    args.autoCompactAt
  );

  if (pct === undefined) {
    return false;
  }

  args.report({
    kind: "tool",
    task: args.taskId,
    message: `⊙ context ~${pct}% full — auto-compacting to free room`,
  });

  const compacted = await compactConversation(
    args.messages,
    args.provider,
    args.ctx.cwd
  );

  args.messages.splice(0, args.messages.length, ...compacted.messages);
  args.ctx.messages = args.messages;

  args.report({
    kind: "tool",
    task: args.taskId,
    message: `⊙ ${compactSummaryLine(compacted)}`,
  });

  return true;
}

/** The main turn loop: call the model repeatedly, handle responses with guard checks,
 *  and settle the gate. Returns the final run result. Extracted to keep runTask
 *  under cognitive-complexity 20. */
async function runMainLoop(args: {
  maxTurns: number;
  checkpointIntervalTurns: number;
  provider: IProvider;
  messages: IChatMessage[];
  tools: unknown[];
  temperature: number;
  enableThinking: boolean | undefined;
  thinkingTokenBudget: number | undefined;
  ttsrManager: Awaited<ReturnType<typeof initTtsrManager>> | null;
  report: Reporter;
  taskId: string;
  ctx: ILoopCtx;
  state: ILoopState;
  finish: (result: IRunResult) => Promise<IRunResult>;
  contextWindow?: number;
  autoCompactAt?: number;
}): Promise<IRunResult> {
  let readonlyStreak = 0;
  let readonlyRecoveries = 0;
  let historyMetaStreak = 0;
  let forceWriteNext = false;
  let lastUsage: ITokenUsage | undefined;
  const taskStart = performance.now();
  const autoCompactAt = args.autoCompactAt ?? 0.8;

  for (let turn = 1; turn <= args.maxTurns; turn += 1) {
    const turnStart = performance.now();

    // Heartbeat: emit a checkpoint progress event every checkpointIntervalTurns
    // without terminating — allows checkpoint persistence + monitoring.
    if (turn > 1 && turn % args.checkpointIntervalTurns === 0) {
      args.report({
        kind: "checkpoint",
        task: args.taskId,
        cycle: turn,
        message: `checkpoint: task ${args.taskId} · turn ${turn}`,
      });
    }

    // Hygiene runs inside compaction, not per turn — see compactConversation.
    const didCompact = await maybeHeadlessAutoCompact({
      messages: args.messages,
      ctx: args.ctx,
      provider: args.provider,
      report: args.report,
      taskId: args.taskId,
      lastUsage,
      contextWindow: args.contextWindow,
      autoCompactAt,
    });

    if (didCompact) {
      lastUsage = undefined;
    }

    args.report({
      kind: "cycle",
      task: args.taskId,
      cycle: turn,
      message: `task ${args.taskId} · turn ${turn}: asking model`,
    });

    args.ttsrManager?.resetBuffer();

    // R1 Phase A: when pendingDiagnosisSteer is set, advertise NO tools (empty array)
    // so the model can only produce text (the diagnosis), not tool calls.
    // After readonly-spin re-steer: write-only tools + required tool_choice.
    // Cleared below when handled.forceWriteNext is assigned for the next turn.
    const writeForce = forceWriteNext;

    let callTools: unknown[] = hasPendingDiagnosis(args.state)
      ? []
      : args.tools;
    let toolChoice: "auto" | "required" = "auto";

    if (writeForce && callTools.length > 0) {
      callTools = writeForceToolsOrAll(callTools);
      toolChoice = "required";
    }

    // R2 per-call model overrides (temperature, reasoning effort) — applied to the
    // NEXT main-loop turn only, then cleared. Auxiliary calls stay on defaults.
    const override = args.state.pendingModelOverride;
    const temperature = override?.temperature ?? args.temperature;
    const reasoningEffort = override?.reasoningEffort;

    // Clear the pending override immediately after reading it into locals, BEFORE
    // the provider call. If complete() throws, this ensures the override won't leak
    // into the next successful call (exception-safe one-shot semantics).
    args.state.pendingModelOverride = null;

    // Wall time for the whole call, prefill included — the headless driver runs
    // the long builds, and on a prefix-caching server prefill IS the cost.
    const callStart = performance.now();
    const res = await args.provider.complete(
      args.messages,
      completionOptionsFor({
        tools: callTools,
        temperature,
        enableThinking: args.enableThinking,
        thinkingTokenBudget: args.thinkingTokenBudget,
        reasoningEffort,
        ttsrManager: args.ttsrManager,
        report: args.report,
        taskId: args.taskId,
        toolChoice,
      })
    );

    // The build loop's per-call accounting. The interactive Session has always
    // logged this; the headless driver — the path that actually runs the long
    // builds — did not, so a build log carried no token record at all and a
    // collapsing prefix-cache ratio had nowhere to show up.
    if (res.usage !== undefined) {
      lastUsage = res.usage;
      args.report(
        usageEvent({
          task: args.taskId,
          usage: res.usage,
          callMs: performance.now() - callStart,
          // Carried so malformed-tool-call rate stays correlatable with the
          // thinking mode (analyze-malformed) on the headless path too — the
          // whole point of one shared builder is that neither loop logs less
          // than the other.
          ...(args.enableThinking === undefined
            ? {}
            : { thinking: args.enableThinking }),
        })
      );
    }

    // TTSR-aware: on a mid-stream abort this drops the partial (never-executed)
    // tool_calls so the history has no dangling `tool_calls` (strict APIs 400 otherwise).
    args.messages.push(assistantMessage(res));

    // Every model call advances cooldown accounting — including interrupted
    // ones, otherwise repeatGap rules mis-count after a TTSR retry.
    args.ttsrManager?.incrementTurnCount();

    // Handle the response (guard checks, tools, gate settle).
    const handled = await handleModelResponse({
      res,
      ctx: args.ctx,
      state: args.state,
      messages: args.messages,
      readonlyStreak,
      readonlyRecoveries,
      historyMetaStreak,
      turn,
      turnStart,
      taskStart,
      report: args.report,
      taskId: args.taskId,
      ttsrManager: args.ttsrManager,
      finish: args.finish,
    });

    readonlyStreak = handled.readonlyStreak;
    readonlyRecoveries = handled.readonlyRecoveries;
    historyMetaStreak = handled.historyMetaStreak;
    forceWriteNext = handled.forceWriteNext;

    if (handled.action !== "continue") {
      return args.finish(handled.action);
    }
  }

  args.report({
    kind: "stuck",
    task: args.taskId,
    cycles: args.maxTurns,
    message: `task ${args.taskId}: stuck (hit ${args.maxTurns}-turn runaway crash-guard — progress guards never tripped, which is anomalous)`,
  });

  return args.finish({
    task: args.taskId,
    redConfirmed: true,
    status: RUN_STATUS.stuck,
    cycles: args.maxTurns,
    reason: STUCK_REASON.cap,
    edits: args.state.edits,
    regressions: args.state.regressions,
  });
}

/**
 * The implement loop as a persistent, tool-using conversation. The model drives
 * — it can `read`, `run` (tests/tsc/eslint), `edit`, `create` — and the whole
 * conversation is retained as memory. When it stops calling tools (believes it's
 * done), the harness runs the deterministic gate, which is the ONLY authority on
 * "done": green ⇒ finished; red ⇒ the errors go back into the conversation and it
 * continues. It can't fake completion.
 *
 * This is the RED-first, drive-to-green wrapper the EVAL harness uses; the
 * interactive CLI composes the same `turn.ts` primitives via `Session`.
 */
function scoutSeed(
  opts: IRunOptions,
  tsService: Parameters<typeof buildScoutContext>[0],
  cwd: string,
  editable: readonly IFileView[],
  hasExistingCode: boolean
): string {
  // Opt-in, brownfield-only (a from-scratch build has no callers to map). Kept out
  // of runTask so its branch doesn't add to that function's complexity.
  if (opts.scout !== true || !hasExistingCode) {
    return "";
  }

  return buildScoutContext(tsService, cwd, editable);
}

/**
 * Validate the goalpost up front. RED-first: the gate must fail before we build,
 * so a no-op can't pass for success — UNLESS `requireRed` is false (greenfield,
 * where the global gate is a guardrail, not the per-feature signal). Returns the
 * gate result plus an `early` run result to stop on (already green + RED required),
 * or `early: null` to proceed (after reporting the RED event).
 */
async function redPrecheck(
  task: ITask,
  cwd: string,
  parse: ErrorParser | undefined,
  requireRed: boolean,
  report: Reporter
): Promise<{ red: IValidateResult; early: IRunResult | null }> {
  const red = await validate(task, cwd, parse);

  if (red.passed && requireRed) {
    report({
      kind: "done",
      task: task.id,
      cycles: 0,
      message: `task ${task.id}: already green`,
    });

    return {
      red,
      early: {
        task: task.id,
        redConfirmed: false,
        status: RUN_STATUS.redNotConfirmed,
        cycles: 0,
        edits: 0,
        regressions: 0,
      },
    };
  }

  report({
    kind: "red",
    task: task.id,
    errors: red.errors.length,
    // Carry the failing rule codes so the memory miner can seed the baseline
    // failure set — a one-turn red→green fix has no prior `validated` event.
    rules: red.errors.flatMap((e) => (e.rule === undefined ? [] : [e.rule])),
    message: `task ${task.id}: RED (${red.errors.length} error(s))`,
  });

  return { red, early: null };
}

export async function runTask(
  task: ITask,
  cwd: string,
  provider: IProvider,
  opts: IRunOptions = {}
): Promise<IRunResult> {
  const { parse, enableThinking, thinkingTokenBudget } = opts;
  const effectiveParse = effectiveParserFor(parse);
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTurns = opts.maxTurns ?? LOOP_LIMITS.runawayBackstopTurns;
  const checkpointIntervalTurns =
    opts.checkpointIntervalTurns ?? LOOP_LIMITS.checkpointIntervalTurns;
  // Buffer every event so the post-run memory hook can mine the run for
  // failure→fix lessons, while still forwarding live to the real reporter.
  // Token events are NOT retained: mining reads red/edit/validated/tool kinds
  // only, and a long drive held every streamed token in memory for nothing.
  const base: Reporter = opts.onEvent ?? (() => undefined);
  const events: ILoopEvent[] = [];

  const report: Reporter = (event) => {
    if (event.kind !== "token") {
      events.push(event);
    }

    base(event);
  };

  // Unique per run, so re-running the same task counts as a distinct session for
  // the lesson-recurrence gate.
  const runId = `${task.id}-${Date.now().toString(36)}`;

  const finish = async (result: IRunResult): Promise<IRunResult> => {
    await consolidateLessons(cwd, events, runId, report);

    // Post-work agent review: after a task lands GREEN, read what changed and
    // surface the substance the gate can't (logic/security/edge-cases). Report
    // only here (headless has no human to "offer a fix" to); the repair path is
    // the explicit `--with-review` (reviewRepair). Toggle off with TSFORGE_NO_REVIEW.
    if (
      result.status === RUN_STATUS.done &&
      opts.suppressReview !== true &&
      !flags.noReview()
    ) {
      try {
        const result = await review(provider, cwd, {
          log: (m) => {
            report({ kind: "tool", task: task.id, message: `review: ${m}` });
          },
          onEvent: report,
          ...(opts.reviewProviders !== undefined &&
          opts.reviewProviders.length > 0
            ? { reviewProviders: opts.reviewProviders }
            : {}),
        });

        report({
          kind: "tool",
          task: task.id,
          message: formatReport(result),
        });
      } catch (err) {
        report({
          kind: "tool",
          task: task.id,
          message: `review skipped: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return result;
  };

  report({
    kind: "start",
    task: task.id,
    message: `task ${task.id}: checking current state`,
  });

  const requireRed = opts.requireRed ?? true;
  const { red, early } = await redPrecheck(
    task,
    cwd,
    effectiveParse,
    requireRed,
    report
  );

  if (early !== null) {
    return early;
  }

  // Detect stack once per run, early; tsforge.config.json may adjust it
  const { stackProfile, ruleOverrides, policy, conventions, mcpServers } =
    await resolveStackForRun(
      cwd,
      (message) => {
        report({ kind: "tool", task: task.id, message });
      },
      opts.profile
    );

  report({
    kind: "tool",
    task: task.id,
    message: `detected stack: ${stackProfile.name} (${stackProfile.reason})`,
  });

  const editable = await readFiles(cwd, task.files);
  const context = await readFiles(cwd, task.context ?? []);

  // Existing code to navigate? (editable files already have content). Only then
  // do the LSP nav tools earn their decision-surface cost — see toolsFor(). Also
  // gates the scratch-simplicity guidance (from-scratch builds only).
  const hasExistingCode = editable.some((f) => f.content.trim().length > 0);

  // Build the LanguageService once, up front: scout needs it to seed the prompt,
  // and the loop reuses it (don't build twice).
  const tsService = await buildTsService(cwd);
  const scout = scoutSeed(opts, tsService, cwd, editable, hasExistingCode);

  const messages: IChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(hasExistingCode, stackProfile, conventions),
    },
    {
      role: "user",
      content: seedPrompt(task, editable, context, stackProfile, scout),
    },
  ];

  const imageCaps = await resolveImageCapabilityFlags();
  const github = await resolveGithubCapability(undefined, cwd);
  // Same MCP connection + capability resolution as the interactive session
  // (Session.create in session.ts) — a headless run must get the same Linear /
  // Notion / Sentry verbs an interactive one does when the server is configured.
  const mcpRegistry =
    Object.keys(mcpServers).length === 0
      ? null
      : await connectMcpServers(mcpServers, (message) => {
          report({ kind: "tool", task: task.id, message });
        });
  const linear = resolveLinearCapability(mcpRegistry);
  const notion = resolveNotionCapability(mcpRegistry);
  const sentry = resolveSentryCapability(mcpRegistry);
  // Chrome research bridge (TSFORGE_BROWSER) — same process-wide bridge the
  // interactive session uses; advertised only when this process owns the port.
  const browser = flags.browser()
    ? await openBrowserSession(flags.browserPort())
    : null;
  const browserOn = browser !== null && browser.bridge.status() !== "in-use";
  const caps = {
    ...imageCaps,
    github,
    linear,
    notion,
    sentry,
    browser: browserOn,
  };
  const tools = toolsFor(hasExistingCode, caps);
  const system = messages[0];

  if (browserOn && system !== undefined) {
    system.content = `${system.content}\n\n${BROWSER_RESEARCH_GUIDANCE}`;
  }

  // Mode-aware reasoning cap: scratch tasks over-think unbounded, so default
  // them to the measured knee; existing-code runs stay uncapped (the cap hurts
  // navigation). An explicit opts.thinkingTokenBudget always wins.
  const effectiveThinkingBudget =
    thinkingTokenBudget ??
    (hasExistingCode ? undefined : LOOP_LIMITS.scratchThinkingBudget);

  const ttsrManager = await initTtsrManager(cwd, report, task.id);

  const ctx: ILoopCtx = {
    task,
    cwd,
    tsService,
    report,
    messages,
    // Config-driven policy applies to headless runs too (the critical denies
    // already do, mode-independent; this adds `policy.mode`/`rules`).
    tool: {
      touched: new Set<string>(),
      github,
      linear,
      notion,
      sentry,
      ...(mcpRegistry === null ? {} : { mcpRegistry }),
      ...(browser === null ? {} : { browser }),
      ...policyCtxFields(policy, opts.policyMode),
    },
    gate: {
      parse: effectiveParse,
      stackProfile,
      ruleOverrides:
        Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
      runner: opts.gate ?? commandGate(task, effectiveParse),
      ...(opts.metaBaseline === undefined
        ? {}
        : { metaBaseline: opts.metaBaseline }),
    },
  };
  const state: ILoopState = {
    prevGateErrors: red.errors,
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

  return await runMainLoop({
    maxTurns,
    checkpointIntervalTurns,
    provider,
    messages,
    tools,
    temperature,
    enableThinking,
    thinkingTokenBudget: effectiveThinkingBudget,
    ttsrManager,
    report,
    taskId: task.id,
    ctx,
    state,
    finish,
    ...(opts.contextWindow === undefined
      ? {}
      : { contextWindow: opts.contextWindow }),
    ...(opts.autoCompactAt === undefined
      ? {}
      : { autoCompactAt: opts.autoCompactAt }),
  });
}
