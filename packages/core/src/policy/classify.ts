import { TOOL_NAME, fileArgCandidates } from "../agent";
import type { IToolCall } from "../inference";
import { normalizeWorkspacePath } from "../lib/scope";
import type { ActionKind, IProposedAction } from "./policy.types";

/** Tool name → what it actually does. Tools absent here (or any future/forged
 *  name) classify as `unknown`, which the policy never silently allows. MCP
 *  tools (`mcp__*`) are handled separately. */
const KIND_BY_TOOL: Readonly<Record<string, ActionKind>> = {
  [TOOL_NAME.read]: "read_file",
  [TOOL_NAME.search]: "read_file",
  [TOOL_NAME.symbolSearch]: "read_file",
  [TOOL_NAME.findReferences]: "read_file",
  [TOOL_NAME.typeAt]: "read_file",
  [TOOL_NAME.goToDefinition]: "read_file",
  [TOOL_NAME.impact]: "read_file",
  [TOOL_NAME.symbolContext]: "read_file",
  [TOOL_NAME.diagnostics]: "read_file",
  [TOOL_NAME.gitContext]: "read_file",
  // git/GitHub first-class tools. Reads (git_context above, github_read) → vcs_read
  // (allowed in every mode incl. plan). Writes (git_write, github_write) → vcs_write
  // (allowed in default/acceptEdits, denied in plan/ci/dontAsk = capability-as-consent).
  // Absent here → `unknown` → denied everywhere (the silent-deny DOA class).
  [TOOL_NAME.githubRead]: "vcs_read",
  [TOOL_NAME.gitWrite]: "vcs_write",
  [TOOL_NAME.githubWrite]: "vcs_write",
  // Curated Linear verbs over MCP. Read → integration_read (plan-safe); write →
  // integration_write (capability-as-consent, denied plan/ci/dontAsk). linear_start
  // reads the card BUT then does a git checkout, so it's a vcs_write (a working-tree
  // mutation withheld while planning), not a tracker write. Absent here → `unknown`
  // → silent deny (the same DOA class the github tools guard against).
  [TOOL_NAME.linearRead]: "integration_read",
  [TOOL_NAME.linearWrite]: "integration_write",
  [TOOL_NAME.linearStart]: "vcs_write",
  // Notion + Sentry share the integration kinds: reads plan-safe, writes gated.
  [TOOL_NAME.notionRead]: "integration_read",
  [TOOL_NAME.notionWrite]: "integration_write",
  [TOOL_NAME.sentryRead]: "integration_read",
  [TOOL_NAME.sentryWrite]: "integration_write",
  [TOOL_NAME.edit]: "edit_file",
  [TOOL_NAME.editLines]: "edit_file",
  [TOOL_NAME.organizeImports]: "edit_file",
  [TOOL_NAME.renameSymbol]: "edit_file",
  [TOOL_NAME.create]: "write_file",
  [TOOL_NAME.moveFile]: "write_file",
  [TOOL_NAME.run]: "shell",
  [TOOL_NAME.addDependency]: "shell",
  // `script` runs a program that can call other tools — classify as shell so the
  // policy treats it like `run` (its stub calls are each re-classified on dispatch).
  [TOOL_NAME.script]: "shell",
  // `check` (WS-G) runs the FROZEN gate command and ignores its args entirely
  // (doCheck takes `_args`), so it has ZERO model-chosen input — classifying it
  // `shell` conflated "spawns a process" with "model wrote the command line" and
  // got it DENIED in ci/dontAsk (and ask→deny in non-interactive acceptEdits),
  // killing every check call in exactly the unattended runs that need it. It is a
  // `harness_tool`: allowed everywhere except plan, where executeTool's
  // non-read-only hard guard still blocks it.
  [TOOL_NAME.check]: "harness_tool",
  // `ask_user` (WS-C1) asks the human a question and mutates nothing → zero-risk,
  // classified `read_file` so it's allowed in every mode (incl. plan). Absent here it
  // would classify `unknown` → deny before the handler runs (the check/script DOA class).
  [TOOL_NAME.askUser]: "read_file",
  // Checklist tools mutate only `.tsforge/worklist/plans/*.json` (not source). List is a
  // pure read; focus/complete/uncomplete classify like a low-risk edit so default mode
  // allows them. Absent here → `unknown` → deny (same DOA class as ask_user/check).
  [TOOL_NAME.taskList]: "read_file",
  [TOOL_NAME.taskFocus]: "edit_file",
  [TOOL_NAME.taskComplete]: "edit_file",
  [TOOL_NAME.taskUncomplete]: "edit_file",
  [TOOL_NAME.taskAdd]: "edit_file",
  [TOOL_NAME.taskUpdate]: "edit_file",
  [TOOL_NAME.presentPlan]: "read_file",
  // Same posture as present_plan: mutates nothing until the human approves →
  // zero-risk, allowed in every mode incl. plan. Absent here it would classify
  // `unknown` → silently denied before the handler runs (the same DOA class
  // ask_user/check/present_plan/pull_conventions guard against above).
  [TOOL_NAME.productPlan]: "read_file",
  // `pull_conventions` is a pure read-only lookup of the injected convention library — it mutates
  // nothing, so it classifies `read_file` (allowed in every mode). Absent here it classified
  // `unknown` → deny before the handler ran, so a model's pull was silently denied in non-interactive
  // builds (the same check/ask_user DOA class).
  [TOOL_NAME.pullConventions]: "read_file",
  // Delegating to a read-only subagent — its own class so a repo can deny/ask it
  // specifically; the child's tool calls are re-classified as they dispatch.
  [TOOL_NAME.spawnAgent]: "spawn_agent",
  // The `delete_file` ActionKind predates this tool; it is finally emitted.
  [TOOL_NAME.deleteFile]: "delete_file",
  [TOOL_NAME.packageInfo]: "network",
  [TOOL_NAME.packageDocs]: "network",
  [TOOL_NAME.webFetch]: "network",
  [TOOL_NAME.webSearch]: "network",
  [TOOL_NAME.webBrowse]: "network",
  // Chrome research bridge: egress through the user's browser → `network` (so a
  // repo/mode can deny it like the web tools; allowed in plan, it can't mutate
  // the workspace). Absent here → `unknown` → silent deny (the DOA class).
  [TOOL_NAME.browserTabs]: "network",
  [TOOL_NAME.browserAdopt]: "network",
  [TOOL_NAME.browserOpen]: "network",
  [TOOL_NAME.browserNavigate]: "network",
  [TOOL_NAME.browserRead]: "network",
  [TOOL_NAME.browserClick]: "network",
  [TOOL_NAME.browserScroll]: "network",
  [TOOL_NAME.browserScreenshot]: "network",
  [TOOL_NAME.browserClose]: "network",
  // `note` appends to notes/<topic>.md — a low-risk file write: allowed wherever
  // edits are, denied in plan mode.
  [TOOL_NAME.note]: "edit_file",
  // Both call an external capability endpoint → network egress is the salient
  // risk (so a repo/mode can deny/ask them like the web tools).
  [TOOL_NAME.readImage]: "network",
  [TOOL_NAME.generateImage]: "network",
};

/** Extra path-bearing arg keys beyond the file aliases (move's source/target). */
const MOVE_PATH_KEYS: readonly string[] = ["from", "to"];

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];

  return typeof v === "string" ? v : "";
}

/** Workspace-relative, normalized, deduped paths the action touches. Sourced
 *  from `fileArgCandidates` — the SAME file-alias set + coercions the handlers
 *  resolve — plus move's `from`/`to`, so a private-key/scope deny can't be
 *  dodged by naming the file `path`/`filename`/… instead of `file`. */
function extractPaths(
  args: Record<string, unknown>,
  cwd: string
): readonly string[] {
  const raw = [...fileArgCandidates(args)];

  for (const key of MOVE_PATH_KEYS) {
    const value = str(args, key);

    if (value.length > 0) {
      raw.push(value);
    }
  }

  const out: string[] = [];

  for (const value of raw) {
    const norm = normalizeWorkspacePath(cwd, value);

    if (!out.includes(norm)) {
      out.push(norm);
    }
  }

  return out;
}

/** A command preview for shell actions (the literal `run` command, or the
 *  `bun add …` line `add_dependency` would build). Undefined for non-shell. */
function extractCommand(
  toolName: string,
  args: Record<string, unknown>
): string | undefined {
  if (toolName === TOOL_NAME.run) {
    return str(args, "command");
  }

  if (toolName === TOOL_NAME.addDependency) {
    return `bun add ${str(args, "packages")}`.trim();
  }

  // `script` runs the model's `code` verbatim — surface the body AS the command
  // so the critical denies (destructive-shell, pipe-to-shell, private-key) at
  // least scan it. Before this, `script` had no `command`, so EVERY
  // command-gated critical was structurally skipped: the body could `rm -rf`
  // outside cwd or read `~/.ssh/id_rsa` with the policy never looking. The scan
  // is best-effort (a JS body's `rmSync` isn't a shell `rm`); the env filter in
  // script-tool.ts is the load-bearing protection.
  if (toolName === TOOL_NAME.script) {
    return str(args, "code");
  }

  return undefined;
}

/**
 * Reduce a tool call to an `IProposedAction` the policy can evaluate. Reuses the
 * existing `normalizeWorkspacePath` so policy sees the same path form the write
 * guards do. Unknown/forged names → `kind:"unknown"`; `mcp__<server>__<tool>` →
 * `mcp_tool` with the parsed server.
 */
export function classifyAction(call: IToolCall, cwd: string): IProposedAction {
  const args = call.arguments;

  if (call.name.startsWith("mcp__")) {
    return {
      kind: "mcp_tool",
      toolName: call.name,
      input: args,
      cwd,
      mcpServer: call.name.split("__")[1] ?? "",
    };
  }

  const kind = KIND_BY_TOOL[call.name] ?? "unknown";
  const paths = extractPaths(args, cwd);
  const command = extractCommand(call.name, args);

  const action: IProposedAction = {
    kind,
    toolName: call.name,
    input: args,
    cwd,
  };

  if (paths.length > 0) {
    action.paths = paths;
  }

  if (command !== undefined) {
    action.command = command;
  }

  // Mark the `script` body so the policy scans it with CODE-native critical
  // patterns (rmSync/child_process/credential reads), not just shell shapes.
  if (call.name === TOOL_NAME.script) {
    action.metadata = { codeExec: true };
  }

  return action;
}
