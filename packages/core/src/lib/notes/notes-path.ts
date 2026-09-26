/**
 * Safe paths under `<cwd>/notes/` — research output written by `note` and by
 * site plugins (sources logs, downloaded images). Every directory on the way is
 * created, then realpath-checked, so a `notes` (or topic) symlink can never send
 * a write outside the workspace.
 */
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const NOTES_DIR = "notes";

const MAX_SLUG = 60;

/** Only plain names — no separators, no `..`, no leading dot. */
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/iu;

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

export type NotesPath = { path: string; rel: string } | { error: string };

/**
 * `<cwd>/notes/<segments…>`: parent directories created and verified to stay
 * inside the workspace; the final file (if it exists) verified too. The last
 * segment is the file; the rest are directories.
 */
export async function resolveNotesPath(
  cwd: string,
  segments: readonly string[]
): Promise<NotesPath> {
  const bad = segments.find((s) => !SEGMENT_RE.test(s) || s.includes(".."));

  if (segments.length === 0 || bad !== undefined) {
    return { error: `invalid notes path segment ${JSON.stringify(bad ?? "")}` };
  }

  const root = await realpath(cwd);
  let dir = join(root, NOTES_DIR);
  let rel = NOTES_DIR;

  for (const part of [undefined, ...segments.slice(0, -1)]) {
    if (part !== undefined) {
      dir = join(dir, part);
      rel = `${rel}/${part}`;
    }

    await mkdir(dir, { recursive: true });

    if (!(await stat(dir)).isDirectory()) {
      return { error: `${rel}/ exists but is not a directory` };
    }

    if (!isInside(root, await realpath(dir))) {
      return { error: `${rel}/ resolves outside the workspace` };
    }
  }

  const file = segments[segments.length - 1] ?? "";
  const path = join(dir, file);

  rel = `${rel}/${file}`;

  if ((await exists(path)) && !isInside(root, await realpath(path))) {
    return { error: `${rel} resolves outside the workspace` };
  }

  return { path, rel };
}
