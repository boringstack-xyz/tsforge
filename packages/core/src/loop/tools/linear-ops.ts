import { flags } from "../../config";
import { runArgvCommand } from "../../lib/fs";
import { str, reject, type IToolContext } from "./tool-context";
import { unsafe, intArg, capHead, pick, type VcsRunner } from "./vcs-common";
import {
  asList,
  callFirst,
  field,
  isRecord,
  jsonParseSafe,
  lintHumanText,
  resolveMcpCapability,
  type IIntegrationRegistry,
} from "./integration-common";
import { mcpToolName } from "../../mcp";
import { LOOP_LIMITS } from "../loop.constants";

/** The required config key for the Linear MCP server. The curated verbs address
 *  its tools as `mcp__linear__<tool>`, so the server MUST be keyed exactly
 *  `linear` in tsforge.config.json `mcpServers`. */
export const LINEAR_SERVER = "linear";

const CAPABILITY_OFF =
  "the Linear capability is off — add a `linear` MCP server to tsforge.config.json " +
  "`mcpServers` (and ensure TSFORGE_NO_LINEAR is unset).";

export interface ILinearDeps {
  registry: IIntegrationRegistry | undefined;
  run: VcsRunner;
}

/** Resolve the `linear` capability = consent (a `linear` MCP server connected, the
 *  kill-switch unset). Never throws. */
export function resolveLinearCapability(
  registry: { serverNames(): string[] } | null | undefined
): boolean {
  return resolveMcpCapability(registry, LINEAR_SERVER, flags.noLinear());
}

/** The git branch Linear generated for an issue payload, across field-name variants. */
function branchOf(rec: Record<string, unknown>): string {
  return field(rec, "branchName", "gitBranchName", "branch");
}

/** Compact, human-facing summary of one issue payload (never the raw MCP dump). */
function summarizeIssue(rec: Record<string, unknown>): string {
  const id = field(rec, "identifier", "id");
  const title = field(rec, "title", "name");
  const state = field(rec, "state", "status");
  const branch = branchOf(rec);
  const url = field(rec, "url");
  const description = field(rec, "description", "body");
  const lines = [`${id} ${title}`.trim()];

  if (state.length > 0) {
    lines.push(`state: ${state}`);
  }

  if (branch.length > 0) {
    lines.push(`branch: ${branch}  (linear_start ${id} checks it out)`);
  }

  if (url.length > 0) {
    lines.push(url);
  }

  if (description.length > 0) {
    lines.push("", description);
  }

  return lines.join("\n");
}

/** Pull an issue record out of an MCP payload that may be the object itself, a
 *  {text: json} wrapper, or a list whose first element is the issue. */
function issueRecord(raw: string): Record<string, unknown> | null {
  const parsed = jsonParseSafe(raw);

  if (isRecord(parsed)) {
    if (typeof parsed.text === "string") {
      const inner = jsonParseSafe(parsed.text);

      return isRecord(inner) ? inner : null;
    }

    return parsed;
  }

  if (Array.isArray(parsed) && isRecord(parsed[0])) {
    return parsed[0];
  }

  return null;
}

// ── reads ──────────────────────────────────────────────────────────────────

async function readIssue(
  reg: IIntegrationRegistry,
  id: string,
  max: number
): Promise<string> {
  const res = await callFirst(reg, LINEAR_SERVER, ["get_issue"], { id });

  if ("error" in res) {
    return res.error;
  }

  const rec = issueRecord(res.text);

  return capHead(rec === null ? res.text : summarizeIssue(rec), max);
}

async function readList(
  reg: IIntegrationRegistry,
  candidates: readonly string[],
  args: Record<string, unknown>,
  max: number
): Promise<string> {
  const res = await callFirst(reg, LINEAR_SERVER, candidates, args);

  if ("error" in res) {
    return res.error;
  }

  const parsed = jsonParseSafe(res.text);

  if (!Array.isArray(parsed) && !isRecord(parsed)) {
    return capHead(res.text, max);
  }

  const rows = asList(parsed)
    .filter(isRecord)
    .map((r) => {
      const id = field(r, "identifier", "id");
      const title = field(r, "title", "name");
      const state = field(r, "state", "status");

      return `${id} ${title}${state.length > 0 ? ` [${state}]` : ""}`.trim();
    })
    .filter((line) => line.length > 0);

  return rows.length > 0 ? capHead(rows.join("\n"), max) : "no matching issues";
}

// ── writes ─────────────────────────────────────────────────────────────────

async function createIssue(
  reg: IIntegrationRegistry,
  args: Record<string, unknown>
): Promise<string> {
  const title = str(args, "title");
  const description = str(args, "description");
  const team = str(args, "team");
  const titleLint = lintHumanText(title);

  if (titleLint !== null) {
    return `linear_write create: title ${titleLint}`;
  }

  if (description.length > 0) {
    const descLint = lintHumanText(description);

    if (descLint !== null) {
      return `linear_write create: description ${descLint}`;
    }
  }

  if (team.trim().length === 0) {
    return "linear_write create: needs a `team` (its key, name or ID, e.g. ENG)";
  }

  // Only keys the Linear MCP declares: it validates strictly, so any extra key
  // (e.g. `teamId`) fails the whole call with "Unrecognized key".
  const payload: Record<string, unknown> = { title, team };

  if (description.length > 0) {
    payload.description = description;
  }

  const res = await callFirst(
    reg,
    LINEAR_SERVER,
    ["create_issue", "save_issue"],
    payload
  );

  if ("error" in res) {
    return res.error;
  }

  const rec = issueRecord(res.text);

  if (rec === null) {
    return res.text;
  }

  const id = field(rec, "identifier", "id");
  const branch = branchOf(rec);

  return branch.length > 0
    ? `created ${id} — branch ${branch} (linear_start ${id} to begin)`
    : `created ${id}`;
}

async function commentIssue(
  reg: IIntegrationRegistry,
  args: Record<string, unknown>
): Promise<string> {
  const id = str(args, "id");
  const body = str(args, "body");

  if (id.trim().length === 0) {
    return "linear_write comment: needs an issue `id`";
  }

  const bodyLint = lintHumanText(body);

  if (bodyLint !== null) {
    return `linear_write comment: ${bodyLint}`;
  }

  const res = await callFirst(
    reg,
    LINEAR_SERVER,
    ["create_comment", "save_comment"],
    // Never `id` here: on save_comment it names a comment to edit.
    { issueId: id, body }
  );

  return "error" in res ? res.error : `commented on ${id}`;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Read-only Linear inspection via curated verbs over the Linear MCP server. No
 * `ctx.linear` guard — reads are policy-allowed in every mode (integration_read);
 * if the capability is off the tool simply isn't advertised. Never throws.
 */
export async function doLinearRead(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ILinearDeps = { registry: ctx.mcpRegistry, run: runArgvCommand }
): Promise<string> {
  const reg = deps.registry;

  if (reg === undefined) {
    return reject(ctx, "linear_read", CAPABILITY_OFF);
  }

  const op = str(args, "op");
  const id = str(args, "id");
  const max = intArg(args, "maxChars") ?? LOOP_LIMITS.maxToolOutputChars;

  ctx.report({ kind: "tool", task: ctx.task, message: `linear_read ${op}` });

  switch (op) {
    case "issue":
      return id.trim().length === 0
        ? reject(ctx, "linear_read", "issue: needs an `id` (e.g. ENG-123)")
        : readIssue(reg, id, max);
    case "search":
      return readList(reg, ["list_issues"], { query: str(args, "query") }, max);
    case "mine":
      return reg.has(mcpToolName(LINEAR_SERVER, "list_my_issues"))
        ? readList(reg, ["list_my_issues"], {}, max)
        : readList(reg, ["list_issues"], { assignee: "me" }, max);
    case "comments":
      return id.trim().length === 0
        ? reject(ctx, "linear_read", "comments: needs an issue `id`")
        : readList(reg, ["list_comments"], { issueId: id }, max);
    default:
      return reject(
        ctx,
        "linear_read",
        `unknown op '${op}' (use issue|search|mine|comments)`
      );
  }
}

/**
 * Linear WRITE via curated verbs over MCP — create / comment. Gated by the `linear`
 * capability (consent) AND the integration_write policy kind. Fails closed when the
 * capability is off, even on a salvaged/forced call. Never throws.
 */
export async function doLinearWrite(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ILinearDeps = { registry: ctx.mcpRegistry, run: runArgvCommand }
): Promise<string> {
  if (ctx.linear !== true || deps.registry === undefined) {
    return reject(ctx, "linear_write", CAPABILITY_OFF);
  }

  const op = str(args, "op");

  ctx.report({ kind: "tool", task: ctx.task, message: `linear_write ${op}` });

  switch (op) {
    case "create":
      return createIssue(deps.registry, args);
    case "comment":
      return commentIssue(deps.registry, args);
    default:
      return reject(
        ctx,
        "linear_write",
        `unknown op '${op}' (use create|comment)`
      );
  }
}

/**
 * One-shot start-work: read a Linear card and check out the git branch Linear made
 * for it (created from the current branch if absent). Gated by the `linear`
 * capability; classified vcs_write (it mutates the working tree). Never throws.
 */
export async function doLinearStart(
  args: Record<string, unknown>,
  ctx: IToolContext,
  deps: ILinearDeps = { registry: ctx.mcpRegistry, run: runArgvCommand }
): Promise<string> {
  if (ctx.linear !== true || deps.registry === undefined) {
    return reject(ctx, "linear_start", CAPABILITY_OFF);
  }

  const id = str(args, "id");

  if (id.trim().length === 0) {
    return reject(ctx, "linear_start", "needs an issue `id` (e.g. ENG-123)");
  }

  ctx.report({ kind: "tool", task: ctx.task, message: `linear_start ${id}` });

  const res = await callFirst(deps.registry, LINEAR_SERVER, ["get_issue"], {
    id,
  });

  if ("error" in res) {
    return res.error;
  }

  const rec = issueRecord(res.text);
  const branch = rec === null ? "" : branchOf(rec);

  if (branch.length === 0) {
    return `linear_start: ${id} has no branch name from Linear — create the branch yourself with git_write`;
  }

  if (unsafe(branch)) {
    return reject(ctx, "linear_start", `unsafe branch name '${branch}'`);
  }

  const signalOpt = ctx.signal === undefined ? {} : { signal: ctx.signal };
  // Switch to the branch; if it doesn't exist yet, create it from HEAD.
  let sw = await deps.run(ctx.cwd, ["git", "switch", branch], signalOpt);

  if (sw.exitCode === 127) {
    return "linear_start: git is not installed or not on PATH";
  }

  if (sw.exitCode !== 0) {
    sw = await deps.run(ctx.cwd, ["git", "switch", "-c", branch], signalOpt);
  }

  if (sw.exitCode !== 0) {
    return `linear_start: could not check out '${branch}':\n${pick(sw.stderr, sw.stdout).slice(0, 400)}`;
  }

  const title = rec === null ? "" : field(rec, "title", "name");

  return `on branch ${branch} for ${id}${title.length > 0 ? ` — ${title}` : ""}. Open a PR referencing ${id} when done; Linear moves the card automatically.`;
}
