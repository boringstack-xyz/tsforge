/**
 * Terminal ownership, enforced statically. While the pane console is up, only
 * its renderer may write to the terminal. In-process writers are caught at
 * runtime by the TerminalGuard (src/cli/terminal-guard.ts), but a CHILD process
 * writes to the terminal's file descriptors directly — no JS guard sees that.
 * The only defence is never letting a child inherit them. That is how stdio MCP
 * servers' logging (`[pid] [Local→Remote] tools/call` from mcp-remote) painted
 * over the UI: `stderr: "inherit"`.
 *
 * Bun.spawn's DEFAULT for stderr is "inherit", so an options object that simply
 * omits it leaks too. Every Bun.spawn / Bun.spawnSync in src/ must therefore say
 * where stderr goes, and nothing may inherit stdout/stderr.
 */
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    return /\.tsx?$/u.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

interface IFinding {
  where: string;
  problem: string;
}

function propInit(
  obj: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined | null {
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) {
      return null; // present, value not statically known
    }

    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name
    ) {
      return p.initializer;
    }
  }

  return undefined;
}

function isInherit(e: ts.Expression | undefined | null): boolean {
  if (e === undefined || e === null) {
    return false;
  }

  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text === "inherit";
  }

  // stdio: ["pipe", "inherit", …] — any inherited slot leaks
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.some((el) => isInherit(el));
  }

  return false;
}

function hasSpread(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => ts.isSpreadAssignment(p));
}

/** Findings for one source file. */
export function scan(file: string, text: string): IFinding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: IFinding[] = [];
  const where = (n: ts.Node): string =>
    `${relative(SRC, file)}:${String(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)}`;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      const isBunSpawn = callee === "Bun.spawn" || callee === "Bun.spawnSync";
      const isNodeSpawn =
        /^(?:\w+\.)?(?:spawn|spawnSync|execFile|execFileSync|fork)$/u.test(
          callee
        );

      if (isBunSpawn) {
        const [first, second] = node.arguments;
        const opts =
          first !== undefined && ts.isObjectLiteralExpression(first)
            ? first
            : second;

        if (opts === undefined || !ts.isObjectLiteralExpression(opts)) {
          findings.push({
            where: where(node),
            problem: `${callee} without an inline options object — pass { stdout, stderr } so it can be checked (Bun's default stderr is "inherit")`,
          });
        } else {
          const stderr = propInit(opts, "stderr");
          const stdout = propInit(opts, "stdout");
          const stdio = propInit(opts, "stdio");

          if (stderr === undefined && stdio === undefined && !hasSpread(opts)) {
            findings.push({
              where: where(node),
              problem: `${callee} does not set stderr — Bun's default is "inherit", which paints over the UI. Use "pipe" (and drain it) or "ignore"`,
            });
          }

          for (const [name, value] of [
            ["stderr", stderr],
            ["stdout", stdout],
            ["stdio", stdio],
          ] as const) {
            if (isInherit(value)) {
              findings.push({
                where: where(node),
                problem: `${callee} ${name}: "inherit" — a child writing to the terminal corrupts the UI; pipe it`,
              });
            }
          }
        }
      }

      if (isNodeSpawn) {
        for (const arg of node.arguments) {
          if (
            ts.isObjectLiteralExpression(arg) &&
            isInherit(propInit(arg, "stdio"))
          ) {
            findings.push({
              where: where(node),
              problem: `${callee} stdio: "inherit" — pipe the child's output instead`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  return findings;
}

test("no child process in src/ can write to the terminal", () => {
  const findings = sourceFiles(SRC).flatMap((f) =>
    scan(f, readFileSync(f, "utf8"))
  );

  expect(findings.map((f) => `${f.where}  ${f.problem}`)).toEqual([]);
});

// ── the scanner itself (a guard that cannot fail proves nothing) ─────────────

test("scanner flags the MCP bug and Bun's silent default", () => {
  const leaks = [
    `Bun.spawn({ cmd: ["x"], stdout: "pipe", stderr: "inherit" });`,
    `Bun.spawn(["x"], { stdout: "pipe" });`,
    `Bun.spawnSync(["x"], { stdout: "inherit", stderr: "pipe" });`,
    `Bun.spawn(["x"], { stdio: ["pipe", "inherit", "pipe"] });`,
    `Bun.spawn(["x"], opts);`,
    `Bun.spawn(["x"]);`,
    `import { spawn } from "node:child_process"; spawn("x", [], { stdio: "inherit" });`,
    `child_process.spawnSync("x", [], { stdio: ["ignore", "pipe", "inherit"] });`,
  ];

  for (const code of leaks) {
    expect({ code, flagged: scan(join(SRC, "x.ts"), code).length > 0 }).toEqual(
      {
        code,
        flagged: true,
      }
    );
  }
});

test("scanner passes the safe shapes", () => {
  const safe = [
    `Bun.spawn({ cmd: ["x"], stdout: "pipe", stderr: "pipe" });`,
    `Bun.spawn(["x"], { stdout: "ignore", stderr: "ignore" });`,
    `Bun.spawn(["x"], { ...base, stdout: "pipe" });`, // spread: stderr set by base
    `import { spawn } from "node:child_process"; spawn("x", [], { stdio: "pipe" });`,
    `const s = "stderr: \\"inherit\\""; // strings in docs are not calls`,
  ];

  for (const code of safe) {
    expect({ code, findings: scan(join(SRC, "x.ts"), code) }).toEqual({
      code,
      findings: [],
    });
  }
});
