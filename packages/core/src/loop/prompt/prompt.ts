import type { ITask } from "../../spec";
import type { IFileView } from "../../lib/fs";
import { PACK_REGISTRY } from "../../stack-detection";
import type { IStackProfile } from "../../stack-detection";
import { flags } from "../../config";
import { DEFAULT_CONVENTIONS } from "../../infer-rules/conventions";
import type { IConventions } from "../../infer-rules/conventions.types";
import {
  interfaceNamingPhrase,
  testLayoutPhrase,
} from "../../infer-rules/guidance";
import { renderFileSection } from "./project-map";
import { activeOverlay } from "../../self-harness/overlay";
import type { PromptBlockName } from "../../self-harness/self-harness.types";
import { summarizeGateCommand } from "../gate-visibility";

/** Apply the active self-harness overlay's edit (if any) to a NAMED editable
 *  prompt block. With no overlay this returns `base` untouched, so the base
 *  harness stays byte-identical. Only the named blocks route through here —
 *  identity, tools, and the gate-rules sentence are not editable surfaces. */
function overlayBlock(base: string, name: PromptBlockName): string {
  const edit = activeOverlay()?.promptBlocks[name];

  if (edit === undefined) {
    return base;
  }

  return edit.mode === "replace" ? edit.text : `${base}\n${edit.text}`;
}

/** The strict-TS house-rules line, with the interface-naming clause tuned to the
 *  project's convention (omitted entirely when naming is "off"). The safety rules
 *  (`as`/`any`/`!`, `===`) are unconditional. */
function gateRulesSentence(conventions: IConventions): string {
  const naming = interfaceNamingPhrase(conventions);
  const namingPart = naming === null ? "" : `${naming}; `;

  return `The gate is \`tsc\` strict + eslint with every rule an error, so write TypeScript that satisfies it: ${namingPart}\`===\`; no \`var\`; never the non-null \`!\` — guard index access (\`const x = arr[i]; if (x === undefined) {...}\`); no \`any\` and no \`as\` — type every parameter (e.g. \`.reduce((acc: number, r: number) => …, 0)\`); for IDs use a plain alias (\`type UserId = string\`) validated at the boundary, NOT branded/nominal types (\`string & { _brand }\`) — they require an \`as\` cast to construct, which the gate rejects; explicit boolean conditions. When the gate flags errors in read-only files (tests/types), they come from your editable file being missing or wrong-shaped and vanish once it's correct — don't edit them.`;
}

/** The implement-agent system prompt: who it is, the tools, and the strict-TS
 *  house rules the gate enforces (the naming clause follows the project's
 *  conventions so the prompt never contradicts the gate). */
export function buildSystem(conventions: IConventions): string {
  return [
    "You are an expert TypeScript engineer working inside tsforge, a harness specialized for STRICT TypeScript. Implement the task by editing code until the gate passes.",
    "Tools: `read` (inspect a file), `edit` (replace an exact, unique snippet), `create` (a new file), `run` (execute any shell command and see its output).",
    overlayBlock(
      "Lead with action: start writing code right away (one `create`/`edit`) — do NOT deliberate at length before writing any code. (In TDD mode the test comes first; see the test-first guidance below.)",
      "bootstrap"
    ),
    overlayBlock(
      "After every edit the harness AUTOMATICALLY runs the gate and gives you the result (the errors + fix guidance for the failing rules). You do NOT need to run the acceptance command yourself — read that result and fix exactly what it reports, then edit again. Keep going until it reports green; the harness ends the task at that point.",
      "execution"
    ),
    "The harness also AUTO-FIXES mechanical formatting on every file you write — blank lines, braces, quotes, semicolons, import order, `prefer-template`. NEVER hand-fix or chase those, and do NOT run `tsc`/`eslint`/the gate yourself to look for them. Fix only what the gate explicitly hands back (`as`/`any`/`!`, real type errors), then stop.",
    overlayBlock(
      "Test hypotheses by RUNNING them, never by reasoning them out. Unsure about an edge case, rounding, or ordering (`Math.floor(100/3)`, largest-remainder ties)? `run` a quick `bun -e '…console.log(…)'`, or write a throwaway `scratch/check.ts` importing your impl and `run` it. `scratch/` is yours — the gate ignores it.",
      "verification"
    ),
    gateRulesSentence(conventions),
    "Keep functions small: the gate caps cognitive complexity at 20 and nesting depth at 4. If a function grows long or deeply nested, extract named helpers instead of one sprawling block. Always `await` promises (or `void` them deliberately) — a floating promise is a gate error.",
  ].join("\n");
}

/** Default (house-style) implement-agent prompt — preserved for callers/tests that
 *  don't thread conventions; the dynamic path uses {@link buildSystem}. */
export const SYSTEM = buildSystem(DEFAULT_CONVENTIONS);

/** How the model is driven: an open-ended `chat` assistant, or an autonomous
 *  `drive-to-green` build that implements a task to a passing gate. The build path
 *  (boringstack/greenfield-in-Session) MUST run drive-to-green so the expert-TS
 *  contract is in force from the first token — not the soft chat framing. */
export type ExecutionMode = "chat" | "drive-to-green";

/**
 * The DRIVE-TO-GREEN implement contract for autonomous builds. Same expert-TS
 * constitution as {@link buildSystem} (it reuses {@link gateRulesSentence}, the one
 * source of the hard rules), but build-tuned: inspect the target + one existing
 * sibling that already does the unfamiliar pattern BEFORE writing it (so the model
 * copies the real client/service/hook shape instead of inventing it), and make
 * progress via edits + tiny probes. Gate policy depends on `offerCheck`: WITHOUT it
 * the harness owns the gate (never self-run it via the shell); WITH it (WS-G) the
 * model MUST run the gate mid-turn via the `check` tool, while shell gate commands
 * stay banned. Either way, the old chat-prompt "run tsc/tests" contradiction that
 * made the model burn turns self-linting is resolved.
 */
export function buildDriveToGreenSystem(
  conventions: IConventions,
  offerCheck = false,
  offerConventions = false
): string {
  const lookupLine = flags.webTools()
    ? "When a blocker is a FRAMEWORK's behavior or types (not your own logic) — e.g. why an Elysia route loses its schema types — LOOK IT UP instead of reasoning in circles: `package_docs`/`package_info` read the installed package's own types + README (no network), and `web_search`/`web_fetch` reach its online docs. Two lookups beat ten turns of guessing."
    : "When a blocker is a FRAMEWORK's behavior or types (not your own logic), find a working example in the repo and copy it — don't reason about the framework's internals in the abstract.";

  // With the `check` tool wired (WS-G), the model SHOULD run the gate on demand via
  // that tool — the opposite of the default "don't run the gate yourself". Only the
  // SHELL gate commands stay banned (they waste turns / resolve the wrong tsc). Without
  // check, keep the original guidance (the gate runs automatically after each edit).
  const executionLine = offerCheck
    ? "After every edit the harness runs the gate automatically — AND you can run it yourself any time with the `check` tool, which returns your WHOLE structured error set (`{file,line,rule,message}`) mid-turn. Call `check` before you stop and fix every error it lists in ONE pass, then `check` again; `passed:true` means done. Do NOT run the gate through the SHELL (`tsc`, `eslint`, `knip`, `bun run check`/`validate`) — `check` is the only gate you run; `run` is for tiny diagnostic probes only (`bun -e '…'`)."
    : "After every edit the harness AUTOMATICALLY runs the gate and hands you the errors + fix guidance. Do NOT run `tsc`, `eslint`, `knip`, `bun run check`/`validate`, or the acceptance/gate command yourself — it wastes turns and tells you nothing the harness won't. `run` is for tiny diagnostic probes only (`bun -e '…'`, a single targeted test). Fix exactly what the gate reports, then edit again; the harness ends the task when it reports green.";

  // Keep the inventory line consistent with what's actually advertised — otherwise a
  // weaker model reads "read/edit/create/run" as the COMPLETE toolset and discounts the
  // check / pull_conventions guidance below it.
  const extraTools = [
    offerConventions
      ? "`pull_conventions` (REQUIRED before first create/edit of an untouched path — pull only topics for that path, not the whole catalog; full guides are not in this prompt)"
      : "",
    offerCheck
      ? "`check` (run the gate now, get your whole structured error set)"
      : "",
  ].filter((t) => t.length > 0);
  const toolsLine =
    "Tools: `read` (inspect a file), `edit` (replace an exact, unique snippet), `create` (a new file), `run` (execute a shell command and see its output)" +
    (extraTools.length > 0 ? `, ${extraTools.join(", ")}` : "") +
    ".";

  return [
    "You are an expert TypeScript engineer inside tsforge, a harness specialized for STRICT TypeScript. You are driving ONE task to a GREEN gate — you are not chatting.",
    toolsLine,
    overlayBlock(
      "Before you write an unfamiliar pattern — an API-client call, a service, a hook, a form — `read` ONE existing sibling that already does it and copy its shape. A few targeted reads, never a repo scan. Do NOT invent library or client APIs from memory; the codebase already shows the right way.",
      "bootstrap"
    ),
    lookupLine,
    overlayBlock(executionLine, "execution"),
    "The harness AUTO-FIXES mechanical formatting on every file you write (blank lines, braces, quotes, semicolons, import order, `prefer-template`). NEVER hand-fix or chase those.",
    gateRulesSentence(conventions),
    "Keep functions small: the gate caps cognitive complexity at 20 and nesting depth at 4 — extract named helpers instead of one sprawling block. Always `await` promises (or `void` them deliberately) — a floating promise is a gate error.",
  ].join("\n");
}

export function buildWebResearchGuidance(): string {
  return [
    "WEB RESEARCH — keyless internet/package tools are enabled:",
    "  • Package version/install question? Use `package_info` for npm registry",
    "    dist-tags, versions, deprecations, peer deps, homepage, and repo. It takes",
    "    a LIST — pinning a package.json is ONE call with every dependency in it,",
    "    never one call per package.",
    "  • Package API/docs question? Use `package_docs` first; it reads installed",
    "    node_modules docs/types before falling back to the npm registry README.",
    "  • Unknown public source? Use `web_search`, preferring official hosts with",
    "    `domains` and `recency` (`day`/`month`/`year`) for fast-moving topics.",
    "  • Known static page? Use `web_fetch`. JS-rendered docs/site? Use",
    "    `web_browse`, which opens the URL in local Chromium via Playwright.",
    "  • Do not guess APIs from memory when the user asks for latest/current info.",
  ].join("\n");
}

/**
 * Which copy wins when the same thing appears twice in history.
 *
 * The harness no longer rewrites older messages to mark them superseded — doing
 * that per turn invalidated the server's prefix cache and cost a full cold
 * prefill. Superseded copies are cleaned at compaction instead, so between
 * compactions history can hold more than one version of a file read or a
 * checklist. This states the ordering rule ONCE, in the system block, where it
 * is written at construction and never changes.
 */
export function buildHistoryFreshnessGuidance(): string {
  return [
    "HISTORY FRESHNESS — later always wins:",
    "  • The same file may appear more than once as `¶path#HASH`. The LAST block",
    "    for a path is its current content; earlier ones are stale snapshots from",
    "    before your edits. Never edit against an earlier copy, and do NOT re-read",
    "    a file just because an older copy is still visible.",
    "  • `## Active plan checklist` may appear more than once. Each carries a",
    "    `revision N` — the HIGHEST revision is the live plan; ignore lower ones.",
    "  • Per-write guard notes (`⚠ CHECK`, `⚠ BLAST RADIUS`) on older create/edit",
    "    results describe the file AS IT WAS THEN. The newest gate feedback is the",
    "    live state — fix what it reports, not what an older note reported.",
    "  • Gate feedback may appear more than once. Only the LAST one is the current",
    "    gate result; every earlier list was already acted on. Do not re-fix errors",
    "    from an older copy — if it is not in the newest feedback, it is fixed.",
  ].join("\n");
}

export function buildScriptToolGuidance(): string {
  return [
    "SCRIPT — one program for work where you must READ each file to compute its change:",
    "  • Reach for `script` ONLY when the change to many (≈5+) files DEPENDS on first",
    "    reading each file — e.g. update a call in every file using a value declared in",
    "    that same file. Normally that's a read turn THEN an edit turn (the contents",
    "    flood your context); a script does read→edit per file in ONE loop, one turn,",
    "    and only its `console.log` returns.",
    "  • `import { read, edit, create, run } from './tsforge-tools'` — each stub is",
    "    async and returns the tool's text result. Log a short summary, not the files.",
    "  • Edits/creates MUST go through the `edit`/`create` stubs (NOT `node:fs`/",
    "    `Bun.write`) so they still pass scope + the type/lint gate.",
    "  • Do NOT use it when you can already act in one turn WITHOUT reading first —",
    "    creating several files from the spec, or a single edit. Emitting those tool",
    "    calls directly is simpler and no slower. It cannot call `script` itself.",
  ].join("\n");
}

/** Appended to SYSTEM when TDD mode is on. Drives test-FIRST development: the
 *  model writes a failing test that pins the behavior, runs it to see it fail for
 *  the right reason, THEN implements to green — and adds a test for every logic
 *  module (the gate elevates `test-sibling-required` to an error in this mode, so
 *  a missing test fails the build, not just warns). */
export function buildTddGuidance(conventions: IConventions): string {
  return [
    "TEST-FIRST (TDD) — write the test BEFORE the implementation:",
    "  • For each unit of behavior, first `create` a `*.test.ts` that asserts the",
    "    expected result, then `run` it and SEE IT FAIL for the right reason (the",
    "    function is missing/wrong) — not a typo or import error.",
    "  • Only then write the implementation, and keep editing until that test (and",
    "    the gate) is green. Do NOT write implementation code with no test covering it.",
    "  • Every logic module (`*.service.ts`, `*.utils.ts`, `lib/…`) MUST have",
    `    ${testLayoutPhrase(conventions)} — the gate enforces it as an ERROR in this mode.`,
    "  • Cover the real edge cases you'd expect to break it (empty, zero, boundary,",
    "    error paths), not just the happy path. Tests are part of the deliverable.",
  ].join("\n");
}

/** Default-conventions TDD block (back-compat constant). */
export const TDD_GUIDANCE = buildTddGuidance(DEFAULT_CONVENTIONS);

/** SYSTEM + guidance blocks (web tools, script tool, TDD). */
export function buildSystemPrompt(
  _hasExistingCode: boolean,
  _stack: IStackProfile | undefined,
  conventions: IConventions = DEFAULT_CONVENTIONS
): string {
  const blocks: string[] = [
    buildSystem(conventions),
    buildHistoryFreshnessGuidance(),
  ];

  if (flags.webTools()) {
    blocks.push(buildWebResearchGuidance());
  }

  if (flags.scriptTool()) {
    blocks.push(buildScriptToolGuidance());
  }

  if (flags.tdd()) {
    blocks.push(buildTddGuidance(conventions));
  }

  // The self-harness `extra` block: a free append slot AFTER all built-in
  // guidance (it has no base text, so append and replace are equivalent).
  const extra = activeOverlay()?.promptBlocks.extra;

  if (extra !== undefined) {
    blocks.push(extra.text);
  }

  return blocks.join("\n\n");
}

/**
 * The INTERACTIVE assistant prompt (the CLI's `Session`). Unlike `SYSTEM` — which
 * drives a single task to a gate and is told to "keep going until green" — this
 * frames an open-ended conversation: investigate with tools, then ANSWER or ACT
 * and STOP. Without this framing the model treats every message as implement-to-
 * green and scans the repo forever when asked a question (there's no gate to hit).
 */
export function buildChatSystem(conventions: IConventions): string {
  const naming = interfaceNamingPhrase(conventions);
  const namingPart = naming === null ? "" : `${naming}; `;
  const lines = [
    "You are tsforge, a capable agent running on the user's own machine. You help with whatever they ask — research, browsing and reading the web, gathering and writing up findings, answering questions, and writing code (where you are an expert in strict TypeScript). NOT every request is about code, and NOT every request is about the folder you were launched in. There is no build gate to satisfy unless the work is code: when the task is research or writing, the deliverable is the answer or the notes, not a program.",
    "Tools: `read` (inspect a file), `run` (execute any shell command), `edit` (replace an exact, unique snippet), `create` (a new file) — plus any research tools listed below.",
    "File paths are RELATIVE to the workspace root: use `tsconfig.json` or `src/app.ts` — never an absolute path, and never repeat the workspace folder in the path.",
    "MATCH EFFORT TO THE REQUEST. A self-contained ask — 'write a `double` function', 'explain `satisfies`' — has nothing to do with the surrounding repo: just answer it directly (reply with the code; only `create` a file if asked). Do NOT read or scan the repository for these. Investigate the codebase ONLY when the request is actually about THIS project (a bug here, a change here, 'what would you change?').",
    "ASK BEFORE GUESSING when the request is genuinely ambiguous — unclear scope, unclear which file to touch, or unclear whether it even relates to this repo (e.g. 'add a retry' with no target). Ask ONE short clarifying question and stop; the user will answer and you continue. But don't over-ask: when a sensible default is obvious, take it and state the assumption in one line.",
    "Be decisive, not exhaustive. When you do investigate, a few targeted reads beat reading everything — as soon as you can answer or act, STOP calling tools and reply.",
    "For a QUESTION about the repo, investigate briefly then give a concise, concrete answer (cite specific files/symbols; offer your top few recommendations, not a survey). For a CODE CHANGE, make it with `edit`/`create`, verify by `run`ning the project's tests or `tsc`, then briefly state what you did. For RESEARCH, keep going until the brief is covered, save findings as you go, and report what you found with sources — never write code just to have produced code.",
    `When you write code, use strict TypeScript: ${namingPart}\`===\`; no \`var\`; never the non-null \`!\` (guard index access: \`const x = arr[i]; if (x === undefined) {…}\`); no \`any\`/\`as\` (type parameters); explicit boolean conditions.`,
  ];

  if (flags.webTools()) {
    lines.push(
      "Web tools are enabled: use `package_info` for latest npm metadata, `package_docs` for package APIs, `web_search` to discover current sources, `web_fetch` for static pages, and `web_browse` for JS-rendered pages. Prefer official sources; use `domains`, `recency`, and `maxResults` when searching."
    );
  }

  if (flags.scriptTool()) {
    lines.push(
      "The `script` tool is enabled: for repetitive multi-step tool work (scan many files, fetch+compare several packages, transform-then-write), write ONE TypeScript program importing stubs from `./tsforge-tools` instead of many tool turns; route file changes through the `edit`/`create` stubs."
    );
  }

  return lines.join("\n");
}

/** Default-conventions interactive prompt (back-compat constant). */
export const CHAT_SYSTEM = buildChatSystem(DEFAULT_CONVENTIONS);

/** Prompt for `/compact`: condense a long conversation, keeping what matters for
 *  continuing the work — not a chatty recap. */
export const COMPACT_SYSTEM = [
  "You are compacting a coding session to save context. Summarize the conversation below into a concise brief that lets the assistant CONTINUE seamlessly.",
  "Preserve: the user's goals/requests, decisions made, files created or changed (with their purpose), key facts learned about the codebase, and any OPEN threads or next steps.",
  "Drop: small talk, redundant tool output, and anything already superseded. Use terse bullet points. Do not invent anything not in the transcript.",
].join("\n");

/** Build stack-aware guidance from an IStackProfile. Includes the stack name
 *  and guidance strings from active packs (skipping empty/always-on packs). */
export function buildStackGuidance(profile: IStackProfile): string {
  const lines: string[] = [];

  lines.push(`## Project stack & conventions`);
  lines.push(`Stack: **${profile.name}** (${profile.reason})`);

  for (const packId of profile.packs) {
    // Find the descriptor by ID from the registry
    const descriptor = Object.values(PACK_REGISTRY).find(
      (d) => d.id === packId
    );

    // Add guidance if present and non-empty
    if (descriptor?.guidance !== undefined) {
      lines.push(`- ${descriptor.guidance}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

/** Build the first user message: the task contract + editable/context files
 *  (full dumps when small, a navigable MAP when large — see renderFileSection). */
export function seedPrompt(
  task: ITask,
  editable: IFileView[],
  context: IFileView[],
  stack?: IStackProfile,
  scout?: string
): string {
  const intent =
    task.intent !== undefined && task.intent.length > 0
      ? `Spec contract — implement EXACTLY this:\n${task.intent}`
      : "";

  const ed = renderFileSection(editable);
  const editableText =
    editable.length === 0
      ? "(none of the editable files exist yet — create them)"
      : ed.mapped
        ? `The editable files are large — here is a MAP (path · lines · exports). INSPECT specifics with read/search/symbol_search/find_references before editing; don't guess:\n${ed.text}`
        : ed.text;

  const ctx = context.length > 0 ? renderFileSection(context) : null;
  const contextText =
    ctx === null
      ? ""
      : `Read-only context (do NOT edit)${ctx.mapped ? " — MAP; read specifics on demand" : ""}:\n${ctx.text}`;

  const stackText = stack !== undefined ? buildStackGuidance(stack) : "";
  const scoutText = scout !== undefined && scout.length > 0 ? scout : "";

  return [
    `Task ${task.id}.`,
    intent,
    stackText,
    scoutText,
    `Acceptance command (run this to verify — it must exit 0): ${summarizeGateCommand(task.accept)}`,
    `Editable files: ${task.files.join(", ")}`,
    `Current editable contents:\n${editableText}`,
    contextText,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}
