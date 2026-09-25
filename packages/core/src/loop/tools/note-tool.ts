/**
 * `note` — append research notes to `notes/<topic>.md` in the workspace.
 * Append-only and outside the code scope / write-guard on purpose: notes are
 * research output, not code, and they must survive context compaction during a
 * long browsing session. The path is fixed to `<cwd>/notes/`; the realpath
 * check refuses a `notes` symlink pointing elsewhere.
 */
import { appendFile, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { reject, str, type IToolContext } from "./tool-context";

export const NOTES_DIR = "notes";

const MAX_SLUG = 60;
const MAX_NOTE_CHARS = 20_000;

export function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/gu, "");

  return slug.length > 0 ? slug : "notes";
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);

  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch {
    return false;
  }
}

/** `<cwd>/notes/<slug>.md`, or an error string when `notes` (or the file) is a
 *  symlink / non-directory that would send the write outside the workspace. */
export async function resolveNotePath(
  cwd: string,
  topic: string
): Promise<{ path: string; rel: string } | { error: string }> {
  const root = await realpath(cwd);
  const dir = join(root, NOTES_DIR);

  await mkdir(dir, { recursive: true });

  if (!(await stat(dir)).isDirectory()) {
    return { error: `${NOTES_DIR}/ exists but is not a directory` };
  }

  if (!isInside(root, await realpath(dir))) {
    return { error: `${NOTES_DIR}/ resolves outside the workspace` };
  }

  const rel = `${NOTES_DIR}/${slugifyTopic(topic)}.md`;
  const path = join(root, rel);

  if ((await exists(path)) && !isInside(root, await realpath(path))) {
    return { error: `${rel} resolves outside the workspace` };
  }

  return { path, rel };
}

function entry(text: string, source: string, at: Date): string {
  const src = source.length > 0 ? `Source: ${source}\n\n` : "";

  return `\n## ${at.toISOString()}\n\n${src}${text.trim()}\n`;
}

export async function doNote(
  args: Record<string, unknown>,
  ctx: IToolContext,
  now: () => Date = () => new Date()
): Promise<string> {
  const topic = str(args, "topic").trim();
  const text = str(args, "text");

  if (topic.length === 0 || text.trim().length === 0) {
    return reject(ctx, "note", "note: `topic` and `text` are required.");
  }

  if (text.length > MAX_NOTE_CHARS) {
    return reject(
      ctx,
      "note",
      `note: text is ${String(text.length)} chars — keep one note under ${String(MAX_NOTE_CHARS)} (split it into several calls).`
    );
  }

  const target = await resolveNotePath(ctx.cwd, topic);

  if ("error" in target) {
    return reject(ctx, "note", `note: ${target.error}`);
  }

  await appendFile(
    target.path,
    entry(text, str(args, "source").trim(), now()),
    {
      flag: "a",
    }
  );

  const size = (await stat(target.path)).size;

  ctx.report({ kind: "tool", task: ctx.task, message: `↳ note ${target.rel}` });

  return `Appended ${String(text.length)} chars to ${target.rel} (${String(Math.ceil(size / 1024))} KB total).`;
}
