/**
 * Context-pollution controls: one live gate-feedback slot, scrub legacy write
 * stubs, and evict stale read / write-guard residue.
 *
 * Write args stay full in history and on the wire (pi / oh-my-pi / Reasonix).
 * Context is reclaimed from tool *results* — not by projecting create/edit args
 * to `{}` (DeepSeek then re-submits empty shapes forever).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IChatMessage, IProvider } from "../inference";
import { TOOL_NAME } from "../agent/agent.constants";
import { COMPACT_SYSTEM } from "./prompt";
import { isGateFeedbackInject, isChecklistSnapshot } from "./harness-inject";

/**
 * Max unique file paths that keep a live `read` dump in history. Oldest paths
 * beyond this are stubbed for size — never because "N assistant turns passed"
 * (that trap ordered re-reads and deadlocked Shiphold).
 */
export const MAX_LIVE_READ_PATHS = 12;

/**
 * How many later assistant turns before create/edit *tool results* drop their
 * write-guard / CURRENT-content appendices. Args are never aged.
 */
export const STALE_WRITE_ASSISTANT_TURNS = 1;

/**
 * Characters of the newest conversation kept VERBATIM alongside a compaction
 * summary. A summary alone loses the turn in progress — the file being edited,
 * the error just seen — which reads as the model forgetting mid-task.
 *
 * Characters, not tokens: nothing in this codebase estimates tokens, and a
 * guess that has to track the server's tokenizer would be worse than a measure
 * that is exact but indirect.
 */
export const RETAIN_CHARS = 40_000;

/**
 * Cap on the transcript handed to the summarizer. Compaction fires at ~80% of
 * the window, so the unbounded older region was ~200k tokens: a cold prefill a
 * local server could not finish inside the request timeout, which left the
 * session unable to ever get below the threshold it was compacting to escape.
 */
export const SUMMARY_INPUT_CHARS = 60_000;

/** Per-message caps inside the summary transcript. Tool output is the bulk of
 *  a long session and the least useful to a brief, so it gets the least room. */
const SUMMARY_MESSAGE_CHARS = 2000;
const SUMMARY_TOOL_RESULT_CHARS = 400;

/** The summary is a brief, not a transcript — bound its length and its time. */
export const SUMMARY_MAX_TOKENS = 2048;
export const SUMMARY_TIMEOUT_MS = 180_000;

/** User requests kept verbatim-ish in the model-free fallback summary. */
const FALLBACK_USER_TURNS = 12;
const FALLBACK_USER_CHARS = 600;

/** Tool results longer than this get their middle dropped (no model involved). */
export const PRUNE_THRESHOLD_CHARS = 8192;

const PRUNE_HEAD_CHARS = 4096;
const PRUNE_TAIL_CHARS = 1024;

/** Relative-to-project directory where a pruned tool result's full, untruncated
 *  content is spilled before its middle is trimmed from context — so nothing
 *  a prune removes is ever unrecoverable, only out of the model's default view. */
export const SPILL_DIR = ".tsforge/spilled-tool-output";

/**
 * Doubles as the idempotence guard — a result already carrying it is never
 * pruned (or re-spilled) again, so a second pass reclaims nothing and the
 * caller can tell that pruning is spent. Every marker variant (spill
 * succeeded and names the file, or spill failed and falls back to the plain
 * form) starts with exactly this text, so the guard only checks once.
 */
export const SPILL_MARKER_PREFIX = "\n\n[... tool result middle pruned";

/** Fallback marker text when the spill-to-disk write itself fails. */
export const PRUNE_MARKER = `${SPILL_MARKER_PREFIX} ...]\n\n`;

/**
 * Best-effort: write the untruncated tool result to disk and return the
 * project-relative path, or null if the write failed for any reason. A spill
 * is a nice-to-have, so it must never block or fail a prune.
 */
async function spillToolResultToDisk(
  cwd: string,
  id: string,
  content: string
): Promise<string | null> {
  try {
    await mkdir(join(cwd, SPILL_DIR), { recursive: true });
    const relPath = join(SPILL_DIR, `${id}.txt`);

    await writeFile(join(cwd, relPath), content, "utf8");

    return relPath;
  } catch {
    return null;
  }
}

/** A prune reclaiming this fraction (1/N) of the transcript stands in for a summary. */
const PRUNE_SUFFICIENT_DIVISOR = 4;

/** What a compaction did: the new history, plus what a prune-only pass freed. */
export interface ICompactResult {
  before: number;
  after: number;
  messages: IChatMessage[];
  /** Characters reclaimed when pruning alone sufficed and no summary was written.
   *  Absent on a summarizing compact. */
  prunedChars?: number;
  /** Set when the summary model call failed and a model-free brief stood in:
   *  the older turns were still dropped, so the context did shrink. */
  summaryFailed?: string;
}

/**
 * What a compaction did, in one line, for every surface that reports it.
 *
 * A prune-only pass leaves the message COUNT untouched, so the message-count
 * phrasing would read as `compacted 40 → 40 messages` — a change reported as
 * nothing. Shared so the three report sites cannot drift.
 */
export function compactSummaryLine(result: {
  before: number;
  after: number;
  prunedChars?: number;
  summaryFailed?: string;
}): string {
  if (result.summaryFailed !== undefined) {
    return (
      `compacted ${String(result.before)} → ${String(result.after)} messages ` +
      `(summary unavailable: ${result.summaryFailed} — kept your requests verbatim)`
    );
  }

  if (result.prunedChars === undefined) {
    return `compacted ${String(result.before)} → ${String(result.after)} messages`;
  }

  const kb = Math.max(1, Math.round(result.prunedChars / 1024));

  return `pruned ${String(kb)}KB of tool output — no summary needed`;
}

/**
 * Replace the middle of oversized tool results with {@link PRUNE_MARKER};
 * returns the characters reclaimed.
 *
 * Deliberately a SIBLING of `pruneEphemeralToolResidue` rather than part of it.
 * That one is semantic — it supersedes same-path reads and ages write-guard
 * appendices — and it already runs every turn, so by the time compaction fires
 * it has nothing left to give. It also never touches the results that actually
 * dominate a long session: `run` output, test logs, gate dumps. This one is
 * purely about size and knows nothing about which tool produced the bytes.
 */
export async function pruneOversizedToolResults(
  messages: IChatMessage[],
  cwd: string
): Promise<number> {
  let freed = 0;

  for (const [index, m] of messages.entries()) {
    if (m.role !== "tool" || m.content.length <= PRUNE_THRESHOLD_CHARS) {
      continue;
    }

    if (m.content.includes(SPILL_MARKER_PREFIX)) {
      continue;
    }

    const original = m.content.length;
    const id = m.toolCallId ?? `anon_${String(index)}`;
    const spillPath = await spillToolResultToDisk(cwd, id, m.content);
    const marker =
      spillPath === null
        ? PRUNE_MARKER
        : `${SPILL_MARKER_PREFIX} — full output saved to ${spillPath}, read it if the missing detail matters ...]\n\n`;

    m.content = `${m.content.slice(0, PRUNE_HEAD_CHARS)}${marker}${m.content.slice(-PRUNE_TAIL_CHARS)}`;
    freed += original - m.content.length;
  }

  return freed;
}

/** True when a string is (or contains) a harness history marker — never source. */
export function looksLikeHarnessOmitMarker(text: string): boolean {
  return (
    text.includes("harness:content-omitted") ||
    text.includes("harness:read-omitted") ||
    text.includes("[applied; on disk") ||
    text.includes("THIS IS NOT FILE CONTENTS") ||
    text.includes("NOT file contents")
  );
}

function normalizeReadPath(file: string | undefined): string {
  return (file ?? "file").replaceAll("\\", "/");
}

function readOmitStub(path: string, reason: "superseded" | "budget"): string {
  if (reason === "superseded") {
    return (
      `<harness:read-omitted path="${path}" — NOT file contents; ` +
      `superseded by a later read of this path — do NOT call read again; ` +
      `use the live copy still in history or proceed to create/edit.>`
    );
  }

  return (
    `<harness:read-omitted path="${path}" — NOT file contents; ` +
    `dropped for context size — do NOT call read again; ` +
    `write using live copies still in history or proceed to create/edit.>`
  );
}

const WRITE_GUARD_MARKERS: readonly string[] = [
  "\n\n⚠ CHECK of this file",
  "\n\n⚠ BLAST RADIUS",
  "\n\n⚠ STRUCTURE check",
  "\n\nℹ ",
];

/** Replace-or-append the single live settle gate-feedback user message. */
export function upsertGateFeedback(
  messages: IChatMessage[],
  content: string
): void {
  // APPEND. This used to replace the live slot in place and splice out earlier
  // copies, which kept ONE feedback message in history — but anchored it
  // wherever the last settle left it, while the conversation grew past it. In a
  // 146-turn run that anchor ended up ~20k tokens into a 210k prompt, so every
  // settle rewrote the prompt from 10% in and threw away the rest of the
  // server's prefix cache. Measured on that run: 13 calls at 116-168s each,
  // ~1785s of a 3515s session, every one of them 1-3 events after a gate.
  //
  // Appending keeps the prefix byte-identical, so a settle now costs the new
  // message and nothing else. Superseded copies are dropped at compaction, and
  // the system block's HISTORY FRESHNESS rule tells the model the newest one is
  // the live state.
  messages.push({ role: "user", content });
}

/**
 * History-only flag on redacted create/edit toolCall args. Must NOT resemble a
 * schema field (`contentMeta` taught DeepSeek to re-submit create without
 * `content` — dozens of tool_input_rejected:create in one Shiphold run).
 */
export const HARNESS_ARGS_OMITTED = "_harnessArgsOmitted";

/** True when args look like a re-submitted history stub, not a real write. */
export function hasHarnessOmittedArgs(args: Record<string, unknown>): boolean {
  const omit = args[HARNESS_ARGS_OMITTED];

  return (
    omit === true ||
    omit === "true" ||
    args.contentMeta !== undefined ||
    args.oldStringMeta !== undefined ||
    args.newStringMeta !== undefined
  );
}

/**
 * Outbound wire projection for create/edit args. Live history keeps full
 * bodies. Legacy omit stubs (pre-fix `--continue` sessions) have no body to
 * send — project to `{}` so the model never sees `_harnessArgsOmitted` or a
 * copyable `{file}` stub.
 */
export function projectWriteArgsForWire(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (toolName !== TOOL_NAME.create && toolName !== TOOL_NAME.edit) {
    return args;
  }

  if (!hasHarnessOmittedArgs(args)) {
    return args;
  }

  return {};
}

/** Tool-result text from create/edit:history-meta rejects. */
export function isHistoryMetaRejectContent(content: string): boolean {
  return content.includes("harness history stub");
}

function stubFileOnly(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [HARNESS_ARGS_OMITTED]: true,
  };
  const file = typeof args.file === "string" ? args.file : undefined;

  if (file !== undefined) {
    out.file = file;
  }

  return out;
}

/**
 * Rewrite legacy `contentMeta` / `*StringMeta` stubs left in persisted history
 * (pre-fix redaction). `--continue` was replaying those and the model copied
 * them as create/edit args forever.
 */
export function scrubLegacyWriteArgStubs(messages: IChatMessage[]): number {
  let n = 0;

  for (const m of messages) {
    if (m.role !== "assistant" || m.toolCalls === undefined) {
      continue;
    }

    for (const tc of m.toolCalls) {
      if (tc.name !== TOOL_NAME.create && tc.name !== TOOL_NAME.edit) {
        continue;
      }

      if (!hasHarnessOmittedArgs(tc.arguments)) {
        continue;
      }

      // Already the safe shape.
      if (
        tc.arguments[HARNESS_ARGS_OMITTED] === true &&
        tc.arguments.contentMeta === undefined &&
        tc.arguments.oldStringMeta === undefined &&
        tc.arguments.newStringMeta === undefined &&
        tc.arguments.content === undefined &&
        tc.arguments.oldString === undefined &&
        tc.arguments.newString === undefined &&
        tc.arguments.edits === undefined
      ) {
        continue;
      }

      tc.arguments = stubFileOnly(tc.arguments);
      n += 1;
    }
  }

  return n;
}

function callMeta(
  messages: readonly IChatMessage[]
): Map<string, { name: string; file?: string }> {
  const meta = new Map<string, { name: string; file?: string }>();

  for (const m of messages) {
    if (m.role !== "assistant" || m.toolCalls === undefined) {
      continue;
    }

    m.toolCalls.forEach((tc, ti) => {
      const id = tc.id ?? `call_${String(ti)}`;
      const file =
        typeof tc.arguments.file === "string" ? tc.arguments.file : undefined;

      meta.set(
        id,
        file === undefined ? { name: tc.name } : { name: tc.name, file }
      );
    });
  }

  return meta;
}

function hasLaterGateFeedback(
  messages: readonly IChatMessage[],
  fromIndex: number
): boolean {
  for (let i = fromIndex + 1; i < messages.length; i += 1) {
    const m = messages[i];

    if (m !== undefined && isGateFeedbackInject(m)) {
      return true;
    }
  }

  return false;
}

function stripWriteGuardBlast(content: string): string {
  let cut = -1;

  for (const marker of WRITE_GUARD_MARKERS) {
    const idx = content.indexOf(marker);

    if (idx >= 0 && (cut < 0 || idx < cut)) {
      cut = idx;
    }
  }

  if (cut < 0) {
    return content;
  }

  const head = content.slice(0, cut).trimEnd();

  if (head.includes("[write-guard detail dropped")) {
    return content;
  }

  return `${head}\n\n[write-guard detail dropped — see latest gate feedback]`;
}

function shouldAgeWriteResult(
  messages: readonly IChatMessage[],
  toolIndex: number,
  assistantAfter: number
): boolean {
  return (
    assistantAfter >= STALE_WRITE_ASSISTANT_TURNS ||
    hasLaterGateFeedback(messages, toolIndex)
  );
}

/** Supersede older same-path reads; record newest-first live indices. */
function pruneOneReadDump(
  m: IChatMessage,
  path: string,
  index: number,
  seenReadPaths: Set<string>,
  liveReadIndices: number[]
): void {
  if (seenReadPaths.has(path)) {
    m.content = readOmitStub(path, "superseded");

    return;
  }

  seenReadPaths.add(path);
  liveReadIndices.push(index);
}

/** Drop oldest unique live reads past MAX_LIVE_READ_PATHS (newest-first list). */
function trimLiveReadBudget(
  messages: IChatMessage[],
  meta: Map<string, { name: string; file?: string }>,
  liveReadIndices: readonly number[]
): void {
  for (let k = MAX_LIVE_READ_PATHS; k < liveReadIndices.length; k += 1) {
    const idx = liveReadIndices[k];

    if (idx === undefined) {
      continue;
    }

    const m = messages[idx];

    if (m?.role !== "tool" || m.toolCallId === undefined) {
      continue;
    }

    if (m.content.includes("harness:read-omitted")) {
      continue;
    }

    const info = meta.get(m.toolCallId);

    m.content = readOmitStub(normalizeReadPath(info?.file), "budget");
  }
}

/**
 * Evict superseded / over-budget `read` dumps and collapse write-guard /
 * CURRENT-content appendices on aged create/edit tool results. Create/edit
 * *args* stay full — peers reclaim context from results, not by stubbing writes.
 *
 * Reads: keep the latest live dump per path; omit older same-path dumps
 * (superseded). Cap unique live paths at MAX_LIVE_READ_PATHS. Never omit solely
 * because assistant turns passed, and never tell the model to re-read.
 */
export function pruneEphemeralToolResidue(messages: IChatMessage[]): void {
  scrubLegacyWriteArgStubs(messages);

  const meta = callMeta(messages);
  let assistantAfter = 0;
  const seenReadPaths = new Set<string>();
  /** Newest-first indices of live (kept) unique-path reads — for budget trim. */
  const liveReadIndices: number[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];

    if (m === undefined) {
      continue;
    }

    if (m.role === "assistant") {
      assistantAfter += 1;
      continue;
    }

    if (m.role !== "tool" || m.toolCallId === undefined) {
      continue;
    }

    const info = meta.get(m.toolCallId);

    if (
      info?.name === TOOL_NAME.read &&
      !m.content.includes("harness:read-omitted")
    ) {
      pruneOneReadDump(
        m,
        normalizeReadPath(info.file),
        i,
        seenReadPaths,
        liveReadIndices
      );
    }

    if (
      (info?.name === TOOL_NAME.create || info?.name === TOOL_NAME.edit) &&
      shouldAgeWriteResult(messages, i, assistantAfter)
    ) {
      m.content = stripWriteGuardBlast(m.content);
    }
  }

  trimLiveReadBudget(messages, meta, liveReadIndices);
}

/** Percent full when over the auto-compact threshold; otherwise undefined. */
export function autoCompactPct(
  promptTokens: number,
  contextWindow: number,
  autoCompactAt: number
): number | undefined {
  if (contextWindow <= 0) {
    return undefined;
  }

  const fraction = promptTokens / contextWindow;

  return fraction >= autoCompactAt ? Math.round(fraction * 100) : undefined;
}

/**
 * Keep only the newest of a repeated harness inject.
 *
 * Both the plan tree and the gate feedback are APPENDED rather than rewritten in
 * place, so a long session accumulates superseded copies. Only the newest is
 * authoritative; the rest are dropped here, at the one point where editing
 * history costs nothing extra.
 */
function dropSuperseded(
  messages: IChatMessage[],
  matches: (m: IChatMessage) => boolean
): void {
  let newest = -1;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];

    if (m !== undefined && matches(m)) {
      newest = i;
      break;
    }
  }

  if (newest < 0) {
    return;
  }

  for (let i = newest - 1; i >= 0; i -= 1) {
    const m = messages[i];

    if (m !== undefined && matches(m)) {
      messages.splice(i, 1);
    }
  }
}

/**
 * What a message really costs the context.
 *
 * `content` alone undercounts an assistant turn badly: create/edit tool-call
 * ARGUMENTS carry whole file bodies and are deliberately kept full in history
 * (see this module's header), so a turn holding an 80KB write measures as ~0
 * against a character budget that is supposed to bound it.
 */
function messageChars(m: IChatMessage): number {
  const args =
    m.toolCalls?.reduce(
      (sum, tc) => sum + JSON.stringify(tc.arguments).length,
      0
    ) ?? 0;

  return m.content.length + args;
}

/**
 * Indices a retain window is allowed to begin at: every message that is not a
 * tool result, i.e. every step boundary.
 *
 * A step is one non-tool message plus the tool results answering it, and the
 * window may only ever start on one. Beginning mid-step would retain a result
 * whose declaring `tool_calls` turn was summarized away; `toWire` then emits a
 * `tool_call_id` that no preceding assistant message declares, which an
 * OpenAI-compatible server rejects. Because the compacted array becomes the live
 * history, that ends the session rather than one request. The wipe-everything
 * compaction this replaced could not orphan anything — the retain window is what
 * introduces the hazard, so this is a correctness constraint, not a nicety.
 *
 * Leading orphans (results already in history with nothing declaring them) are
 * not boundaries either, so they can only ever fall in the summarized region.
 */
function stepStartIndices(conversation: readonly IChatMessage[]): number[] {
  const starts: number[] = [];

  conversation.forEach((m, i) => {
    if (m.role !== "tool") {
      starts.push(i);
    }
  });

  return starts;
}

/**
 * Where the verbatim retain window begins: the oldest step boundary whose whole
 * suffix still fits the budget.
 *
 * Whole steps only. Admitting a partial step and then snapping backward to pick
 * up its declaring turn cannot work — the walk stopped precisely because that
 * turn did not fit, so re-admitting it always breaks the budget it just
 * respected. When even the newest step is too big to fit, nothing is retained.
 */
function retainStartIndex(conversation: readonly IChatMessage[]): number {
  const costs = conversation.map(messageChars);
  const total = costs.reduce((sum, c) => sum + c, 0);
  // Half the transcript caps the window, so an older region always survives to
  // be summarized and "everything fits, nothing to summarize" cannot arise.
  const budget = Math.min(RETAIN_CHARS, Math.floor(total / 2));
  const starts = stepStartIndices(conversation);
  let suffix = 0;
  let next = conversation.length;
  let start = conversation.length;

  for (let k = starts.length - 1; k >= 0; k -= 1) {
    const boundary = starts[k] ?? 0;

    for (let i = next - 1; i >= boundary; i -= 1) {
      suffix += costs[i] ?? 0;
    }

    next = boundary;

    if (suffix > budget) {
      break;
    }

    start = boundary;
  }

  return start;
}

/**
 * Free context: summarize the older conversation and keep the newest stretch
 * VERBATIM as [system?, summary, ...retained]. Shared by interactive Session and
 * headless runTask.
 *
 * A model-free prune runs first. When it reclaims enough on its own the summary
 * call is skipped entirely — the session clears its stale usage reading after a
 * compact, so the next real model call re-measures against the server's own
 * token count and decides whether more is needed. Nothing here estimates tokens.
 */
export async function compactConversation(
  messages: IChatMessage[],
  provider: IProvider,
  cwd: string,
  signal?: AbortSignal
): Promise<ICompactResult> {
  const before = messages.length;
  const totalChars = messages.reduce((sum, m) => sum + messageChars(m), 0);

  // Compaction is the ONE point where rewriting history is free: the prefix is
  // being rebuilt regardless, so the prefix-cache invalidation every one of
  // these edits causes is already paid for. Running them per turn instead costs
  // a full cold prefill to reclaim tokens the cache was serving for ~nothing.
  dropSuperseded(messages, isChecklistSnapshot);
  dropSuperseded(messages, isGateFeedbackInject);
  pruneEphemeralToolResidue(messages);

  const prunedChars = await pruneOversizedToolResults(messages, cwd);

  if (
    prunedChars > 0 &&
    prunedChars >= Math.floor(totalChars / PRUNE_SUFFICIENT_DIVISOR)
  ) {
    return { before, after: before, messages, prunedChars };
  }

  // Pruning already mutated `messages`, so an early return still has to report
  // what it freed — otherwise a compact that did real work prints as a no-op.
  // Both branches below are only reachable on an empty transcript today (the
  // half-transcript cap guarantees an older region whenever there is content),
  // but they are on the honest side of that guarantee rather than relying on it.
  const freed = prunedChars > 0 ? { prunedChars } : {};
  // NON-LEADING system messages (a later persisted system instruction —
  // delegation notes, scope directives) are PRESERVED, not summarized away:
  // resumeMessages explicitly promises they survive, and compaction silently
  // deleting a system-authority instruction is a behavior change mid-session.
  const laterSystem = messages.filter((m, i) => i > 0 && m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  if (conversation.length === 0) {
    return { before, after: before, messages, ...freed };
  }

  const start = retainStartIndex(conversation);
  const older = conversation.slice(0, start);

  if (older.length === 0) {
    return { before, after: before, messages, ...freed };
  }

  const brief = await summarizeOlder(older, provider, signal);
  const system = messages[0];
  const summary: IChatMessage = {
    role: "user",
    content: `[Summary of the earlier conversation]\n${brief.text}`,
  };
  const retained = conversation.slice(start);
  const next: IChatMessage[] =
    system?.role === "system"
      ? [system, ...laterSystem, summary, ...retained]
      : [...laterSystem, summary, ...retained];

  return {
    before,
    after: next.length,
    messages: next,
    ...(brief.failed === undefined ? {} : { summaryFailed: brief.failed }),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} […]`;
}

/** One message as the summarizer sees it: capped, with the tool calls named
 *  (their arguments are file bodies — the call's target is what a brief needs). */
function summaryLine(m: IChatMessage): string {
  const cap =
    m.role === "tool" ? SUMMARY_TOOL_RESULT_CHARS : SUMMARY_MESSAGE_CHARS;
  const calls = (m.toolCalls ?? []).map((tc) => {
    const target = tc.arguments.path ?? tc.arguments.url ?? tc.arguments.topic;

    return typeof target === "string" ? `${tc.name}(${target})` : tc.name;
  });
  const called = calls.length > 0 ? ` → ${calls.join(", ")}` : "";

  return `[${m.role}] ${clip(m.content, cap)}${called}`;
}

/**
 * The summarizer's input, bounded by {@link SUMMARY_INPUT_CHARS}. Over budget,
 * the OLDEST non-user lines go first: the user's requests are the goals the
 * brief exists to carry, and they are small.
 */
export function summaryTranscript(older: readonly IChatMessage[]): string {
  const lines = older.map((m) => ({
    user: m.role === "user",
    text: summaryLine(m),
  }));
  let total = lines.reduce((sum, l) => sum + l.text.length + 2, 0);
  let omitted = 0;

  for (const line of lines) {
    if (total <= SUMMARY_INPUT_CHARS) {
      break;
    }

    if (!line.user) {
      total -= line.text.length + 2;
      line.text = "";
      omitted += 1;
    }
  }

  const kept = lines.filter((l) => l.text.length > 0).map((l) => l.text);
  const note =
    omitted > 0
      ? [`[${String(omitted)} older tool/assistant messages omitted]`]
      : [];

  return [...note, ...kept].join("\n\n");
}

/** A brief written without the model: the user's latest requests, verbatim-ish.
 *  Used when the summary call fails, so compaction still frees the context. */
export function fallbackBrief(older: readonly IChatMessage[]): string {
  const users = older.filter((m) => m.role === "user");
  // The FIRST request is usually the overall goal; the rest are the latest.
  const picked =
    users.length <= FALLBACK_USER_TURNS
      ? users
      : [users[0], ...users.slice(-(FALLBACK_USER_TURNS - 1))];
  const asks = picked.map(
    (m) => `- ${clip((m?.content ?? "").trim(), FALLBACK_USER_CHARS)}`
  );

  return [
    "(The automatic summary could not be written; earlier tool activity was dropped.",
    "Check files on disk for work already done before redoing it.)",
    ...(asks.length > 0 ? ["User requests so far:", ...asks] : []),
  ].join("\n");
}

/** Summarize the older region with bounded input, output and time. A failure
 *  other than the caller's own abort falls back to {@link fallbackBrief} rather
 *  than propagating: a compaction that throws leaves the context exactly as
 *  full as before, so every later send would retry it and fail the same way. */
async function summarizeOlder(
  older: readonly IChatMessage[],
  provider: IProvider,
  signal?: AbortSignal
): Promise<{ text: string; failed?: string }> {
  const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);

  try {
    const res = await provider.complete(
      [
        { role: "system", content: COMPACT_SYSTEM },
        { role: "user", content: summaryTranscript(older) },
      ],
      {
        temperature: 0,
        enableThinking: false,
        maxTokens: SUMMARY_MAX_TOKENS,
        signal:
          signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      }
    );

    if (res.content.trim().length > 0) {
      return { text: res.content };
    }

    return { text: fallbackBrief(older), failed: "empty reply" };
  } catch (err) {
    if (signal?.aborted === true) {
      throw err;
    }

    const detail = err instanceof Error ? err.message : String(err);

    return { text: fallbackBrief(older), failed: detail };
  }
}
