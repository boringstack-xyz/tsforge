import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { currentVersion } from "../update-check";
import type { IGateSpec } from "./types";
import {
  ESLINT_BIN,
  PRETTIER_BIN,
  STRICT_CONFIG,
  TYPE_AWARE_CONFIG,
  TEST_COVERAGE_CHECK,
  BOOT_CHECK,
  PROPTEST_CHECK,
} from "./tool-paths";
import { packEnvPrefix } from "./shell";
import { shellQuote } from "../lib/fs";
import { tscPart, PROJECT_TSCONFIG } from "./tsconfig";
import { discoverTestGate } from "./test-discovery";
import { isWorkspaceContainer } from "./workspace-root";
import type { IConventions } from "../infer-rules/conventions.types";

/** tsforge's per-project cache namespace (git-ignored, next to the tsc
 *  buildinfo). The syntactic-lint result cache lives here. */
const GATE_CACHE_DIR = ".tsforge";

/** Stage-label constants — exported so the auto gate's stage FLOOR
 *  (gate/stage-floor.ts) observes stages from the label without string drift. */
export const TSC_STAGE_LABEL = "tsc --strict";
export const TYPE_AWARE_STAGE_LABEL = "type-aware async (tsforge)";

/** Content hash of the bundled strict config, read once per process. Folded into
 *  the cache key so editing/upgrading the shipped config file invalidates caches
 *  even when the tsforge version is unchanged (a dev iterating on the config). */
let strictConfigHash: string | null = null;

function configIdentity(): string {
  if (strictConfigHash === null) {
    let text = "missing";

    try {
      text = readFileSync(STRICT_CONFIG, "utf8");
    } catch {
      // Unresolvable config → the gate command will fail loudly on its own;
      // the sentinel just keeps the cache key stable and distinct.
    }

    strictConfigHash = Bun.hash(text).toString(36);
  }

  return strictConfigHash;
}

/** The eslint result cache path, KEYED BY the active ruleset + the toolchain
 *  identity. eslint caches on file content + the static config PATH — NOT the
 *  packs/overrides/conventions we inject via env (TSFORGE_PACKS, …), and not the
 *  rule IMPLEMENTATIONS. The auto gate can change packs mid-session (a greenfield
 *  project gains `react`), and a tsforge upgrade can change what a rule flags with
 *  an identical serialized config — either would let files cached under the weaker
 *  ruleset keep passing. Hashing the env prefix + tsforge version (which pins the
 *  bundled eslint) + the strict-config content into the filename means any of
 *  those changing → a fresh cache → a real re-lint, while an unchanged toolchain
 *  still hits the cache. */
function eslintCachePath(envPrefix: string): string {
  const key = Bun.hash(
    `v2:${currentVersion()}:${configIdentity()}:${envPrefix}`
  ).toString(36);

  return `${GATE_CACHE_DIR}/eslint-gate-${key}.cache`;
}

export async function buildGate(
  cwd: string,
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  options?: {
    enableTypeAware?: boolean;
    includeTests?: boolean;
    /** An explicit test command to use instead of re-discovering one. `undefined`
     *  discovers from the project (default); a string or `null` is used verbatim. The
     *  auto-gate passes its FROZEN command (captured once at session start) so a cycle
     *  can't re-discover a weaker one — e.g. a real suite swapped for a noop script. */
    testCommand?: string | null;
    conventions?: IConventions;
  }
): Promise<IGateSpec> {
  // Multi-repo workspace root: never eslint/test the whole bag from here.
  // Package-follow runs per touched child via the auto-gate runner.
  if (isWorkspaceContainer(cwd)) {
    return {
      command: "true",
      parts: ["true"],
      label: "workspace container (no root package.json)",
    };
  }

  const parts: string[] = [];
  const labels: string[] = [];

  const tsc = await tscPart(cwd);

  if (tsc !== null) {
    parts.push(tsc);
    labels.push(TSC_STAGE_LABEL);
  }

  // The syntactic lint pass caches per-file results under .tsforge/ (see
  // lintPart). Create the dir in-process — cross-platform and in the TARGET cwd
  // — rather than via a shell `mkdir` in the command: a lint-only project skips
  // tscPart (which otherwise makes the dir), and process.cwd() is not the gate's
  // cwd, so a builtin here would be both redundant and, if done in-code naively,
  // wrong-directory.
  mkdirSync(join(cwd, GATE_CACHE_DIR), { recursive: true });

  const lint = lintPart(packs, ruleOverrides, options?.conventions);

  parts.push(lint.command);
  labels.push(lint.label);

  if (options?.enableTypeAware === true) {
    const typeAware = await typeAwareLintPart(cwd);

    if (typeAware !== null) {
      parts.push(typeAware.command);
      labels.push(typeAware.label);
    }
  }

  // Tests run LAST (after the cheap static floor) so a type/lint error fails
  // fast without paying for a test run. Only appended when the project actually
  // has tests to run — a strict-floor-only run, or a project with none, skips it.
  if (options?.includeTests === true) {
    const test =
      options.testCommand === undefined
        ? await discoverTestGate(cwd)
        : { command: options.testCommand, notice: null };

    if (test.command !== null) {
      parts.push(test.command);
      labels.push("tests");
    } else if (test.notice !== null) {
      // Tests exist but are deliberately left out (watch-only script) — say so
      // in the gate identity instead of silently narrowing what "green" means.
      labels.push(test.notice);
    }
  }

  appendOptInOracles(parts, labels, process.env);

  // `parts` is returned alongside the joined command because `&&` is fail-fast
  // BY DESIGN here — the cheap static floor should reject before anything pays
  // for a test run — but that makes the error count of a failing gate "whatever
  // stage died first" rather than total residual. A caller that needs to MEASURE
  // residual errors, rather than gate on them, has to run every stage; it cannot
  // recover the stages from the joined string.
  return {
    command: parts.join(" && "),
    parts: [...parts],
    label: labels.join(" + "),
  };
}

/**
 * Opt-in quality oracles (default OFF, mirroring the web a11y/screenshot flags).
 * They run AFTER tests and read their own config from env, so the gate command
 * stays free of shell-quoting:
 *   - TSFORGE_COVERAGE=<pct> — fail if line coverage is below the floor.
 *   - TSFORGE_BOOT="<start cmd>" — boot the server and require a non-5xx response.
 *   - TSFORGE_PROPTEST=1 — fuzz exported functions from their types; fail if any
 *     throws on valid typed input.
 */
function appendOptInOracles(
  parts: string[],
  labels: string[],
  env: Record<string, string | undefined>
): void {
  if (env.TSFORGE_COVERAGE !== undefined && env.TSFORGE_COVERAGE.length > 0) {
    parts.push(`bun ${shellQuote(TEST_COVERAGE_CHECK)}`);
    labels.push("test coverage");
  }

  if (env.TSFORGE_BOOT !== undefined && env.TSFORGE_BOOT.trim().length > 0) {
    parts.push(`bun ${shellQuote(BOOT_CHECK)}`);
    labels.push("boot smoke");
  }

  if (env.TSFORGE_PROPTEST === "1") {
    parts.push(`bun ${shellQuote(PROPTEST_CHECK)}`);
    labels.push("property tests");
  }
}

/**
 * The core (non-web) auto-fix command — same janitor as buildWebFix but uses the
 * bundled strict.eslint.config.mjs. Run BEFORE the gate each cycle so padding-line,
 * prefer-const, curly, etc. are squashed without model turns.
 */
export function buildCoreFix(): string {
  const lintFix =
    `${shellQuote(ESLINT_BIN)} --no-config-lookup -c ${shellQuote(STRICT_CONFIG)} --fix .`.replace(
      /\s+/g,
      " "
    );
  const format = `${shellQuote(PRETTIER_BIN)} --write .`;

  return `${lintFix} ; ${format}`;
}

/** The syntactic idiom layer — ALWAYS tsforge's bundled strict eslint config
 *  (user policy). We deliberately do NOT defer to the project's own `lint`
 *  script: that's exactly how a weak repo would dodge the strict-TS floor. The
 *  bundled config needs no deps in the target. When packs are provided, they
 *  are passed via TSFORGE_PACKS env var so the config can load TS imports. Rule
 *  overrides are passed via TSFORGE_RULE_OVERRIDES (JSON-encoded map). */
function lintPart(
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  conventions?: IConventions
): IGateSpec {
  // Result caching is sound here because this pass is syntactic-only: a file's lint
  // result depends on that file alone plus the active ruleset. eslint keys cache entries
  // on file content + the static config path — NOT the packs/overrides we inject via env,
  // so the cache path is keyed by the ruleset (eslintCachePath) to stay correct when the
  // auto gate changes packs mid-session. The type-aware pass below must stay UNCACHED —
  // editing one file can change type errors in an untouched one. Every repair cycle
  // re-runs the gate, so on all but the first cycle this skips re-linting the (usually
  // vast) majority of unchanged files. buildGate creates the .tsforge/ dir before this runs.
  const envPrefix = packEnvPrefix(packs, ruleOverrides, conventions);

  return {
    // --cache-strategy content: the default (mtime+size) can serve a stale CLEAN
    // entry when the gate runs right after `--fix` + prettier rewrite files —
    // same-size same-mtime-tick rewrites are exactly this pipeline's hot path.
    // --no-error-on-unmatched-pattern: a folder with nothing to lint (research
    // notes, an empty greenfield dir) must pass, not exit 2 "all files ignored" —
    // that was counted as a gate error the model could never fix.
    command: `${envPrefix}bun ${shellQuote(ESLINT_BIN)} --no-config-lookup -c ${shellQuote(STRICT_CONFIG)} --no-error-on-unmatched-pattern --cache --cache-strategy content --cache-location ${shellQuote(eslintCachePath(envPrefix))} --format json .`,
    label: "strict TypeScript (tsforge)",
  };
}

/** Optional type-aware async rules — only when target has tsconfig.json. */
async function typeAwareLintPart(cwd: string): Promise<IGateSpec | null> {
  const hasTsconfig = await Bun.file(join(cwd, PROJECT_TSCONFIG)).exists();

  if (!hasTsconfig) {
    return null;
  }

  return {
    command: `bun ${shellQuote(ESLINT_BIN)} --no-config-lookup -c ${shellQuote(TYPE_AWARE_CONFIG)} --format json .`,
    label: TYPE_AWARE_STAGE_LABEL,
  };
}
