import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceHasCode } from "../src/gate/workspace-code";

async function dir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsf-wscode-"));

  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), content);
  }

  return root;
}

describe("workspaceHasCode", () => {
  test("empty folder and a research-notes folder have no code", async () => {
    expect(workspaceHasCode(await dir({}))).toBe(false);
    expect(
      workspaceHasCode(
        await dir({
          "notes/forum.md": "# notes",
          ".tsforge/worklist/index.json": "{}",
          "README.md": "hi",
          "shots/a.png": "x",
        })
      )
    ).toBe(false);
  });

  test("a package.json, tsconfig, or source file anywhere shallow is code", async () => {
    expect(workspaceHasCode(await dir({ "package.json": "{}" }))).toBe(true);
    expect(workspaceHasCode(await dir({ "tsconfig.base.json": "{}" }))).toBe(
      true
    );
    expect(workspaceHasCode(await dir({ "src/index.ts": "" }))).toBe(true);
    expect(workspaceHasCode(await dir({ "app/page.tsx": "" }))).toBe(true);
    expect(workspaceHasCode(await dir({ "scripts/run.mjs": "" }))).toBe(true);
  });

  test("code only inside ignored folders doesn't count", async () => {
    expect(
      workspaceHasCode(
        await dir({
          "node_modules/x/index.js": "",
          ".tsforge/tsconfig.gate.json": "{}",
          "notes/snippet.ts": "",
          "types/only.d.ts": "",
        })
      )
    ).toBe(false);
  });

  test("the probe is bounded", async () => {
    expect(
      workspaceHasCode(await dir({ "a/b/c/d/e/f/deep.ts": "" }), {
        maxDepth: 2,
        maxEntries: 100,
      })
    ).toBe(false);
  });
});
