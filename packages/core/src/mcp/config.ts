import { isRecord } from "../lib/guards";
import type { IMcpServerConfig } from "./mcp.types";

/** MCP server keys the curated Linear/Notion/Sentry integrations require. */
const INTEGRATION_MCP_KEYS = ["linear", "notion", "sentry"] as const;

type EnvLookup = Readonly<Record<string, string | undefined>>;

/** Interpolate `${VAR}` references from `env` into a string (missing → ""). */
export function interpolateEnv(value: string, env: EnvLookup): string {
  return value.replace(
    /\$\{([A-Za-z0-9_]+)\}/g,
    (_match: string, name: string) => env[name] ?? ""
  );
}

function stringArray(value: unknown, env: EnvLookup): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => interpolateEnv(item, env));

  return out.length > 0 ? out : undefined;
}

function envRecord(
  value: unknown,
  env: EnvLookup
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      out[key] = interpolateEnv(raw, env);
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse one server entry, applying env interpolation. Returns null if the entry
 *  is malformed or missing the field its transport requires. */
function parseOne(value: unknown, env: EnvLookup): IMcpServerConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = value.type === "http" ? "http" : "stdio";
  const command =
    typeof value.command === "string"
      ? interpolateEnv(value.command, env)
      : undefined;
  const url =
    typeof value.url === "string" ? interpolateEnv(value.url, env) : undefined;
  const timeoutMs =
    typeof value.timeoutMs === "number" && value.timeoutMs > 0
      ? value.timeoutMs
      : undefined;

  if (type === "stdio" && (command === undefined || command.length === 0)) {
    return null;
  }

  if (type === "http" && (url === undefined || url.length === 0)) {
    return null;
  }

  return {
    type,
    command,
    args: stringArray(value.args, env),
    env: envRecord(value.env, env),
    url,
    timeoutMs,
  };
}

/**
 * Parse the `mcpServers` block of tsforge.config.json into validated configs,
 * keyed by server name. Malformed or incomplete entries are dropped (the loader
 * warns); a missing/invalid block yields {}.
 */
export function parseMcpServers(
  raw: unknown,
  env: EnvLookup
): Record<string, IMcpServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }

  const servers: Record<string, IMcpServerConfig> = {};

  for (const [name, value] of Object.entries(raw)) {
    const parsed = parseOne(value, env);

    if (parsed !== null) {
      servers[name] = parsed;
    }
  }

  return servers;
}

/** Merge the global (`~/.tsforge/models.json`) and project (`tsforge.config.json`)
 *  `mcpServers` blocks, keyed by server name. A project entry overrides a global
 *  entry of the same name; names unique to either side pass through untouched. */
export function mergeMcpServers(
  global: Readonly<Record<string, IMcpServerConfig>>,
  project: Readonly<Record<string, IMcpServerConfig>>
): Record<string, IMcpServerConfig> {
  return { ...global, ...project };
}

/** Scan a string for `${VAR}` refs that are unset or empty in `env`. */
function emptyEnvRefs(original: string, env: EnvLookup): string[] {
  const missing: string[] = [];
  const re = /\$\{([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null = re.exec(original);

  while (match !== null) {
    const name = match[1] ?? "";
    const value = env[name];

    if (value === undefined || value.length === 0) {
      missing.push(name);
    }

    match = re.exec(original);
  }

  return missing;
}

function scanRecordEnv(
  record: Record<string, unknown> | undefined,
  env: EnvLookup,
  prefix: string,
  warnings: string[]
): void {
  if (record === undefined) {
    return;
  }

  for (const [key, rawVal] of Object.entries(record)) {
    if (typeof rawVal !== "string") {
      continue;
    }

    for (const varName of emptyEnvRefs(rawVal, env)) {
      warnings.push(
        `${prefix} env.${key}: \${${varName}} is unset or empty — the MCP server may start without credentials.`
      );
    }
  }
}

function scanStringField(
  original: string | undefined,
  env: EnvLookup,
  label: string,
  warnings: string[]
): void {
  if (original === undefined) {
    return;
  }

  for (const varName of emptyEnvRefs(original, env)) {
    warnings.push(
      `${label}: \${${varName}} is unset or empty — the MCP server may start misconfigured.`
    );
  }
}

function integrationNamingWarnings(
  parsed: Record<string, IMcpServerConfig>
): string[] {
  const warnings: string[] = [];
  const keys = new Set(Object.keys(parsed));

  for (const expected of INTEGRATION_MCP_KEYS) {
    if (!keys.has(expected)) {
      const near = Object.keys(parsed).filter((k) =>
        k.toLowerCase().includes(expected)
      );

      if (near.length > 0) {
        warnings.push(
          `mcpServers: integration "${expected}" must be keyed exactly "${expected}" (found: ${near.join(", ")}) — curated ${expected}_* tools stay disabled.`
        );
      }
    }
  }

  if (INTEGRATION_MCP_KEYS.every((s) => !keys.has(s))) {
    warnings.push(
      `mcpServers: no integration keys (${INTEGRATION_MCP_KEYS.join(", ")}) — Linear/Notion/Sentry curated tools need servers keyed exactly those names.`
    );
  }

  return warnings;
}

function scanArgsEnv(
  args: unknown,
  env: EnvLookup,
  prefix: string,
  warnings: string[]
): void {
  if (!Array.isArray(args)) {
    return;
  }

  for (const [i, entry] of args.entries()) {
    if (typeof entry !== "string") {
      continue;
    }

    for (const varName of emptyEnvRefs(entry, env)) {
      warnings.push(
        `${prefix}.args[${String(i)}]: \${${varName}} is unset or empty.`
      );
    }
  }
}

function scanOneMcpServerEntry(
  name: string,
  value: Record<string, unknown>,
  env: EnvLookup,
  warnings: string[]
): void {
  const prefix = `mcpServers.${name}`;

  scanStringField(
    typeof value.command === "string" ? value.command : undefined,
    env,
    `${prefix}.command`,
    warnings
  );
  scanStringField(
    typeof value.url === "string" ? value.url : undefined,
    env,
    `${prefix}.url`,
    warnings
  );
  scanRecordEnv(
    isRecord(value.env) ? value.env : undefined,
    env,
    prefix,
    warnings
  );
  scanArgsEnv(value.args, env, prefix, warnings);
}

/**
 * Config-time diagnostics for MCP servers: empty env interpolation and
 * integration server naming (Linear/Notion/Sentry require exact keys).
 */
export function diagnoseMcpServers(
  raw: unknown,
  parsed: Record<string, IMcpServerConfig>,
  env: EnvLookup
): string[] {
  if (!isRecord(raw) || Object.keys(parsed).length === 0) {
    return [];
  }

  const warnings = integrationNamingWarnings(parsed);

  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value) || parsed[name] === undefined) {
      continue;
    }

    scanOneMcpServerEntry(name, value, env, warnings);
  }

  return warnings;
}

/** Where config diagnostics go. Null ⇒ stderr, the right default for headless
 *  and one-shot runs. The REPL points this at its boot buffer so the warnings
 *  land inside the pane console instead of being wiped by its first paint —
 *  set here rather than imported from cli/ to keep the dependency one-way. */
let diagnosticSink: ((text: string) => void) | null = null;

export function setMcpDiagnosticSink(
  sink: ((text: string) => void) | null
): void {
  diagnosticSink = sink;
}

/** Emit MCP config diagnostics (load-time footgun prevention). */
export function warnMcpConfigIssues(
  raw: unknown,
  parsed: Record<string, IMcpServerConfig>,
  env: EnvLookup
): void {
  const write =
    diagnosticSink ?? ((text: string) => process.stderr.write(text));

  for (const line of diagnoseMcpServers(raw, parsed, env)) {
    write(`  ⚠ ${line}\n`);
  }
}
