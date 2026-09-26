/**
 * `note` — append research notes under `notes/` in the workspace.
 * Append-only and outside the code scope / write-guard on purpose: notes are
 * research output, not code, and they must survive context compaction during a
 * long browsing session.
 *
 * Without `file`: `notes/<topic>.md` (the original single-file layout).
 * With `file`: a topic folder — `notes/<topic>/findings.md` (append) or
 * `notes/<topic>/report.md`, the one file `replace: true` may rewrite, so a
 * synthesis can improve as the research does. `sources.md` in the same folder
 * is written by site plugins, never by `note`.
 */
import { appendFile, stat, writeFile } from "node:fs/promises";
import {
  resolveNotesPath,
  slugifyTopic,
  type NotesPath,
} from "../../lib/notes/notes-path";
import { reject, str, type IToolContext } from "./tool-context";

export { NOTES_DIR, slugifyTopic } from "../../lib/notes/notes-path";

const MAX_NOTE_CHARS = 20_000;

/** A report rewrite may be a whole synthesis — allow more than one note. */
const MAX_REPORT_CHARS = 60_000;

const NOTE_FILES = new Set(["findings", "report"]);

export function resolveNotePath(
  cwd: string,
  topic: string,
  file?: string
): Promise<NotesPath> {
  const slug = slugifyTopic(topic);

  return file === undefined
    ? resolveNotesPath(cwd, [`${slug}.md`])
    : resolveNotesPath(cwd, [slug, `${file}.md`]);
}

function entry(text: string, source: string, at: Date): string {
  const src = source.length > 0 ? `Source: ${source}\n\n` : "";

  return `\n## ${at.toISOString()}\n\n${src}${text.trim()}\n`;
}

/** Argument errors, or null when the call is well-formed. */
function argError(
  topic: string,
  text: string,
  file: string | undefined,
  replace: boolean
): string | null {
  if (topic.length === 0 || text.trim().length === 0) {
    return "note: `topic` and `text` are required.";
  }

  if (file !== undefined && !NOTE_FILES.has(file)) {
    return 'note: `file` must be "findings" or "report".';
  }

  if (replace && file !== "report") {
    return 'note: `replace` is only allowed with file: "report" — everything else is append-only.';
  }

  const cap = file === "report" ? MAX_REPORT_CHARS : MAX_NOTE_CHARS;

  return text.length > cap
    ? `note: text is ${String(text.length)} chars — keep one note under ${String(cap)} (split it into several calls).`
    : null;
}

export async function doNote(
  args: Record<string, unknown>,
  ctx: IToolContext,
  now: () => Date = () => new Date()
): Promise<string> {
  const topic = str(args, "topic").trim();
  const text = str(args, "text");
  const rawFile = str(args, "file").trim();
  const file = rawFile.length > 0 ? rawFile : undefined;
  const replace = args.replace === true;
  const invalid = argError(topic, text, file, replace);

  if (invalid !== null) {
    return reject(ctx, "note", invalid);
  }

  const target = await resolveNotePath(ctx.cwd, topic, file);

  if ("error" in target) {
    return reject(ctx, "note", `note: ${target.error}`);
  }

  const source = str(args, "source").trim();

  if (replace) {
    await writeFile(target.path, `${text.trim()}\n`);
  } else {
    await appendFile(target.path, entry(text, source, now()), { flag: "a" });
  }

  const size = (await stat(target.path)).size;
  const verb = replace ? "Wrote" : "Appended";

  ctx.report({ kind: "tool", task: ctx.task, message: `↳ note ${target.rel}` });

  return `${verb} ${String(text.length)} chars to ${target.rel} (${String(Math.ceil(size / 1024))} KB total).`;
}
