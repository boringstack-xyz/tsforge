import { test, expect, afterEach } from "bun:test";
import {
  callFirst,
  isMcpError,
  asList,
  field,
  resolveMcpCapability,
  suppressCuratedSchemas,
  type IIntegrationRegistry,
} from "../src/loop/tools/integration-common";
import { suppressedIntegrationServers } from "../src/loop/tools/integration-servers";

afterEach(() => {
  delete process.env.TSFORGE_LINEAR_RAW;
  delete process.env.TSFORGE_NOTION_RAW;
  delete process.env.TSFORGE_SENTRY_RAW;
});

function reg(exposed: string[]): IIntegrationRegistry {
  return {
    has: (name) => exposed.includes(name),
    callTool: async () => "ok",
  };
}

test("callFirst uses the first candidate the server exposes", async () => {
  const r = reg(["mcp__x__save_issue"]); // only the second alias exists
  const res = await callFirst(r, "x", ["create_issue", "save_issue"], {});

  expect(res).toEqual({ text: "ok" });
});

test("callFirst returns a clear error when no candidate exists", async () => {
  const res = await callFirst(reg([]), "x", ["a", "b"], {});

  expect("error" in res && res.error).toContain("exposes none of: a, b");
});

test("callFirst surfaces an MCP sentinel string as an error", async () => {
  const r: IIntegrationRegistry = {
    has: () => true,
    callTool: async () => "unknown MCP tool: x",
  };
  const res = await callFirst(r, "x", ["a"], {});

  expect("error" in res).toBe(true);
});

test("isMcpError detects sentinels and empties", () => {
  expect(isMcpError("unknown MCP tool: x")).toBe(true);
  expect(isMcpError("MCP tool 'x' failed")).toBe(true);
  expect(isMcpError("   ")).toBe(true);
  expect(isMcpError('{"ok":true}')).toBe(false);
});

test("asList unwraps common list shapes", () => {
  expect(asList([1, 2])).toHaveLength(2);
  expect(asList({ results: [1] })).toHaveLength(1);
  expect(asList({ issues: [1, 2, 3] })).toHaveLength(3);
  expect(asList({ nope: 1 })).toHaveLength(0);
});

test("field returns the first present string/number key", () => {
  expect(field({ a: "", b: "hit" }, "a", "b")).toBe("hit");
  expect(field({ n: 7 }, "n")).toBe("7");
  expect(field({}, "x")).toBe("");
});

test("resolveMcpCapability: connected server + not killed", () => {
  const registry = { serverNames: () => ["linear", "notion"] };

  expect(resolveMcpCapability(registry, "notion", false)).toBe(true);
  expect(resolveMcpCapability(registry, "sentry", false)).toBe(false);
  expect(resolveMcpCapability(registry, "notion", true)).toBe(false); // killed
  expect(resolveMcpCapability(null, "notion", false)).toBe(false);
});

test("suppressCuratedSchemas trims only the named servers", () => {
  const s = (name: string) => ({
    type: "function" as const,
    function: { name, description: "", parameters: {} },
  });
  const schemas = [
    s("mcp__linear__a"),
    s("mcp__notion__b"),
    s("mcp__sentry__c"),
  ];

  expect(
    suppressCuratedSchemas(schemas, ["linear", "sentry"]).map(
      (x) => x.function.name
    )
  ).toEqual(["mcp__notion__b"]);
  expect(suppressCuratedSchemas(schemas, [])).toHaveLength(3);
});

test("suppressedIntegrationServers: full toolsets are offered by default", () => {
  // The curated verbs are shortcuts, not a cap: with every capability on,
  // nothing is hidden — hiding it left the agent unable to do most of Linear.
  expect(
    suppressedIntegrationServers({
      linear: true,
      notion: true,
      sentry: true,
      twenty: true,
    })
  ).toEqual([]);

  // TSFORGE_<NAME>_RAW=0 opts one server back into curated-only
  process.env.TSFORGE_NOTION_RAW = "0";
  expect(
    suppressedIntegrationServers({ linear: true, notion: true, sentry: true })
  ).toEqual(["notion"]);

  // any other value keeps it offered
  process.env.TSFORGE_NOTION_RAW = "1";
  expect(suppressedIntegrationServers({ notion: true })).toEqual([]);

  // off capabilities are never suppressed
  process.env.TSFORGE_NOTION_RAW = "0";
  expect(suppressedIntegrationServers({})).toEqual([]);
});
