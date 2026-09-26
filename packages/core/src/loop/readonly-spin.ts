/**
 * Read-only-spin streak math — shared by Session and headless runTask.
 *
 * Soft text re-steers do nothing on DeepSeek (Shiphold: same 3-file read loop
 * after every nudge). Rules:
 * - Successful write OR attempted write tool → streak 0
 * - Otherwise → +1 (including re-reads; no "survey grace" — that let loops run)
 * - After a re-steer, callers MUST keep the streak high and force write tools
 */
import { TOOL_NAME } from "../agent/agent.constants";

/** Tools that count as "tried to mutate" even when args/policy reject.
 *  Also: mid-turn `check` and checklist mutations — after GREEN Phase B the
 *  model must be able to verify / advance the plan without burning the
 *  readonly-spin budget on honest exploration. */
export const WRITE_ATTEMPT_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAME.create,
  TOOL_NAME.edit,
  TOOL_NAME.editLines,
  TOOL_NAME.renameSymbol,
  TOOL_NAME.moveFile,
  TOOL_NAME.addDependency,
  TOOL_NAME.check,
  TOOL_NAME.taskComplete,
  TOOL_NAME.taskFocus,
  TOOL_NAME.taskAdd,
  TOOL_NAME.taskUpdate,
  // A research session reads for many turns by design; saving notes is its
  // "write". Without this a long thread read trips the re-steer mid-page.
  TOOL_NAME.note,
]);

/** Offered after a readonly re-steer — model cannot pick survey reads again.
 *  Includes `check` so it can re-gate without shelling out to tsc (DeepSeek
 *  dogfood: STOP READING left no way to verify mid-force-write). */
export const WRITE_FORCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAME.create,
  TOOL_NAME.edit,
  TOOL_NAME.editLines,
  TOOL_NAME.check,
  TOOL_NAME.note,
]);

/** Research tools: fetching, searching, and reading pages (the web tools and
 *  the Chrome bridge). Progress in a session with no live gate. */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAME.webFetch,
  TOOL_NAME.webSearch,
  TOOL_NAME.webBrowse,
  TOOL_NAME.packageInfo,
  TOOL_NAME.packageDocs,
  TOOL_NAME.browserTabs,
  TOOL_NAME.browserAdopt,
  TOOL_NAME.browserOpen,
  TOOL_NAME.browserNavigate,
  TOOL_NAME.browserRead,
  TOOL_NAME.browserClick,
  TOOL_NAME.browserScroll,
  TOOL_NAME.browserScreenshot,
  TOOL_NAME.redditSearch,
  TOOL_NAME.redditThread,
  TOOL_NAME.redditListing,
  TOOL_NAME.redditSubreddits,
]);

export function toolCallsDoResearch(
  calls: readonly { readonly name: string }[]
): boolean {
  return calls.some((c) => RESEARCH_TOOLS.has(c.name));
}

/** Restrict an offered tool list to write-force names (post-readonly-resteer). */
export function filterWriteForceTools<
  T extends { readonly function: { readonly name: string } },
>(tools: readonly T[]): T[] {
  return tools.filter((t) => WRITE_FORCE_TOOL_NAMES.has(t.function.name));
}

/** True when the model issued a mutating tool this turn (even if args rejected). */
export function isAttemptedWriteTool(name: string): boolean {
  return WRITE_ATTEMPT_TOOLS.has(name);
}

export function toolCallsAttemptWrite(
  calls: readonly { readonly name: string }[]
): boolean {
  return calls.some((c) => isAttemptedWriteTool(c.name));
}

/**
 * Next readonly streak after one tool turn.
 * Survey-hold was removed — it delayed parks and made soft re-steers useless.
 */
export function nextReadonlyStreak(opts: {
  readonly previous: number;
  readonly progressed: boolean;
  readonly attemptedWrite: boolean;
}): number {
  if (opts.progressed || opts.attemptedWrite) {
    return 0;
  }

  return opts.previous + 1;
}

/** Keep streak hot after a soft re-steer so the next read burns a recovery. */
export function streakAfterReadonlyResteer(limit: number): number {
  return Math.max(1, limit - 1);
}
