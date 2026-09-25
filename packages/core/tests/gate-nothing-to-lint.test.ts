/**
 * The strict gate in a folder with no lintable files used to exit 2 ("all files
 * matching '.' are ignored"), which the validator counted as ONE gate error —
 * a permanent near-green red that drove a research session into writing
 * TypeScript to satisfy ESLint. Nothing to lint must mean nothing wrong; real
 * lint errors must still fail.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGate } from "../src/gate/core-gate";

async function run(command: string, cwd: string): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });

  return proc.exited;
}

describe("strict gate with nothing to lint", () => {
  test("a notes-only folder passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsf-nolint-"));

    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes", "forum.md"), "# findings\n");
    const gate = await buildGate(dir);

    expect(await run(gate.command, dir)).toBe(0);
  }, 60_000);

  test("a real lint error still fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsf-nolint-"));

    await writeFile(
      join(dir, "bad.ts"),
      "const x: any = 1;\nexport default x;\n"
    );
    const gate = await buildGate(dir);

    expect(await run(gate.command, dir)).not.toBe(0);
  }, 60_000);
});
