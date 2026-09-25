import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doNote, slugifyTopic } from "../src/loop/tools/note-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import {
  isAttemptedWriteTool,
  WRITE_FORCE_TOOL_NAMES,
} from "../src/loop/readonly-spin";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsf-note-"));
}

function ctx(cwd: string, touched = new Set<string>()): IToolContext {
  return { cwd, files: [], task: "t", report: () => undefined, touched };
}

describe("slugifyTopic", () => {
  test("lowercases, dashes, trims, caps length, falls back", () => {
    expect(slugifyTopic("Rust Async — Thread #42!")).toBe(
      "rust-async-thread-42"
    );
    expect(slugifyTopic("../../etc/passwd")).toBe("etc-passwd");
    expect(slugifyTopic("!!!")).toBe("notes");
    expect(slugifyTopic("a".repeat(100))).toHaveLength(60);
  });
});

describe("doNote", () => {
  test("appends timestamped entries with source, never overwriting", async () => {
    const dir = await workspace();
    let t = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++));

    expect(
      await doNote(
        { topic: "Forum X", text: "first finding", source: "https://f/1" },
        ctx(dir),
        now
      )
    ).toContain("notes/forum-x.md");
    await doNote({ topic: "Forum X", text: "second finding" }, ctx(dir), now);

    const body = await readFile(join(dir, "notes", "forum-x.md"), "utf8");

    expect(body).toContain("## 2026-01-01T00:00:00.000Z");
    expect(body).toContain("Source: https://f/1");
    expect(body.indexOf("first finding")).toBeLessThan(
      body.indexOf("second finding")
    );
  });

  test("does not mark the note as a code change", async () => {
    const dir = await workspace();
    const touched = new Set<string>();

    await doNote({ topic: "t", text: "x" }, ctx(dir, touched));
    expect(touched.size).toBe(0);
  });

  test("requires topic and text; caps size", async () => {
    const dir = await workspace();

    expect(await doNote({ topic: "t" }, ctx(dir))).toContain("required");
    expect(
      await doNote({ topic: "t", text: "x".repeat(20_001) }, ctx(dir))
    ).toContain("split");
  });

  test("a notes symlink pointing outside the workspace is refused", async () => {
    const dir = await workspace();
    const outside = await workspace();

    await symlink(outside, join(dir, "notes"));
    expect(await doNote({ topic: "t", text: "x" }, ctx(dir))).toContain(
      "outside the workspace"
    );
  });

  test("a note file symlinked outside the workspace is refused", async () => {
    const dir = await workspace();
    const outside = await workspace();

    await writeFile(join(outside, "secret.md"), "keep");
    await mkdir(join(dir, "notes"));
    await symlink(join(outside, "secret.md"), join(dir, "notes", "t.md"));
    expect(await doNote({ topic: "t", text: "x" }, ctx(dir))).toContain(
      "outside the workspace"
    );
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("keep");
  });
});

describe("readonly-spin", () => {
  test("a note counts as a write attempt and survives the write-force filter", () => {
    expect(isAttemptedWriteTool("note")).toBe(true);
    expect(WRITE_FORCE_TOOL_NAMES.has("note")).toBe(true);
    expect(isAttemptedWriteTool("browser_read")).toBe(false);
  });
});
