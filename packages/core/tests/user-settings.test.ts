/**
 * Settings live in ~/.tsforge/config.json (and a project's tsforge.config.json)
 * instead of a dozen TSFORGE_* variables typed at every launch; /config writes
 * them back so toggles survive restarts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSettings, type IConfigDeps } from "../src/cli/config-menu";
import {
  applySettings,
  configEnv,
  saveUserSetting,
  userConfigPath,
} from "../src/config/user-settings";

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tsf-settings-"));

  dirs.push(d);

  return d;
}

async function writeUser(home: string, config: unknown): Promise<void> {
  await mkdir(join(home, ".tsforge"), { recursive: true });
  await writeFile(userConfigPath(home), JSON.stringify(config));
}

describe("applySettings", () => {
  test("readable settings become their env variables", async () => {
    const home = await tempDir();

    await writeUser(home, {
      settings: {
        browser: true,
        searxngUrl: "http://searx.lan",
        webTools: false,
        maxTurns: 0,
      },
    });

    const env: Record<string, string | undefined> = {};

    applySettings(env, null, home);
    expect(env).toEqual({
      TSFORGE_BROWSER: "1",
      TSFORGE_SEARXNG_URL: "http://searx.lan",
      TSFORGE_WEB: "0",
      TSFORGE_MAX_TURNS: "0",
    });
  });

  test("project overrides user; a real env variable beats both", async () => {
    const home = await tempDir();
    const project = await tempDir();
    const projectConfig = join(project, "tsforge.config.json");

    await writeUser(home, {
      settings: { searxngUrl: "http://user.lan", browser: true },
    });
    await writeFile(
      projectConfig,
      JSON.stringify({ settings: { searxngUrl: "http://project.lan" } })
    );

    const env: Record<string, string | undefined> = { TSFORGE_BROWSER: "0" };
    const applied = applySettings(env, projectConfig, home);

    expect(env.TSFORGE_SEARXNG_URL).toBe("http://project.lan");
    expect(env.TSFORGE_BROWSER).toBe("0");
    expect(applied.has("TSFORGE_BROWSER")).toBe(false);
  });

  test("`env` passes through TSFORGE_* only; bad values and unknown names are ignored", () => {
    const out = configEnv({
      env: {
        TSFORGE_TDD: "0",
        PATH: "/evil",
        TSFORGE_TRACE: 1,
        tsforge_lower: "x",
      },
      settings: {
        browser: "yes",
        browserPort: 1.5,
        nonsense: true,
        compactAt: 0.7,
      },
    });

    expect([...out]).toEqual([
      ["TSFORGE_TDD", "0"],
      ["TSFORGE_TRACE", "1"],
      ["TSFORGE_COMPACT_AT", "0.7"],
    ]);
  });

  test("a missing or broken config file changes nothing", async () => {
    const home = await tempDir();

    await mkdir(join(home, ".tsforge"), { recursive: true });
    await writeFile(userConfigPath(home), "{ not json");

    const env: Record<string, string | undefined> = {};

    expect(applySettings(env, null, home).size).toBe(0);
    expect(applySettings(env, null, await tempDir()).size).toBe(0);
  });
});

describe("saveUserSetting", () => {
  test("keeps the rest of the file (keybindings) and can remove a setting", async () => {
    const home = await tempDir();

    await writeUser(home, {
      tui: { keybindings: { quit: "ctrl+q" } },
      settings: { webTools: true },
    });
    saveUserSetting("searxngUrl", "http://searx.lan", home);
    saveUserSetting("webTools", undefined, home);

    expect(JSON.parse(await readFile(userConfigPath(home), "utf8"))).toEqual({
      tui: { keybindings: { quit: "ctrl+q" } },
      settings: { searxngUrl: "http://searx.lan" },
    });
    expect(() => saveUserSetting("PATH", "x", home)).toThrow("unknown setting");
  });
});

function menuDeps(saved: [string, unknown][]): IConfigDeps {
  const env: Record<string, string | undefined> = {};

  return {
    color: false,
    suspend: () => undefined,
    resume: () => undefined,
    reconfigure: () => undefined,
    currentModelName: () => "m",
    onModelChange: () => undefined,
    currentMode: () => "default",
    setMode: () => undefined,
    getGate: () => "",
    setGate: () => undefined,
    getScope: () => "",
    setScope: () => undefined,
    getEnv: (name) => env[name],
    setEnv: (name, value) => {
      env[name] = value;
    },
    saveSetting: (name, value) => {
      saved.push([name, value]);
    },
  };
}

describe("/config saves", () => {
  test("web tools, Chrome and the SearXNG URL are persisted", async () => {
    const saved: [string, unknown][] = [];
    const items = buildSettings(menuDeps(saved));
    const find = (id: string) => items.find((i) => i.id === id);

    void find("tools.web")?.activate?.();
    void find("tools.web")?.activate?.();
    void find("tools.browser")?.activate?.();
    await find("tools.searxng")?.applyText?.({ url: " http://searx.lan " });
    await find("tools.searxng")?.applyText?.({ url: "" });

    expect(saved).toEqual([
      ["webTools", true],
      ["webTools", false],
      ["browser", true],
      ["searxngUrl", "http://searx.lan"],
      ["searxngUrl", undefined],
    ]);
  });
});
