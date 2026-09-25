/**
 * The single source of truth for the REPL's slash commands — drives BOTH the
 * `/help` text and the interactive `/` palette, so they can never drift and the
 * user never has to memorize what exists. The executor stays the `command()`
 * switch in cli/repl.ts; `COMMAND_VERBS` lets a test assert the two stay in sync.
 */
export interface ICommandSpec {
  /** Full token incl. leading slash, e.g. "/gate". */
  readonly name: string;
  /** Argument hint shown after the name (e.g. "<cmd>", "[name]"); omitted if none. */
  readonly arg?: string;
  /** One-line description. */
  readonly summary: string;
}

export const COMMANDS: readonly ICommandSpec[] = [
  { name: "/help", summary: "show this help" },
  {
    name: "/scaffold",
    summary:
      "create a new project here (BoringStack / Astro / Phaser) via the wizard",
  },
  {
    name: "/compact",
    summary: "summarize the conversation to free up context",
  },
  {
    name: "/clear",
    summary: "reset the conversation (keeps the workspace + gate)",
  },
  {
    name: "/plan",
    summary:
      "toggle plan mode (on by default: explore → checklist → approve saves + implements)",
  },
  {
    name: "/copy",
    summary:
      "leave the pane TUI (if active) and dump the transcript for selection",
  },
  {
    name: "/gate",
    arg: "<cmd>",
    summary: "set the gate command (empty to clear)",
  },
  {
    name: "/files",
    arg: "<globs>",
    summary: "set the editable scope (comma-separated; empty = all)",
  },
  {
    name: "/review",
    arg: "[base]",
    summary: "review the current change (logic, regressions, edge cases)",
  },
  {
    name: "/reviewfix",
    summary: "have the agent address the last post-work review's findings",
  },
  {
    name: "/map",
    arg: "[status|forget]",
    summary: "build a structural map of the repo to prime the agent",
  },
  {
    name: "/trace",
    arg: "[logfile]",
    summary: "summarize a --log run (calls, policy, gate, turns-to-green)",
  },
  {
    name: "/model",
    arg: "[name]",
    summary: "list configured models (★ active), or switch to <name>",
  },
  { name: "/sessions", summary: "list saved sessions" },
  { name: "/cost", summary: "rough conversation size (messages + ~tokens)" },
  {
    name: "/metrics",
    summary: "token totals + generation rate (tok/s) this session",
  },
  {
    name: "/memory",
    arg: "[forget]",
    summary: "show coding lessons + project decisions (forget to clear)",
  },
  {
    name: "/remember",
    arg: "<decision>",
    summary: "retain a product/architecture decision to the memory bank",
  },
  {
    name: "/config",
    summary: "settings hub: model, mode, gate, tools",
  },
  {
    name: "/browser",
    summary: "Chrome research bridge: status + how to pair the extension",
  },
  {
    name: "/setup",
    summary: "infer + write project conventions (the setup wizard)",
  },
  { name: "/exit", summary: "leave the session" },
] as const;

/** True when the spec takes an argument — the palette prefills `"<name> "` and
 *  lets the user type instead of running immediately. */
export function takesArg(spec: ICommandSpec): boolean {
  return spec.arg !== undefined;
}

/** Command verbs (no slash) that MUST have an executor case, incl. the `/quit`
 *  alias that isn't listed in the palette. Used by the registry↔switch parity test. */
export const COMMAND_VERBS: readonly string[] = [
  ...COMMANDS.map((c) => c.name.slice(1)),
  "quit",
];

/** The `/help` body — the command table (from the registry) plus the footer. */
export function formatHelp(): string {
  const width = Math.max(
    ...COMMANDS.map(
      (c) => c.name.length + (c.arg === undefined ? 0 : c.arg.length + 1)
    )
  );
  const rows = COMMANDS.map((c) => {
    const left = c.arg === undefined ? c.name : `${c.name} ${c.arg}`;

    return `  ${left.padEnd(width)}   ${c.summary}`;
  });

  return [
    "Commands:",
    ...rows,
    "  /quit              alias for /exit",
    "",
    "Press / for an interactive menu (↑/↓ to select, type to filter, Enter to run).",
    "Anything else is sent to the agent. It works with its tools; when it stops,",
    'the gate (if set) confirms "done".',
    "While it's working: type a message to STEER the next turn (e.g. 'use Tailwind');",
    "Ctrl-C interrupts the current run.",
  ].join("\n");
}
