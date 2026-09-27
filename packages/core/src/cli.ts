#!/usr/bin/env bun
import {
  runTask,
  RUN_STATUS,
  review,
  reviewRepair,
  renderReport,
  runGreenfield,
  prepareState,
  planFeatures,
  type IGreenfieldDeps,
  type Reporter,
} from "./loop";
import { modelAgent, AgentRunner, type IAgentResult } from "./agent";
import { AgentScheduler } from "./agent/agent-scheduler";
import { loadAgentSpecs, findAgentSpec } from "./config/agent-specs";
import { isPolicyMode } from "./policy";
import { loadRecipes, findRecipe } from "./config/recipes";
import {
  parseArgs,
  applyRecipe,
  isOneShot,
  scopeOf,
  cliUsage,
  resolveCliProfile,
  profileFlagError,
  policyModeFlagError,
  valueFlagError,
  type ICliArgs,
} from "./cli/args";
import { validate } from "./validate";
import { composeGate } from "./gate/gate-runner";
import { judgeStage } from "./loop/boringstack/gate-stages";
import type { OpenAICompatibleProvider } from "./inference";
import {
  resolveActiveModel,
  resolveModelByName,
  loadModelsConfig,
} from "./models-config";
import type { ITask } from "./spec";
import { runShellCommand } from "./lib/fs";
import { currentVersion } from "./update-check";
import { trace } from "./lib/trace";
import { repl } from "./cli/repl";
import { runMapCommand, runTraceCommand } from "./cli/repl-commands";
import {
  makeProvider,
  resolveReviewProviders,
  modelForRun,
  envNumber,
} from "./cli/model-setup";
import { makeReporter, resolveLogPath, withLedger } from "./cli/logging";
import { resolveGate } from "./cli/gate-setup";
import {
  findConfigUp,
  loadTsforgeConfig,
  resolveAgentConcurrency,
} from "./config/tsforge-config";
import { applySettings } from "./config/user-settings";
import {
  makeAgentSummaryTracker,
  renderAgentTree,
  AgentTreeModel,
  type IRowMeta,
} from "./render/agent-tree";
import { LiveRegion } from "./render/live-region";
import type { UnitStatus } from "./agent/agent-scheduler";

/**
 * The tsforge CLI — the product surface over the same engine the eval harness
 * uses (see cli-product-direction). Like any agentic CLI: cd into a repo, run it,
 * and talk. The agent reads/runs/edits the whole workspace by default.
 *
 *   tsforge                       # interactive session in the current repo
 *   tsforge --dir ~/app           # ...in another repo
 *   tsforge "fix the build"       # interactive, with that as the first message
 *   tsforge "fix X" --accept "npm test"   # one-shot: drive to green, then exit
 *   tsforge --continue            # resume the most recent session for this dir
 *
 * The eval-only knobs are now OPTIONAL refinements, never required:
 *   --files "<globs>"   narrow the editable scope (default: the whole workspace)
 *   --accept "<cmd>"    a gate that confirms "done" (default: stop when the model
 *                       stops — like any chat agent). With a gate set, tsforge's
 *                       deterministic check enforces correctness; it can't be faked.
 *   --log               record the full event stream (reasoning, every file the
 *                       agent writes, gate verdicts, timing) as JSONL to an
 *                       auto-named ~/.tsforge/logs/<timestamp>-<id>.jsonl — the
 *                       record to evaluate runs and see where the model got stuck.
 * Slash commands (/help, /clear, /exit) follow the standard harness UX. Provider
 * via TSFORGE_* env.
 */
export {
  parseArgs,
  applyRecipe,
  isOneShot,
  resolveCliProfile,
  type ICliArgs,
} from "./cli/args";

export { makeSpinner, spinnerPhase, type ISpinnerOut } from "./render/spinner";
export { providerConfig } from "./cli/model-setup";
export { isApproval, isPlanApproval } from "./cli/repl";

/** One-shot: drive a single task to green, then exit. */
async function runOnce(args: ICliArgs): Promise<number> {
  const task: ITask = {
    id: "cli",
    intent: args.task,
    accept: args.accept,
    files: scopeOf(args),
    context: [],
  };

  const logFile = resolveLogPath("cli", args.log);

  if (logFile.length > 0) {
    process.stdout.write(`  ↳ logging this run to ${logFile}\n`);
  }

  const thinkingTokenBudget =
    args.thinkingBudget > 0
      ? args.thinkingBudget
      : envNumber("TSFORGE_THINKING_BUDGET");
  const { entry } = await modelForRun(args);
  const provider = makeProvider(entry);
  // Configured reviewer model(s); empty ⇒ the main model reviews (the default).
  const reviewProviders = resolveReviewProviders(await loadModelsConfig());
  const report = makeReporter(logFile, "cli");
  const profile = resolveCliProfile(args.profile);
  const result = await runTask(task, args.dir, provider, {
    onEvent: report,
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(args.maxTurns > 0 ? { maxTurns: args.maxTurns } : {}),
    ...(args.scout ? { scout: true } : {}),
    ...(profile === undefined ? {} : { profile }),
    // Honor `--policy-mode` in one-shot too (validated in main()); without this
    // the documented flag was a silent no-op on the headless path.
    ...(isPolicyMode(args.policyMode) ? { policyMode: args.policyMode } : {}),
    ...(reviewProviders.length > 0 ? { reviewProviders } : {}),
    // `--with-review` runs reviewRepair below (review + one repair cycle), so
    // suppress runTask's own report-only review to avoid reviewing twice.
    ...(args.withReview ? { suppressReview: true } : {}),
  });
  const ok = result.status === RUN_STATUS.done;

  process.stdout.write(
    `\n${ok ? "✓ done" : `✗ ${result.status}`} in ${String(result.cycles)} turn(s)\n`
  );

  // Optional post-green adversarial review + one repair cycle (reverts if it
  // breaks the gate). Only meaningful once the task is actually green.
  if (ok && args.withReview) {
    await reviewRepair(provider, args.dir, task, modelAgent(provider), {
      ...(args.base.length > 0 ? { base: args.base } : {}),
      ...(reviewProviders.length > 0 ? { reviewProviders } : {}),
      onEvent: report,
    });
  }

  return ok ? 0 : 1;
}

/** Run the auto/explicit gate ONCE and return its distinct failing rule ids, so a
 *  gate-aware review skips what the gate already covers. Green/no-gate → []. */
async function gateFailingRules(args: ICliArgs): Promise<string[]> {
  // Running the gate can throw (missing deps, a broken gate command, env issues).
  // A gate-aware review is an enhancement, never a hard dependency — on any failure
  // fall back to a full review instead of crashing the command.
  try {
    const gate = await resolveGate(args, null);

    if (gate.accept.length === 0) {
      return [];
    }

    const task: ITask = { id: "review", accept: gate.accept, files: [] };
    const result = await validate(task, args.dir);

    if (result.passed) {
      return [];
    }

    const rules = new Set<string>();

    for (const error of result.errors) {
      if (typeof error.rule === "string" && error.rule.length > 0) {
        rules.add(error.rule);
      }
    }

    return [...rules];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stdout.write(
      `gate: couldn't run the gate (${message}) — falling back to full review\n`
    );

    return [];
  }
}

async function reviewMode(args: ICliArgs): Promise<number> {
  const { entry } = await resolveActiveModel();
  const rules = args.withGate ? await gateFailingRules(args) : [];

  if (args.withGate) {
    process.stdout.write(
      rules.length > 0
        ? `gate: ${rules.length} failing rule(s) — review will skip what they cover\n`
        : "gate: green — full functional review\n"
    );
  }

  // Fan-out cap from tsforge.config.json `agents.concurrency` (default 1 =
  // sequential). Above 1, each unit gets a FRESH provider (per-instance
  // thinking-latch state) and a live `agents: …` progress line.
  const concurrency = resolveAgentConcurrency(
    await loadTsforgeConfig(args.dir)
  );

  if (concurrency > 1) {
    process.stdout.write(`agents: fan-out enabled (cap ${concurrency})\n`);
  }

  // Configured reviewer model(s); empty ⇒ the primary model reviews.
  const reviewProviders = resolveReviewProviders(await loadModelsConfig());

  // `--log` previously only worked for `runOnce`'s reporter (`makeReporter`,
  // bound to the terminal render pipeline `review` doesn't use) — `review`
  // accepted and silently ignored the flag. `withLedger` wraps review's own
  // summary-tracker reporter instead, so the flag actually does something here.
  const logFile = resolveLogPath("review", args.log);

  if (logFile.length > 0) {
    process.stdout.write(`  ↳ logging this run to ${logFile}\n`);
  }

  const report = await review(makeProvider(entry), args.dir, {
    ...(args.base.length > 0 ? { base: args.base } : {}),
    staged: args.staged,
    ...(rules.length > 0 ? { gateFailingRules: rules } : {}),
    ...(reviewProviders.length > 0 ? { reviewProviders } : {}),
    log: (m) => process.stdout.write(`  ↳ ${m}\n`),
    concurrency,
    // Each reviewer runs as a live agent; summarize the fan-out to the
    // transcript, and (when --log is set) also append the raw event to the
    // ledger.
    onEvent: withLedger(
      makeAgentSummaryTracker((line) => process.stdout.write(`  ↳ ${line}\n`)),
      logFile,
      "review"
    ),
  });

  process.stdout.write(
    args.json
      ? `${renderReport(report, true)}\n`
      : `\n${renderReport(report, false)}\n`
  );

  // Exit non-zero when there are error-severity findings, so it's CI-usable.
  return report.findings.some((f) => f.severity === "error") ? 1 : 0;
}

/** Print one agent's outcome block to the transcript. */
function printAgentResult(
  id: string,
  result: IAgentResult | undefined,
  write: (m: string) => void
): boolean {
  if (result === undefined) {
    write(`\n=== ${id}: did not run ===`);

    return false;
  }

  const seconds = (result.durationMs / 1000).toFixed(1);
  const turns = `${String(result.turns)} turn${result.turns === 1 ? "" : "s"}`;

  write(`\n=== ${id}: ${result.status} (${seconds}s, ${turns}) ===`);
  write(result.output);

  return result.status === "done";
}

/** Live progress for a fan-out — the TTY tree or the piped summary line. */
interface IAgentProgress {
  onUnit: (id: string, status: UnitStatus) => void;
  /** Freeze the animation and clear the live region (TTY); no-op otherwise. */
  stop: () => void;
}

/** Terminal-row metadata (wall-clock + turns) from a finished unit's result. */
function metaFromResult(
  result: IAgentResult | undefined
): IRowMeta | undefined {
  return result === undefined
    ? undefined
    : { durationMs: result.durationMs, turns: result.turns };
}

/** Non-TTY path: fold unit transitions into the one-line summary tracker. */
function summaryProgress(): IAgentProgress {
  const tracker = makeAgentSummaryTracker(
    (line) => void process.stdout.write(`  ↳ ${line}\n`)
  );

  return {
    onUnit: (id, status): void => {
      if (status === "pending") {
        tracker({ kind: "agent_spawned", task: "agents", message: id });
      } else if (status === "start") {
        tracker({ kind: "agent_started", task: "agents", message: id });
      } else {
        tracker({
          kind: "agent_result",
          task: "agents",
          message: id,
          passed: status === "done",
        });
      }
    },
    stop: (): void => undefined,
  };
}

/** TTY path: a spinner-animated agent tree pinned to the bottom of the screen,
 *  repainted on every transition and on a timer so running rows animate. */
function treeProgress(
  results: ReadonlyMap<string, IAgentResult>
): IAgentProgress {
  const model = new AgentTreeModel();
  const live = new LiveRegion(process.stdout, true);
  let frame = 0;

  const repaint = (): void => {
    // Read the live terminal size on every repaint so a mid-run resize adapts:
    // a stale width would break line-clipping (wrapped rows → ghosting), and a
    // stale height would let the block scroll off. Cap the tree to the viewport
    // so the pinned block never scrolls — the cursor-climb redraw is only
    // correct while the whole block stays on screen.
    const columns = process.stdout.columns > 0 ? process.stdout.columns : 80;
    const rows = process.stdout.rows > 0 ? process.stdout.rows : 24;
    const maxRows = Math.max(3, rows - 3);

    live.render(
      renderAgentTree(model.rows(), { columns, maxRows, frame, color: true })
    );
  };

  const ticker = setInterval(() => {
    frame += 1;
    repaint();
  }, 120);

  return {
    onUnit: (id, status): void => {
      const meta =
        status === "done" || status === "failed"
          ? metaFromResult(results.get(id))
          : undefined;

      model.applyUnit(id, status, meta);
      repaint();
    },
    stop: (): void => {
      clearInterval(ticker);
      live.clear();
    },
  };
}

/** Pick the live-progress surface for a fan-out: the tree on a real terminal,
 *  the summary line when piped/redirected. */
function makeAgentProgress(
  results: ReadonlyMap<string, IAgentResult>
): IAgentProgress {
  return process.stdout.isTTY ? treeProgress(results) : summaryProgress();
}

/** `tsforge agents` — list discovered agent specs, or fan the named specs out
 *  over a task (read-only, concurrency-capped, project policy enforced). */
async function agentsMode(args: ICliArgs): Promise<number> {
  const write = (m: string): void => void process.stdout.write(`${m}\n`);
  const specs = await loadAgentSpecs(args.dir, (m) => {
    write(`  ↳ ${m}`);
  });

  if (args.agentIds.length === 0) {
    if (specs.length === 0) {
      write(
        "No agent specs found. Add .tsforge/agents/<id>.json to define one."
      );
    } else {
      write("Available agents:");

      for (const s of specs) {
        write(
          `  ${s.id}${s.description === undefined ? "" : ` — ${s.description}`}`
        );
      }

      write('\nRun them: tsforge agents <id,id> "task"');
    }

    return 0;
  }

  if (args.task.length === 0) {
    write('agents: a task is required — tsforge agents <ids> "task"');

    return 1;
  }

  const ids = args.agentIds
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const missing = ids.filter((id) => findAgentSpec(specs, id) === undefined);

  if (missing.length > 0) {
    const available = specs.map((s) => s.id).join(", ");

    write(
      `agents: unknown spec(s): ${missing.join(", ")} (available: ${available.length > 0 ? available : "none"})`
    );

    return 1;
  }

  const config = await loadTsforgeConfig(args.dir);
  const concurrency = resolveAgentConcurrency(config);
  // Subagents obey the SAME policy as a session would: --policy-mode wins,
  // else the config file's policy.mode, else default (PR #75 P1 lesson).
  const policyMode = isPolicyMode(args.policyMode)
    ? args.policyMode
    : (config.policy?.mode ?? "default");
  const policyRules = config.policy?.rules;
  const results = new Map<string, IAgentResult>();
  const progress = makeAgentProgress(results);
  const scheduler = new AgentScheduler({
    concurrency,
    onUnit: progress.onUnit,
  });

  write(`agents: running ${ids.join(", ")} (cap ${String(concurrency)})`);

  const units = ids.map((id) => ({
    id,
    run: async (signal: AbortSignal): Promise<IAgentResult | null> => {
      const spec = findAgentSpec(specs, id);

      if (spec === undefined) {
        return null; // unreachable: ids were validated above
      }

      try {
        // Model precedence: the spec's pin wins, else --model/recipe model,
        // else the active model (resolveModelByName's own fallback).
        const modelName =
          spec.model ?? (args.model.length > 0 ? args.model : undefined);
        const { entry } = await resolveModelByName(modelName);
        const result = await new AgentRunner(spec).run({
          provider: makeProvider(entry),
          cwd: args.dir,
          parentTaskId: "agents",
          task: args.task,
          signal,
          policyMode,
          ...(policyRules === undefined ? {} : { policyRules }),
        });

        results.set(id, result);

        if (result.status !== "done") {
          // max_turns/aborted/error are all failures: throw so the live
          // summary marks the unit failed, matching the block + exit code.
          throw new Error(`${result.status}: ${result.output}`);
        }

        return result;
      } catch (err) {
        // Setup failures (bad model, provider construction) would otherwise
        // vanish into the scheduler's null slot as a bare "did not run" —
        // record a synthetic error result so the block shows the reason.
        if (!results.has(id)) {
          results.set(id, {
            status: "error",
            output: err instanceof Error ? err.message : String(err),
            outputKind: "answer",
            turns: 0,
            durationMs: 0,
            events: [],
          });
        }

        throw err;
      }
    },
  }));

  try {
    await scheduler.runParallel(units);
  } finally {
    progress.stop();
  }

  let allDone = true;

  for (const id of ids) {
    if (!printAgentResult(id, results.get(id), write)) {
      allDone = false;
    }
  }

  return allDone ? 0 : 1;
}

async function mapMode(args: ICliArgs): Promise<number> {
  await runMapCommand(args.dir, args.task);

  return 0;
}

/** `tsforge setup` — the onboarding wizard that infers + writes project
 *  conventions. `--yes` writes the recommendations non-interactively. */
async function setupMode(args: ICliArgs): Promise<number> {
  const { runSetup } = await import("./setup/run-setup");

  return runSetup({
    cwd: args.dir,
    yes: args.setupYes,
    color: process.stdout.isTTY,
  });
}

/** `tsforge recipes` — list the recipes discovered for this repo. */
async function recipesMode(args: ICliArgs): Promise<number> {
  const recipes = await loadRecipes(args.dir, (m) =>
    process.stdout.write(`  ${m}\n`)
  );

  if (recipes.length === 0) {
    process.stdout.write(
      "no recipes found — add .tsforge/recipes/<id>.json (see the docs)\n"
    );

    return 0;
  }

  process.stdout.write("Recipes:\n");

  for (const recipe of recipes) {
    const desc =
      recipe.description === undefined ? "" : ` — ${recipe.description}`;

    process.stdout.write(`  ${recipe.id}${desc}\n`);
  }

  return 0;
}

/** Resolve `--recipe`/`tsforge run <id>` and overlay it onto args. Returns an
 *  exit code to abort on (unknown id), or null to continue dispatching. */
async function applyRecipeArg(args: ICliArgs): Promise<number | null> {
  if (args.recipe.length === 0) {
    return null;
  }

  const recipes = await loadRecipes(args.dir, (m) =>
    process.stdout.write(`  ${m}\n`)
  );
  const recipe = findRecipe(recipes, args.recipe);

  if (recipe === undefined) {
    process.stdout.write(
      `unknown recipe: ${args.recipe} — run \`tsforge recipes\` to list them\n`
    );

    return 1;
  }

  applyRecipe(args, recipe);
  process.stdout.write(`using recipe '${recipe.id}'\n`);

  return null;
}

async function traceMode(args: ICliArgs): Promise<number> {
  return runTraceCommand(args.task);
}

/** Build the greenfield deps: implement one feature with the work model (reusing
 *  the headless runTask driver against a composed gate). The gate + escalation
 *  ladder runs inside the session's loop. The composed gate = the --accept command
 *  gate + the reject-by-default judge (no browser/reachability target in generic CLI).
 *  The judge makes the gate RED until the feature is really built, so RED-first holds
 *  and we no longer need requireRed:false. */
function greenfieldDeps(
  args: ICliArgs,
  work: OpenAICompatibleProvider,
  evaluator: OpenAICompatibleProvider,
  scope: string[],
  report: Reporter
): IGreenfieldDeps {
  const thinkingTokenBudget =
    args.thinkingBudget > 0
      ? args.thinkingBudget
      : envNumber("TSFORGE_THINKING_BUDGET");

  return {
    implement: async (feature) => {
      const base = {
        id: feature.id,
        intent: feature.desc,
        accept: args.accept,
        files: scope,
        context: [],
      };

      // The composed gate: the --accept command + the reject-by-default judge.
      // (Generic CLI greenfield has no browser/reachability target.) The judge
      // makes the gate RED until the feature is really built, so RED-first holds
      // and we no longer need requireRed:false.
      const gate = composeGate([
        { run: (cwd, opts) => validate(base, cwd, undefined, opts ?? {}) },
        judgeStage(evaluator, args.dir, feature),
      ]);

      const result = await runTask(base, args.dir, work, {
        onEvent: report,
        gate,
        ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
        ...(args.maxTurns > 0 ? { maxTurns: args.maxTurns } : {}),
        ...(isPolicyMode(args.policyMode)
          ? { policyMode: args.policyMode }
          : {}),
      });

      return {
        done: result.status === RUN_STATUS.done,
        ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
      };
    },
  };
}

/** A `--notify` hook is bounded: an unattended/cron run must not hang forever on a
 *  notifier that wedges (a `curl` to a dead host with no `--max-time`, a stray
 *  `read` on stdin). 30s is generous for a real ping yet always lets the run end. */
const NOTIFY_TIMEOUT_MS = 30_000;

/** Run the `--notify` shell command (if any) with the run outcome in
 *  $TSFORGE_STATUS — a ping for unattended/cron runs. Best-effort: a failing,
 *  missing, OR HANGING notifier never changes the run's exit code, because it
 *  routes through the shared runner (uniform kill-timeout) and is bounded. */
export async function runNotify(
  cwd: string,
  cmd: string,
  status: string,
  timeoutMs: number = NOTIFY_TIMEOUT_MS
): Promise<void> {
  if (cmd.length === 0) {
    return;
  }

  try {
    await runShellCommand(cwd, cmd, {
      timeoutMs,
      env: { ...process.env, TSFORGE_STATUS: status },
      onChunk: (text) => process.stdout.write(text),
    });
  } catch (err) {
    // A broken notifier must not break the run.
    trace("cli.notify", err);
  }
}

/** `tsforge --greenfield "<goal>"` / a recipe with `mode: "greenfield"`: plan a
 *  feature checklist (planner model), then drive it to all-green one feature at a
 *  time on the existing gate + browser + judge stack, persisting state so a long
 *  run resumes. Roles route to separate models when configured, else all share
 *  the active model. */
async function greenfieldMode(args: ICliArgs): Promise<number> {
  if (args.task.length === 0) {
    process.stdout.write(
      'missing build goal — usage: tsforge --greenfield "build a kanban app"\n'
    );

    return 1;
  }

  if (args.accept.length === 0) {
    process.stdout.write(
      "greenfield needs a build gate — pass --accept '<cmd>' or set `gate` in the recipe\n"
    );

    return 1;
  }

  // Each role falls back to the recipe's `model` (then the active model), per the
  // recipe contract — a recipe that sets only `model` must route ALL roles there,
  // not just the work role.
  const roleName = (specific: string): string =>
    specific.length > 0 ? specific : args.model;
  const planner = makeProvider(
    (await resolveModelByName(roleName(args.plannerModel))).entry
  );
  const work = makeProvider(
    (await resolveModelByName(roleName(args.workModel))).entry
  );
  const evaluator = makeProvider(
    (await resolveModelByName(roleName(args.evaluatorModel))).entry
  );

  const state = await prepareState(args.dir, args.task, (goal) =>
    planFeatures(planner, goal)
  );

  if (state === null) {
    process.stdout.write("planner produced no features — nothing to build\n");

    return 1;
  }

  const report = makeReporter(
    resolveLogPath("greenfield", args.log),
    "greenfield"
  );
  const scope = scopeOf(args);
  const result = await runGreenfield(
    args.dir,
    state,
    greenfieldDeps(args, work, evaluator, scope, report),
    { onEvent: report }
  );

  const done = result.features.filter((f) => f.passes).length;

  const statusMsg =
    result.status === "done"
      ? "✓ all features verified"
      : result.status === "needs-plan"
        ? "⚠ build requires an approved plan"
        : `✗ stuck on '${result.stuckFeature ?? "?"}'`;

  process.stdout.write(`\n${statusMsg} (${done}/${result.features.length})\n`);

  await runNotify(
    args.dir,
    args.notify,
    `greenfield ${result.status} ${done}/${result.features.length}`
  );

  return result.status === "done" ? 0 : 1;
}

/**
 * `tsforge scaffold …` — greenfield wizard that stands up BoringStack, its
 * Astro static site, or the Phaser 4 game template. Delegates remaining argv to the scaffold command's own
 * parser (--archetype/--stack/--dest/--set/--multi/--ref/--no-boot), so its
 * vocabulary doesn't collide with the harness flags. Prints the handoff (where +
 * how to run the gate); the model-driven build loop is then a normal `tsforge`
 * invocation against that dir + gate.
 */
async function scaffoldMode(argv: readonly string[]): Promise<number> {
  const { runScaffoldCommand } = await import("./scaffold/scaffold-command");
  const outcome = await runScaffoldCommand(argv, process.stdout.isTTY);

  if (outcome === null) {
    process.stdout.write("scaffold: cancelled — nothing was created.\n");

    return 1;
  }

  const { parseScaffoldArgs } = await import("./scaffold/scaffold-cli");
  const { formatScaffoldHandoff } = await import("./scaffold/handoff");
  const archetype = parseScaffoldArgs(argv).answers.archetype;

  process.stdout.write(
    formatScaffoldHandoff(
      {
        dir: outcome.dir,
        sha: outcome.resolvedSha,
        booted: outcome.booted,
        summary: outcome.summary,
        archetype,
        interactive: false,
        ...(outcome.bootError === undefined
          ? {}
          : { bootError: outcome.bootError }),
      },
      process.stdout.isTTY
    )
  );

  return outcome.bootError === undefined ? 0 : 1;
}

export async function main(): Promise<number> {
  const raw = process.argv.slice(2);

  if (raw[0] === "scaffold") {
    return scaffoldMode(raw.slice(1));
  }

  if (raw[0] === "harness-review") {
    const { harnessReviewMode } = await import("./cli/harness-review-mode");

    return harnessReviewMode(raw.slice(1));
  }

  if (raw[0] === "harness-diagnose") {
    const { harnessDiagnoseMode } = await import("./cli/harness-diagnose-mode");

    return harnessDiagnoseMode(raw.slice(1));
  }

  // BEFORE any dispatch, including --version/--help/recipes and the recipe overlay.
  // A malformed invocation must not quietly do something else first: `tsforge
  // recipes --dir --plan` would otherwise list recipes for the wrong directory and
  // exit 0, and a recipe lookup would run its I/O before the error surfaced.
  // (The subcommands above parse their own argv, so they are exempt.)
  const valueErr = valueFlagError(raw);

  if (valueErr !== null) {
    process.stdout.write(`${valueErr}\n`);

    return 1;
  }

  const args = parseArgs(raw);

  // ~/.tsforge/config.json + tsforge.config.json `settings`/`env` → process.env
  // (real env wins), before anything reads a flag.
  applySettings(process.env, await findConfigUp(args.dir));

  // `--version`/`--help` print and exit — before this fix an unknown flag fell
  // through as a POSITIONAL, so `tsforge --version` booted a session with the
  // literal task "--version" (and install.sh advertises `tsforge --help`).
  if (args.version) {
    process.stdout.write(`tsforge ${currentVersion()}\n`);

    return 0;
  }

  if (args.help) {
    process.stdout.write(cliUsage());

    return 0;
  }

  if (args.recipes) {
    return recipesMode(args);
  }

  if (args.run && args.recipe.length === 0) {
    process.stdout.write(
      "missing recipe id — usage: tsforge run <id> [task] (see `tsforge recipes`)\n"
    );

    return 1;
  }

  // A `--recipe`/`run <id>` overlays the recipe's fields onto args (CLI wins),
  // then dispatch continues as if those were passed directly.
  const recipeAbort = await applyRecipeArg(args);

  if (recipeAbort !== null) {
    return recipeAbort;
  }

  // A typo'd `--profile` must fail loudly too: `--profile stict` parses fine but would
  // quietly run at the default strictness. Checked after the recipe overlay so it covers
  // CLI and recipe-set profiles.
  const profileErr = profileFlagError(args.profile, raw.includes("--profile"));

  if (profileErr !== null) {
    process.stdout.write(`${profileErr}\n`);

    return 1;
  }

  // A typo'd `--policy-mode` must fail loudly for the same reason — but the
  // stakes are higher: an unvalidated value was silently discarded and the
  // session fell to a MORE PERMISSIVE posture (plan-first off, or a config
  // bypassPermissions winning). A safety flag never fails open on a typo.
  const policyErr = policyModeFlagError(
    args.policyMode,
    raw.includes("--policy-mode")
  );

  if (policyErr !== null) {
    process.stdout.write(`${policyErr}\n`);

    return 1;
  }

  if (args.review) {
    return reviewMode(args);
  }

  if (args.agents) {
    return agentsMode(args);
  }

  if (args.map) {
    return mapMode(args);
  }

  if (args.trace) {
    return traceMode(args);
  }

  if (args.setup) {
    return setupMode(args);
  }

  if (args.greenfield) {
    return greenfieldMode(args);
  }

  // A positional task with a scope + gate ⇒ one-shot; otherwise interactive.
  return isOneShot(args) ? runOnce(args) : repl(args);
}

// Direct run (`bun src/cli.ts`, dev). The published binary instead imports
// `main` from bin/tsforge.js, because `import.meta.main` is false when this
// module is imported rather than executed as the entry point.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `tsforge: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
