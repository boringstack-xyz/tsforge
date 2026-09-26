/**
 * CLI-side reporting plumbing: the shared spinner, the terminal Reporter, the
 * `--log` JSONL ledger reporter, and run-log path helpers. Rendered output is
 * routed through the OutputRouter: the REPL installs a StatusBar-aware parent
 * sink (so text scrolls above the pinned input row); subagents get their own
 * sinks from Phase B on; everywhere else writes go straight to stdout.
 */
import { join, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { makeSpinner, spinnerPhase } from "../render/spinner";
import { renderEvent } from "../render";
import {
  LedgerWriter,
  ledgerTypeFor,
  type Reporter,
  type ILoopEvent,
} from "../loop";
import { logsDir } from "../session-store";
import { trace } from "../lib/trace";
import { OutputRouter } from "./output-router";

export const spinner = makeSpinner();

/** The process-wide router for the one terminal. The REPL installs its parent
 *  sink at boot and clears it on exit; agent sinks come and go per subagent. */
export const outputRouter = new OutputRouter();

/** A live observer of EVERY rendered event — the REPL registers one to drive the
 *  agent tree (folding `agent_*` lifecycle events and diverting subagent output).
 *  Module-level because `render` is the one choke point all events pass through;
 *  null when no REPL is attached (headless/one-shot). */
let eventObserver: ((event: ILoopEvent) => void) | null = null;

export function observeEvents(fn: ((event: ILoopEvent) => void) | null): void {
  eventObserver = fn;
}

const LIFECYCLE_KINDS: ReadonlySet<string> = new Set([
  "agent_spawned",
  "agent_started",
  "agent_result",
]);

/** A `start` event carrying run metadata (`model` / `contextWindow`) is the
 *  log header, not transcript text. Plain `start` events (a task beginning)
 *  carry neither and still render. */
export function isRunMeta(event: ILoopEvent): boolean {
  return (
    event.kind === "start" &&
    (event.model !== undefined || event.contextWindow !== undefined)
  );
}

/** Boot-time terminal write. Goes through the router (not straight to stdout)
 *  so `beginCapture` can hold it until the pane console can render it inside
 *  the TUI. Once capture ends this behaves exactly like a stdout write. */
export function bootWrite(text: string): void {
  outputRouter.route(text);
}

const render: Reporter = (event) => {
  // The observer (the REPL's agent-tree feeder) must never take down rendering:
  // a throw here would propagate out of the reporter and crash the turn/session.
  try {
    eventObserver?.(event);
  } catch (err) {
    trace("cli.eventObserver", err);
  }

  // Subagent lifecycle events are STRUCTURAL — they drive the live tree, not the
  // transcript. When a tree observer is attached it renders them (a row + the
  // `↳ label` detail header); routing their text too would divert the agent's
  // own description into its detail buffer and print the label two more times
  // under the tree. So skip rendering here once the observer has been notified.
  // Headless/one-shot has no observer, so they still render as linear-log lines.
  if (eventObserver !== null && LIFECYCLE_KINDS.has(event.kind)) {
    return;
  }

  // The run-meta `start` event exists so a --log is self-describing for the
  // analyzer (`model` / `contextWindow`, see ILoopEvent). It is addressed to the
  // ledger, not to the human at the terminal — rendering it printed a bare
  // `model … · context window …` line above the pane console, which then wiped
  // it on the first paint. withLedger still records it; only the render is
  // skipped, so the log keeps its header.
  if (isRunMeta(event)) {
    return;
  }

  const phase = spinnerPhase(event);

  if (phase !== null) {
    spinner.setLabel(phase);
  }

  const out = renderEvent(event, { color: true });

  if (out.length > 0) {
    spinner.clear();
    outputRouter.route(out, event.agentId);
  }
};

/** Wraps any Reporter so that, when `--log <file>` is set, every event it
 *  sees is ALSO appended as JSONL (one event per line, timestamped) — the
 *  durable record of what the agent did: its reasoning, every file it
 *  wrote, the gate verdicts, and the loops it got stuck in. Append-only
 *  (NOT overwritten like the session JSON). Logging failures never break
 *  the session. `logFile === ""` (logging off) returns `delegate` as-is. */
export function withLedger(
  delegate: Reporter,
  logFile: string,
  runId: string,
  sessionId?: string
): Reporter {
  if (logFile.length === 0) {
    return delegate;
  }

  const ledger = new LedgerWriter(logFile, runId, sessionId);

  return (event) => {
    delegate(event);

    const { kind, agentId, ...rest } = event;

    ledger.record(ledgerTypeFor(event), { kind, ...rest }, agentId);
  };
}

/** `withLedger` bound to the CLI's own terminal reporter — what every
 *  command used before `withLedger` existed to let others (e.g. `review`,
 *  whose reporter isn't the terminal one) reuse the same ledger wiring. */
export function makeReporter(
  logFile: string,
  runId: string,
  sessionId?: string
): Reporter {
  return withLedger(render, logFile, runId, sessionId);
}

/** Wrap a reporter so `onCheckpoint` runs on every checkpoint event. The REPL
 *  saves the session there: a research send can run for days, and saving only
 *  when a send ends would lose the whole conversation to a crash or reboot. */
export function withCheckpointHook(
  report: Reporter,
  onCheckpoint: () => void
): Reporter {
  return (event) => {
    report(event);

    if (event.kind === "checkpoint") {
      onCheckpoint();
    }
  };
}

/** Resolve the run-log file when `--log` is set: an auto-named, timestamped JSONL
 *  under ~/.tsforge/logs/ (created if needed), so logs are always in one findable
 *  place and you never specify a path. Empty string = logging off. */
export function resolveLogPath(id: string, enabled: boolean): string {
  if (!enabled) {
    return "";
  }

  const dir = logsDir();

  mkdirSync(dir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..+$/, "");

  return join(dir, `${stamp}-${id}.jsonl`);
}

/** Resolve the newest `--log` JSONL under ~/.tsforge/logs, or "" if none. */
export async function newestLogFile(): Promise<string> {
  try {
    // Filenames are ISO-timestamp-prefixed, so lexicographic sort = chronological.
    const names = (await readdir(logsDir()))
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    const latest = names.at(-1);

    return latest === undefined ? "" : join(logsDir(), latest);
  } catch (err) {
    trace("cli.newestLogFile", err);

    return "";
  }
}

/** A user-supplied log path resolved against cwd, or "" when none was given. */
export function resolveLogArg(arg: string): string {
  if (arg.length === 0) {
    return "";
  }

  return isAbsolute(arg) ? arg : join(process.cwd(), arg);
}
