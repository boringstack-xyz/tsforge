import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGate,
  makeFileLinter,
  discoverTestCommand,
  discoverTestGate,
  isWatchTestScript,
  buildCoreFix,
  formatFile,
} from "../src/gate";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT_BIN = join(ROOT, "node_modules", ".bin", "eslint");
const STRICT_CONFIG = join(import.meta.dir, "..", "strict.eslint.config.mjs");

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-gate-"));
}

// P3 (review): formatFile used raw Bun.spawn (no kill-timeout) on the per-write hot
// path. It now routes eslint --fix + prettier --write through the shared
// runArgvCommand (timeout-bounded). This locks that the refactor still formats.
test("formatFile normalizes a messy file (via the shared timeout-bounded runner)", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "m.ts"), "export  const   x=1");
    await formatFile(dir, "m.ts");

    expect(await readFile(join(dir, "m.ts"), "utf8")).toBe(
      "export const x = 1;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // Spawns eslint --fix AND prettier --write. Both cold-start on a CI runner,
  // which blows bun's 5s default — this has been failing on main since at least
  // 2026-09-03. The sibling toolchain-spawning tests in this file already carry
  // the same 30s allowance.
}, 30_000);

test("greenfield TS project: brings a strict tsconfig + gates on tsc AND eslint", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const gate = await buildGate(dir);

    // type-aware floor + syntactic idioms (tsc runs incremental for warm speed)
    expect(gate.command).toContain("--noEmit");
    expect(gate.command).toContain("-p tsconfig.json");
    expect(gate.command).toContain("--incremental");
    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.label).toContain("tsc --strict");
    expect(gate.label).toContain("strict TypeScript");

    // it brought a strict tsconfig with the index-safety floor
    const tsconfig = await readFile(join(dir, "tsconfig.json"), "utf8");

    expect(tsconfig).toContain("noUncheckedIndexedAccess");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("always uses tsforge strict eslint, ignoring the project's lint script", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    const gate = await buildGate(dir);

    // Policy: never defer to the project's lint script (that's how a weak repo
    // would dodge the strict-TS floor). Always the bundled strict config.
    expect(gate.command).not.toContain("run lint");
    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.label).toContain("strict TypeScript");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing tsconfig: not overwritten, but gated via a strict override that extends it", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(dir, "tsconfig.json"), '{ "mine": true }\n');
    const gate = await buildGate(dir);

    // The project's own tsconfig is never clobbered…
    expect(await readFile(join(dir, "tsconfig.json"), "utf8")).toContain(
      '"mine": true'
    );

    // …but the gate runs a strict overlay that extends it and forces the floor.
    // The overlay lives under .tsforge/ (not a sibling in the project root).
    expect(gate.command).toContain("-p .tsforge/tsconfig.gate.json");
    expect(existsSync(join(dir, "tsforge.tsconfig.json"))).toBe(false);
    const override = await readFile(
      join(dir, ".tsforge", "tsconfig.gate.json"),
      "utf8"
    );

    expect(override).toContain('"extends": "../tsconfig.json"');
    expect(override).toContain("noUncheckedIndexedAccess");

    // The ephemeral overlay is self-ignored so it never lands in the user's git.
    expect(
      await readFile(join(dir, ".tsforge", ".gitignore"), "utf8")
    ).toContain("tsconfig.gate.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-TS directory (no package.json): eslint-only, no tsc, no tsconfig written", async () => {
  const dir = await tempDir();

  try {
    const gate = await buildGate(dir);

    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.command).not.toContain("--noEmit");
    expect(await Bun.file(join(dir, "tsconfig.json")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: real test script → bun run test", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );

    expect(await discoverTestCommand(dir)).toBe("bun run test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isWatchTestScript: bare vitest / --watch hang; vitest run does not", () => {
  expect(isWatchTestScript("vitest")).toBe(true);
  expect(isWatchTestScript("vitest --coverage")).toBe(true);
  expect(isWatchTestScript("vitest --watch")).toBe(true);
  expect(isWatchTestScript("jest --watch")).toBe(true);
  expect(isWatchTestScript("vitest run")).toBe(false);
  expect(isWatchTestScript("vitest run --coverage")).toBe(false);
  expect(isWatchTestScript("jest")).toBe(false);
});

test("isWatchTestScript: sees through package runners and --watch=false", () => {
  // A runner prefix does not make watch mode one-shot.
  expect(isWatchTestScript("npx vitest")).toBe(true);
  expect(isWatchTestScript("pnpm vitest --coverage")).toBe(true);
  expect(isWatchTestScript("pnpm exec vitest")).toBe(true);
  expect(isWatchTestScript("pnpm exec vitest run")).toBe(false);
  expect(isWatchTestScript("bunx vitest")).toBe(true);
  expect(isWatchTestScript("npx vitest run")).toBe(false);
  // Explicit opt-out is one-shot.
  expect(isWatchTestScript("vitest --watch=false")).toBe(false);
  expect(isWatchTestScript("jest --watchAll=false")).toBe(false);
  expect(isWatchTestScript("jest --watchAll")).toBe(true);
});

test("discoverTestCommand: runner-prefixed watch vitest is made one-shot", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "npx vitest --coverage" } })
    );

    expect(await discoverTestCommand(dir)).toBe("bun run test -- run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: --watch script is dropped, never rewritten", async () => {
  const dir = await tempDir();

  try {
    // `bun run test -- run` would yield `jest --watch run`: still watching, so
    // the gate would hang forever. Dropping tests is the only safe answer, and
    // `bun test` is not a substitute for another runner's suites.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "jest --watch" } })
    );
    await writeFile(join(dir, "a.test.ts"), "export const x = 1;\n");

    expect(await discoverTestCommand(dir)).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: composite watch script is dropped, never rewritten", async () => {
  const dir = await tempDir();

  try {
    // Appending `run` would land on the LAST command: `tsc --noEmit run`, which
    // fails on a phantom file named `run`.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest && tsc --noEmit" } })
    );
    await writeFile(join(dir, "a.test.ts"), "export const x = 1;\n");

    expect(await discoverTestCommand(dir)).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: watch test:ci falls through to the test script", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", "test:ci": "vitest --watch" },
      })
    );

    expect(await discoverTestCommand(dir)).toBe("bun run test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: prefers test:ci over watch vitest", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest", "test:ci": "vitest run" },
      })
    );

    expect(await discoverTestCommand(dir)).toBe("bun run test:ci");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: watch vitest → bun run test -- run", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );

    expect(await discoverTestCommand(dir)).toBe("bun run test -- run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: workspace container → null (no whole-tree tests)", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "app"));
    await writeFile(
      join(dir, "app", "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    await writeFile(join(dir, "app", "a.test.ts"), "export const x = 1;\n");

    expect(await discoverTestCommand(dir)).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGate: workspace container → no-op true (package-follow owns gates)", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "pkg-a"));
    await writeFile(
      join(dir, "pkg-a", "package.json"),
      JSON.stringify({ name: "pkg-a" })
    );

    const gate = await buildGate(dir);

    expect(gate.command).toBe("true");
    expect(gate.label).toContain("workspace container");
    expect(gate.command).not.toContain("eslint");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: npm-init placeholder is ignored, falls to file detection", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      })
    );

    // No test files → the placeholder must NOT count → null (floor only).
    expect(await discoverTestCommand(dir)).toBe(null);

    // A test file present → bun test, even though the script is the placeholder.
    await writeFile(join(dir, "sum.test.ts"), "export const x = 1;\n");
    expect(await discoverTestCommand(dir)).toBe("bun test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestCommand: test files but no script → bun test; nothing → null", async () => {
  const dir = await tempDir();

  try {
    expect(await discoverTestCommand(dir)).toBe(null);

    await writeFile(join(dir, "a.spec.ts"), "export const x = 1;\n");
    expect(await discoverTestCommand(dir)).toBe("bun test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGate includeTests: appends tests only when the project has them", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    // No tests yet → floor only, even with includeTests on.
    const floor = await buildGate(dir, undefined, undefined, {
      includeTests: true,
    });

    expect(floor.command).not.toContain("bun test");
    expect(floor.label).not.toContain("tests");

    // Add a test file → it's appended LAST (after the static floor).
    await writeFile(join(dir, "a.test.ts"), "export const x = 1;\n");
    const withTests = await buildGate(dir, undefined, undefined, {
      includeTests: true,
    });

    expect(withTests.command).toContain("bun test");
    expect(withTests.command.trim().endsWith("bun test")).toBe(true);
    expect(withTests.label).toContain("tests");

    // Default (no includeTests) stays floor-only.
    const noOpt = await buildGate(dir);

    expect(noOpt.command).not.toContain("bun test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("opt-in oracles join the gate ONLY when their env var is set", async () => {
  const dir = await tempDir();
  const keys = [
    "TSFORGE_COVERAGE",
    "TSFORGE_BOOT",
    "TSFORGE_PROPTEST",
  ] as const;
  const saved = new Map(keys.map((k) => [k, process.env[k]]));

  for (const k of keys) {
    Reflect.deleteProperty(process.env, k);
  }

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    // Default: none of the oracles are present.
    const off = await buildGate(dir);

    expect(off.label).not.toContain("test coverage");
    expect(off.label).not.toContain("boot smoke");
    expect(off.label).not.toContain("property tests");

    // Each env var pulls in exactly its oracle.
    process.env.TSFORGE_COVERAGE = "80";
    expect((await buildGate(dir)).label).toContain("test coverage");
    delete process.env.TSFORGE_COVERAGE;

    process.env.TSFORGE_BOOT = "bun run start";
    expect((await buildGate(dir)).label).toContain("boot smoke");
    delete process.env.TSFORGE_BOOT;

    process.env.TSFORGE_PROPTEST = "1";
    expect((await buildGate(dir)).label).toContain("property tests");
    delete process.env.TSFORGE_PROPTEST;

    // An empty value does NOT count as set (guards against `export X=`) — for
    // EVERY opt-in oracle, not just coverage.
    process.env.TSFORGE_COVERAGE = "";
    expect((await buildGate(dir)).label).not.toContain("test coverage");
    delete process.env.TSFORGE_COVERAGE;

    process.env.TSFORGE_BOOT = "";
    expect((await buildGate(dir)).label).not.toContain("boot smoke");
    delete process.env.TSFORGE_BOOT;

    process.env.TSFORGE_PROPTEST = "";
    expect((await buildGate(dir)).label).not.toContain("property tests");
    delete process.env.TSFORGE_PROPTEST;
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = v;
      }
    }

    await rm(dir, { recursive: true, force: true });
  }
});

interface ILintMessage {
  ruleId: string | null;
  fix?: unknown;
}

interface ILintedFile {
  messages: ILintMessage[];
}

function isLintedFileArray(value: unknown): value is ILintedFile[] {
  return Array.isArray(value);
}

async function runStrictEslint(
  cwd: string,
  file: string,
  fix = false
): Promise<ILintMessage[]> {
  const args = [
    "bun",
    ESLINT_BIN,
    "--no-config-lookup",
    "-c",
    STRICT_CONFIG,
    "--format",
    "json",
    ...(fix ? ["--fix"] : []),
    file,
  ];

  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const parsed: unknown = JSON.parse(stdout);

  if (!isLintedFileArray(parsed)) {
    throw new Error(`unexpected eslint output: ${stdout.slice(0, 200)}`);
  }

  return parsed.flatMap((f) => f.messages);
}

test("core strict config flags missing blank line before return", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    const f = join(dir, "src", "fn.ts");

    await writeFile(
      f,
      "export function f(): number {\n  const n = 1;\n  return n;\n}\n"
    );

    const messages = await runStrictEslint(dir, "src/fn.ts");
    const padding = messages.filter(
      (m) => m.ruleId === "@stylistic/padding-line-between-statements"
    );

    expect(padding.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("core strict config eslint --fix inserts blank line before return", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    const f = join(dir, "src", "fn.ts");

    await writeFile(
      f,
      "export function f(): number {\n  const n = 1;\n  return n;\n}\n"
    );

    await runStrictEslint(dir, "src/fn.ts", true);

    const text = await readFile(f, "utf8");

    expect(text).toContain("const n = 1;\n\n  return n;");

    const messages = await runStrictEslint(dir, "src/fn.ts");
    const padding = messages.filter(
      (m) => m.ruleId === "@stylistic/padding-line-between-statements"
    );

    expect(padding).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("makeFileLinter core does NOT report auto-fixable padding-line issues", async () => {
  const dir = await tempDir();

  try {
    const lint = makeFileLinter("core", dir);

    await mkdir(join(dir, "src"), { recursive: true });

    const f = join(dir, "src", "mix.ts");

    await writeFile(
      f,
      "export function f(): string {\n" +
        "  const v = (1 as unknown) as string;\n" +
        "  return v;\n" +
        "}\n"
    );

    const problems = await lint(f);

    expect(
      problems.some(
        (p) => p.ruleId === "@typescript-eslint/consistent-type-assertions"
      )
    ).toBe(true);
    expect(
      problems.some(
        (p) => p.ruleId === "@stylistic/padding-line-between-statements"
      )
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildCoreFix returns eslint --fix and prettier commands", () => {
  const fix = buildCoreFix();

  expect(fix).toContain("eslint");
  expect(fix).toContain("--fix");
  expect(fix).toContain("strict.eslint.config.mjs");
  expect(fix).toContain("prettier");
});

test("a watch-only test script surfaces a SKIPPED notice instead of a silent drop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-watchonly-"));

  try {
    // `jest --watch` under a runner is watch-only and NOT rewritable to one-shot
    // — before, the suite silently vanished from the gate (trace-only).
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        scripts: { test: "npm run build && jest --watch" },
      })
    );

    const t = await discoverTestGate(dir);

    expect(t.command).toBeNull();
    expect(t.notice).toContain("tests SKIPPED");
    expect(t.notice).toContain("test:ci");

    // …and the notice reaches the gate label, where GREEN is announced.
    const gate = await buildGate(dir, [], undefined, { includeTests: true });

    expect(gate.label).toContain("tests SKIPPED");
    // The notice is a label, never a command part.
    expect(gate.command).not.toContain("SKIPPED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a runnable test script yields a command and NO notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-runnable-"));

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest run" } })
    );

    const t = await discoverTestGate(dir);

    expect(t.command).toBe("bun run test");
    expect(t.notice).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
