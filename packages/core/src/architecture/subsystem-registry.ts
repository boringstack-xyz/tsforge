import type { ISubsystemEntry } from "./architecture.types";
import { ROOT_ID } from "./dependency-analyzer";

/**
 * What each subsystem is for, and whether an ordinary build touches it.
 *
 * Hand-maintained on purpose: a file count is derivable, a PURPOSE is not. The
 * registry is drift-checked against the filesystem (see `validateRegistry`), so it
 * cannot quietly fall behind the way a prose layout table does — a new directory
 * fails the build until someone says what it is.
 *
 * Keep each purpose to one line, present tense, no trailing period.
 */
export const SUBSYSTEM_REGISTRY: Readonly<Record<string, ISubsystemEntry>> = {
  [ROOT_ID]: {
    purpose:
      "CLI entry, model registry, session persistence — the loose files in src/",
    tier: "core",
  },
  agent: {
    purpose:
      "Tool schemas, the model-as-agent wrapper, and the malformed-tool-call repair ladder",
    tier: "core",
  },
  architecture: {
    purpose:
      "Derives this map from source so the docs cannot drift from the code",
    tier: "optional",
  },
  browser: {
    purpose:
      "Headless Chromium oracle that render-checks a page as a gate stage",
    tier: "optional",
  },
  "chrome-bridge": {
    purpose:
      "Localhost WebSocket bridge to the tsforge Chrome extension — read-only research in the user's browser",
    tier: "optional",
  },
  cli: {
    purpose: "Argument parsing, the interactive REPL, and per-mode wiring",
    tier: "core",
  },
  codebase: {
    purpose:
      "Structural workspace map and hub ranking used to seed prompt context",
    tier: "core",
  },
  config: {
    purpose:
      "tsforge.config.json, profiles, recipes, agent specs, and external plugins",
    tier: "core",
  },
  constitution: {
    purpose: "Baseline system-role text and the reference ESLint constitution",
    tier: "optional",
  },
  editor: {
    purpose: "The terminal input-line editor behind the REPL prompt",
    tier: "core",
  },
  eval: {
    purpose: "Run scoring, failure classification, and the quality judge",
    tier: "optional",
  },
  files: {
    purpose: "Reading, creating, and hash-anchored editing of workspace files",
    tier: "core",
  },
  gate: {
    purpose:
      "Composes and runs the deterministic gate: linter, stages, tool paths",
    tier: "core",
  },
  "infer-rules": {
    purpose:
      "Scans a repo for its conventions and turns them into rule overrides",
    tier: "core",
  },
  inference: {
    purpose:
      "OpenAI-compatible provider: streaming, tool calls, reasoning, token usage",
    tier: "core",
  },
  lib: {
    purpose:
      "Shared primitives — fs, json, guards, scope globs, SSRF checks, clipboard",
    tier: "core",
  },
  loop: {
    purpose:
      "The drive-to-green engine: turns, tools, gate settling, steering, adapters",
    tier: "core",
  },
  lsp: {
    purpose:
      "TypeScript language service powering navigation and write-time diagnostics",
    tier: "optional",
  },
  mcp: {
    purpose:
      "Model Context Protocol client that exposes external servers as tools",
    tier: "optional",
  },
  "meta-rules": {
    purpose:
      "Gate rules that need no AST — config shape, CI wiring, supply chain",
    tier: "core",
  },
  policy: {
    purpose:
      "Decides which actions are allowed in the current mode before they run",
    tier: "core",
  },
  proptest: {
    purpose: "Derives property-based test inputs from TypeScript types",
    tier: "optional",
  },
  render: {
    purpose:
      "Terminal UI — status bar, menus, wizards, markdown, diffs, spinners",
    tier: "core",
  },
  reviewers: {
    purpose:
      "Independent review panel that grades a change before it is trusted",
    tier: "optional",
  },
  "rule-packs": {
    purpose: "The ESLint rule packs the gate enforces, grouped by stack",
    tier: "core",
  },
  scaffold: {
    purpose:
      "Stands up a new project from an archetype and configures its gate",
    tier: "optional",
  },
  "self-harness": {
    purpose:
      "Lets the harness propose, trial, and keep edits to its own prompts and rules",
    tier: "optional",
  },
  setup: {
    purpose: "Onboarding wizard that writes a project's initial tsforge config",
    tier: "optional",
  },
  "site-plugins": {
    purpose:
      "Built-in site experts (Reddit…) that read a site's structured data through the Chrome bridge",
    tier: "optional",
  },
  spec: {
    purpose:
      "Task and spec shapes, spec parsing, and test generation from intent",
    tier: "core",
  },
  "stack-detection": {
    purpose: "Detects the project's stack and picks which rule packs apply",
    tier: "core",
  },
  validate: {
    purpose:
      "Runs the gate command and parses tool output into structured errors",
    tier: "core",
  },
};

/**
 * The registry entry for a subsystem, or a throw naming what is missing.
 *
 * `validateRegistry` has already guaranteed the entry exists by the time callers reach
 * here; this restates the invariant for the type system without reaching for a
 * non-null assertion, and gives a useful message if the two ever get out of order.
 */
export function entryFor(id: string): ISubsystemEntry {
  const entry = SUBSYSTEM_REGISTRY[id];

  if (entry === undefined) {
    throw new Error(
      `architecture: no registry entry for "${id}" — validate before use`
    );
  }

  return entry;
}

/**
 * Fail when the registry and the filesystem disagree.
 *
 * This is what keeps the hand-written half honest. Without it the registry rots
 * exactly like the layout table it replaces: a subsystem gets added and never
 * described, or gets deleted and lingers in the docs for months.
 */
export function validateRegistry(actualIds: readonly string[]): void {
  const known = new Set(Object.keys(SUBSYSTEM_REGISTRY));
  const actual = new Set(actualIds);

  const undocumented = [...actual].filter((id) => !known.has(id)).sort();
  const stale = [...known].filter((id) => !actual.has(id)).sort();

  if (undocumented.length === 0 && stale.length === 0) {
    return;
  }

  const parts: string[] = [];

  if (undocumented.length > 0) {
    parts.push(
      `not in the registry: ${undocumented.join(", ")} — add an entry in ` +
        `src/architecture/subsystem-registry.ts saying what it is`
    );
  }

  if (stale.length > 0) {
    parts.push(
      `in the registry but gone from src/: ${stale.join(", ")} — remove the entry`
    );
  }

  throw new Error(`architecture: registry drift — ${parts.join("; ")}`);
}
