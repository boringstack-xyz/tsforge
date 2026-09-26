/**
 * `append` — add lines to the end of a data file (JSONL records, CSV rows, a
 * log) without an edit anchor. A long research run appended ~900 JSONL records
 * with `edit`, anchoring each on the previous last line; the anchor went stale
 * or matched twice often enough to fail repeatedly, and every append re-sent
 * text it didn't need to.
 *
 * Deliberately NOT for code: source/config files still go through create/edit
 * and the write guard. `.jsonl` / `.ndjson` input is validated line by line, so
 * a malformed record never corrupts the dataset.
 */
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { reject, str, type IToolContext } from "./tool-context";

const MAX_APPEND_CHARS = 100_000;

/** Code and config: edits here must go through create/edit + the write guard. */
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
  ".html",
]);

const JSONL_EXTENSIONS = new Set([".jsonl", ".ndjson"]);

/** Top-level folders `append` never writes into. */
const BLOCKED_ROOTS = new Set(["node_modules", ".git", ".tsforge"]);

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);

  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Why `file` may not be appended to, or null when it may. */
export function appendPathProblem(file: string): string | null {
  if (file.length === 0) {
    return "`file` is required.";
  }

  if (isAbsolute(file) || file.split(/[\\/]/u).includes("..")) {
    return "`file` must be a workspace-relative path without `..`.";
  }

  const top = file.split(/[\\/]/u)[0] ?? "";

  if (BLOCKED_ROOTS.has(top)) {
    return `append does not write inside ${top}/.`;
  }

  return CODE_EXTENSIONS.has(extname(file).toLowerCase())
    ? `${file} is a code/config file — use edit or create so it is checked.`
    : null;
}

/** First line of a JSONL payload that isn't valid JSON, or null. */
export function invalidJsonlLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      JSON.parse(line);
    } catch {
      return line.slice(0, 120);
    }
  }

  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch {
    return false;
  }
}

/** Resolve inside the workspace, refusing symlinked escapes. */
async function resolveTarget(
  cwd: string,
  file: string
): Promise<string | { error: string }> {
  const root = await realpath(cwd);
  const path = join(root, file);

  await mkdir(dirname(path), { recursive: true });

  const dir = await realpath(dirname(path));

  if (dir !== root && !isInside(root, dir)) {
    return { error: `${file}: its folder resolves outside the workspace` };
  }

  if ((await exists(path)) && !isInside(root, await realpath(path))) {
    return { error: `${file} resolves outside the workspace` };
  }

  return path;
}

/** "\n" when the existing file doesn't already end with one (so records never
 *  run together), else "". */
async function separator(path: string): Promise<string> {
  if (!(await exists(path))) {
    return "";
  }

  const text = await readFile(path, "utf8");

  return text.length === 0 || text.endsWith("\n") ? "" : "\n";
}

export async function doAppend(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const file = str(args, "file").trim().split(sep).join("/");
  const text = str(args, "text");
  const problem = appendPathProblem(file);

  if (problem !== null) {
    return reject(ctx, "append", `append: ${problem}`);
  }

  if (text.trim().length === 0) {
    return reject(ctx, "append", "append: `text` is required.");
  }

  if (text.length > MAX_APPEND_CHARS) {
    return reject(
      ctx,
      "append",
      `append: text is ${String(text.length)} chars — keep one call under ${String(MAX_APPEND_CHARS)}.`
    );
  }

  const bad = JSONL_EXTENSIONS.has(extname(file).toLowerCase())
    ? invalidJsonlLine(text)
    : null;

  if (bad !== null) {
    return reject(
      ctx,
      "append",
      `append: ${file} is JSONL and this line is not valid JSON — nothing was written: ${bad}`
    );
  }

  const target = await resolveTarget(ctx.cwd, file);

  if (typeof target !== "string") {
    return reject(ctx, "append", `append: ${target.error}`);
  }

  const body = text.endsWith("\n") ? text : `${text}\n`;

  await appendFile(target, `${await separator(target)}${body}`);

  const lines = body.split("\n").length - 1;
  const size = (await stat(target)).size;

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `↳ append ${file} (+${String(lines)} line${lines === 1 ? "" : "s"})`,
  });

  return `Appended ${String(lines)} line${lines === 1 ? "" : "s"} to ${file} (${String(Math.ceil(size / 1024))} KB total).`;
}
