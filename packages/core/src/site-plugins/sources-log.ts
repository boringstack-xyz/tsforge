/**
 * `notes/<topic>/sources.md` — the ledger of everything a site plugin read for
 * a research topic. Append-only and harness-written. It is also the duplicate
 * check: a run that lasts days restarts many times, and without a record on
 * disk every restart re-reads the same threads.
 *
 * One line per source: `- [<site>:<id>] <title> — <url> (<meta>; read <ISO date>)`.
 */
import { appendFile, readFile } from "node:fs/promises";
import { resolveNotesPath, slugifyTopic } from "../lib/notes/notes-path";

export const SOURCES_FILE = "sources.md";

const LINE_ID = /^- \[([a-z0-9-]+:[A-Za-z0-9_]+)\]/u;

export interface ISourceEntry {
  site: string;
  id: string;
  title: string;
  url: string;
  meta: string;
}

function sourceKey(site: string, id: string): string {
  return `${site}:${id}`;
}

/** Keys (`reddit:abc123`) already recorded for the topic; empty when none. */
export async function readSources(
  cwd: string,
  topic: string
): Promise<Set<string>> {
  const target = await resolveNotesPath(cwd, [
    slugifyTopic(topic),
    SOURCES_FILE,
  ]);

  if ("error" in target) {
    return new Set();
  }

  let text: string;

  try {
    text = await readFile(target.path, "utf8");
  } catch {
    return new Set();
  }

  const keys = new Set<string>();

  for (const line of text.split("\n")) {
    const key = LINE_ID.exec(line)?.[1];

    if (key !== undefined) {
      keys.add(key);
    }
  }

  return keys;
}

/** Append one source line (creating the file with a heading). Returns the
 *  path written, or an error string. */
export async function recordSource(
  cwd: string,
  topic: string,
  entry: ISourceEntry,
  at: Date
): Promise<{ rel: string } | { error: string }> {
  const target = await resolveNotesPath(cwd, [
    slugifyTopic(topic),
    SOURCES_FILE,
  ]);

  if ("error" in target) {
    return target;
  }

  const existing = await readSources(cwd, topic);
  const head = existing.size === 0 ? `# Sources — ${topic}\n\n` : "";
  const title = entry.title.replace(/\s+/gu, " ").trim();
  const line = `- [${sourceKey(entry.site, entry.id)}] ${title} — ${entry.url} (${entry.meta}; read ${at.toISOString().slice(0, 10)})\n`;

  await appendFile(target.path, `${head}${line}`);

  return { rel: target.rel };
}

export { sourceKey };
