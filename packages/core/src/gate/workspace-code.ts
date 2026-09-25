/**
 * Does this workspace contain any JS/TS project at all? The automatic gate is
 * a strict TypeScript gate; in a folder of research notes (or an empty folder)
 * there is nothing for it to check, so the session keeps it DORMANT until code
 * appears (see Session.hasGate). Bounded and synchronous: stops at the first
 * hit and never walks more than `maxEntries` directory entries.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MARKER_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "deno.json",
  "deno.jsonc",
]);

const SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/u;

const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".tsforge",
  "notes",
  "dist",
  "build",
  "coverage",
]);

export interface IWorkspaceProbeLimits {
  maxDepth: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: IWorkspaceProbeLimits = { maxDepth: 4, maxEntries: 5000 };

function isCodeFile(name: string): boolean {
  return (
    MARKER_FILES.has(name) ||
    /^tsconfig\..+\.json$/u.test(name) ||
    (SOURCE_RE.test(name) && !name.endsWith(".d.ts"))
  );
}

function listDir(dir: string): { name: string; isDir: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}

interface IScan {
  seen: number;
  next: string[];
}

/** Scan one directory: "code" on a hit, "limit" past the entry cap, else queue
 *  its subdirectories onto `scan.next`. */
function scanDir(
  dir: string,
  scan: IScan,
  limits: IWorkspaceProbeLimits
): "code" | "limit" | null {
  for (const entry of listDir(dir)) {
    scan.seen += 1;

    if (scan.seen > limits.maxEntries) {
      return "limit";
    }

    if (!entry.isDir && isCodeFile(entry.name)) {
      return "code";
    }

    if (
      entry.isDir &&
      !SKIP_DIRS.has(entry.name) &&
      !entry.name.startsWith(".")
    ) {
      scan.next.push(join(dir, entry.name));
    }
  }

  return null;
}

export function workspaceHasCode(
  cwd: string,
  limits: IWorkspaceProbeLimits = DEFAULT_LIMITS
): boolean {
  let queue: string[] = [cwd];
  const scan: IScan = { seen: 0, next: [] };

  for (
    let depth = 0;
    depth <= limits.maxDepth && queue.length > 0;
    depth += 1
  ) {
    scan.next = [];

    for (const dir of queue) {
      const hit = scanDir(dir, scan, limits);

      if (hit !== null) {
        return hit === "code";
      }
    }

    queue = scan.next;
  }

  return false;
}
