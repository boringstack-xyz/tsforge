import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPathProblem,
  doAppend,
  invalidJsonlLine,
} from "../src/loop/tools/append-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import {
  isAttemptedWriteTool,
  WRITE_FORCE_TOOL_NAMES,
} from "../src/loop/readonly-spin";
import { classifyAction } from "../src/policy/classify";

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tsf-append-"));

  dirs.push(d);

  return d;
}

function ctx(cwd: string): IToolContext {
  return { cwd, files: [], task: "t", report: () => undefined };
}

describe("append", () => {
  test("adds records to the end without an anchor, creating the file", async () => {
    const cwd = await tempDir();

    await doAppend({ file: "data/results.jsonl", text: '{"a":1}' }, ctx(cwd));
    await doAppend(
      { file: "data/results.jsonl", text: '{"a":2}\n{"a":3}\n' },
      ctx(cwd)
    );

    expect(await readFile(join(cwd, "data/results.jsonl"), "utf8")).toBe(
      '{"a":1}\n{"a":2}\n{"a":3}\n'
    );
  });

  test("never runs two records together when the file lacks a final newline", async () => {
    const cwd = await tempDir();

    await writeFile(join(cwd, "log.csv"), "a,b");
    await doAppend({ file: "log.csv", text: "c,d" }, ctx(cwd));

    expect(await readFile(join(cwd, "log.csv"), "utf8")).toBe("a,b\nc,d\n");
  });

  test("a malformed JSONL record writes nothing", async () => {
    const cwd = await tempDir();
    const out = await doAppend(
      { file: "r.jsonl", text: '{"ok":1}\n{"broken":' },
      ctx(cwd)
    );

    expect(out).toContain("not valid JSON");
    expect(invalidJsonlLine('{"x":1}\n\n{"y":2}')).toBeNull();
    await expect(readFile(join(cwd, "r.jsonl"), "utf8")).rejects.toThrow();
  });

  test.each([
    ["src/app.ts", "code/config file"],
    ["package.json", "code/config file"],
    ["../outside.txt", "without `..`"],
    ["/etc/passwd", "without `..`"],
    ["node_modules/x/log.txt", "inside node_modules/"],
    [".git/hooks/post-commit", "inside .git/"],
    ["data/results.jsonl", null],
    ["notes/raw.md", null],
  ])("%p", (file, problem) => {
    const got = appendPathProblem(file);

    if (problem === null) {
      expect(got).toBeNull();
    } else {
      expect(got).toContain(problem);
    }
  });

  test("a folder symlinked outside the workspace is refused", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();

    await symlink(outside, join(cwd, "data"));
    expect(
      await doAppend({ file: "data/x.jsonl", text: "{}" }, ctx(cwd))
    ).toContain("outside the workspace");
  });

  test("counts as a write (not a read-only spin) and survives the write-force filter", async () => {
    await mkdir(await tempDir(), { recursive: true });
    expect(isAttemptedWriteTool("append")).toBe(true);
    expect(WRITE_FORCE_TOOL_NAMES.has("append")).toBe(true);
    expect(
      classifyAction({ name: "append", arguments: { file: "a.jsonl" } }, "/tmp")
        .kind
    ).toBe("edit_file");
  });
});
