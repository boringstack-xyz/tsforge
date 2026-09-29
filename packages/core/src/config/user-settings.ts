/**
 * Persistent settings, so nobody has to remember a dozen TSFORGE_* variables.
 *
 *   ~/.tsforge/config.json            user-wide  { "settings": {…}, "env": {…} }
 *   tsforge.config.json (project)     overrides the user file, same two blocks
 *   real environment variables        win over both (nothing existing changes)
 *
 * `settings` uses readable names (browser, searxngUrl, …) mapped to their env
 * variable below; `env` passes any other TSFORGE_* variable through. Both are
 * applied to process.env once at startup, before anything reads a flag
 * (config/flags.ts reads process.env live).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../lib/guards/guards";
import { ENV_FLAG } from "./config.constants";

type SettingKind = "bool" | "string" | "int" | "number";

interface ISettingDef {
  env: string;
  kind: SettingKind;
  describe: string;
}

/** Readable setting name → the env variable it sets. */
export const SETTINGS: Readonly<Record<string, ISettingDef>> = {
  browser: {
    env: ENV_FLAG.browser,
    kind: "bool",
    describe: "Chrome research bridge (the tsforge extension)",
  },
  browserPort: {
    env: ENV_FLAG.browserPort,
    kind: "int",
    describe: "bridge port (default 47823)",
  },
  browserAllowPrivate: {
    env: ENV_FLAG.browserAllowPrivate,
    kind: "bool",
    describe: "let browser tools open private/LAN hosts",
  },
  webTools: {
    env: ENV_FLAG.webTools,
    kind: "bool",
    describe: "web_fetch / web_search / hn_* / se_* tools",
  },
  searxngUrl: {
    env: "TSFORGE_SEARXNG_URL",
    kind: "string",
    describe: "your SearXNG instance for web_search, e.g. http://searx.lan",
  },
  searchBackend: {
    env: "TSFORGE_WEB_SEARCH_BACKEND",
    kind: "string",
    describe: "duckduckgo | searxng",
  },
  stackExchangeKey: {
    env: ENV_FLAG.stackExchangeKey,
    kind: "string",
    describe: "Stack Exchange API key (10,000 requests/day)",
  },
  chatwootUrl: {
    env: ENV_FLAG.chatwootUrl,
    kind: "string",
    describe: "your Chatwoot instance, e.g. https://support.example.com",
  },
  chatwootToken: {
    env: ENV_FLAG.chatwootToken,
    kind: "string",
    describe: "Chatwoot access token (Profile settings → Access token)",
  },
  chatwootAccountId: {
    env: ENV_FLAG.chatwootAccountId,
    kind: "int",
    describe: "Chatwoot account id (the number in /app/accounts/<id>/)",
  },
  maxTurns: {
    env: ENV_FLAG.maxTurns,
    kind: "int",
    describe: "turn cap per message (0 = unlimited)",
  },
  compactAt: {
    env: "TSFORGE_COMPACT_AT",
    kind: "number",
    describe: "auto-compact threshold (0–1)",
  },
};

/** Only tsforge's own variables may come from a config file (not PATH, …). */
const PASSTHROUGH_RE = /^TSFORGE_[A-Z0-9_]+$/u;

/** `$TSFORGE_HOME` when set (tests, sandboxes), else the real home dir. */
function tsforgeHome(): string {
  return process.env.TSFORGE_HOME ?? homedir();
}

export function userConfigPath(home: string = tsforgeHome()): string {
  return join(home, ".tsforge", "config.json");
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A setting value as its env string, or null when it doesn't fit its kind. */
export function settingToEnv(kind: SettingKind, value: unknown): string | null {
  switch (kind) {
    case "bool":
      return typeof value === "boolean" ? (value ? "1" : "0") : null;
    case "string":
      return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
    case "int":
      return typeof value === "number" && Number.isInteger(value)
        ? String(value)
        : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : null;
  }
}

/** The env assignments one config file asks for (`settings` + `env`). */
export function configEnv(
  config: Record<string, unknown> | null
): Map<string, string> {
  const out = new Map<string, string>();

  if (config === null) {
    return out;
  }

  const env = isRecord(config.env) ? config.env : {};

  for (const [name, value] of Object.entries(env)) {
    if (
      PASSTHROUGH_RE.test(name) &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    ) {
      out.set(
        name,
        typeof value === "boolean" ? (value ? "1" : "0") : String(value)
      );
    }
  }

  const settings = isRecord(config.settings) ? config.settings : {};

  for (const [name, value] of Object.entries(settings)) {
    const def = SETTINGS[name];
    const env = def === undefined ? null : settingToEnv(def.kind, value);

    if (def !== undefined && env !== null) {
      out.set(def.env, env);
    }
  }

  return out;
}

/**
 * Apply user + project settings to `env` for every variable that is NOT
 * already set (a real environment variable always wins). Returns what was
 * applied, for the boot log.
 */
export function applySettings(
  env: Record<string, string | undefined>,
  projectConfigPath: string | null,
  home: string = tsforgeHome()
): Map<string, string> {
  const merged = configEnv(readJson(userConfigPath(home)));

  for (const [k, v] of configEnv(
    projectConfigPath === null ? null : readJson(projectConfigPath)
  )) {
    merged.set(k, v);
  }

  const applied = new Map<string, string>();

  for (const [k, v] of merged) {
    if (env[k] === undefined) {
      env[k] = v;
      applied.set(k, v);
    }
  }

  return applied;
}

/**
 * Save one readable setting to ~/.tsforge/config.json (undefined removes it),
 * keeping everything else in the file (keybindings, other settings). Used by
 * the /config menu so a toggle survives restarts.
 */
export function saveUserSetting(
  name: string,
  value: boolean | string | number | undefined,
  home: string = tsforgeHome()
): void {
  if (SETTINGS[name] === undefined) {
    throw new Error(`unknown setting "${name}"`);
  }

  const path = userConfigPath(home);
  const config = readJson(path) ?? {};
  const current = isRecord(config.settings) ? config.settings : {};
  const others = Object.entries(current).filter(([key]) => key !== name);
  const settings = Object.fromEntries(
    value === undefined ? others : [...others, [name, value]]
  );

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...config, settings }, null, 2)}\n`);
}
