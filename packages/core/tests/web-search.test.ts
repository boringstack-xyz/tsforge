import { test, expect, afterEach } from "bun:test";
import {
  parseDuckDuckGoResults,
  formatResults,
  filterPublicResults,
  doWebSearch,
  type IWebSearchDeps,
} from "../src/loop/tools/web-search";
import type { IToolContext } from "../src/loop/tools/execute-tool";

const ctx = (): IToolContext => ({
  cwd: ".",
  files: [],
  task: "t",
  report: () => undefined,
});

// A trimmed sample of DuckDuckGo's HTML result markup: the first link uses the
// `uddg=` redirect wrapper (which must be decoded back to the real URL), the
// second is a direct href.
const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">TypeScript <b>Docs</b></a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The official <b>handbook</b>.</a>
</div>
<div class="result">
  <a class="result__a" href="https://other.com">Other</a>
  <a class="result__snippet">second snippet</a>
</div>`;

const deps = (over: Partial<IWebSearchDeps>): IWebSearchDeps => ({
  fetchFn: async () => ({ ok: true, status: 200, text: async () => DDG_HTML }),
  ...over,
});

afterEach(() => {
  delete process.env.TSFORGE_SEARXNG_URL;
  delete process.env.TSFORGE_WEB_SEARCH_BACKEND;
});

test("parseDuckDuckGoResults extracts title, decoded url, and snippet", () => {
  const r = parseDuckDuckGoResults(DDG_HTML);

  expect(r.length).toBe(2);
  expect(r[0]?.title).toBe("TypeScript Docs");
  expect(r[0]?.url).toBe("https://example.com/docs");
  expect(r[0]?.snippet).toContain("handbook");
  expect(r[1]?.url).toBe("https://other.com");
});

test("formatResults lists each result with title, url, and snippet", () => {
  const out = formatResults([
    { title: "Foo", url: "https://a.com", snippet: "about foo" },
  ]);

  expect(out).toContain("Foo");
  expect(out).toContain("https://a.com");
  expect(out).toContain("about foo");
});

test("formatResults honors a caller-supplied result limit", () => {
  const out = formatResults(
    [
      { title: "One", url: "https://one.com", snippet: "" },
      { title: "Two", url: "https://two.com", snippet: "" },
    ],
    1
  );

  expect(out).toContain("One");
  expect(out).not.toContain("Two");
});

test("formatResults reports when there are no results", () => {
  expect(formatResults([]).toLowerCase()).toContain("no results");
});

test("filterPublicResults drops unsafe and duplicate URLs", () => {
  const out = filterPublicResults([
    { title: "public", url: "https://example.com/a", snippet: "" },
    { title: "private", url: "http://localhost:3000", snippet: "" },
    { title: "dupe", url: "https://example.com/a", snippet: "" },
  ]);

  expect(out.map((r) => r.title)).toEqual(["public"]);
});

test("doWebSearch rejects an empty query without touching the network", async () => {
  let called = false;
  const r = await doWebSearch(
    { query: "" },
    ctx(),
    deps({
      fetchFn: async () => {
        called = true;

        throw new Error("should not be called");
      },
    })
  );

  expect(called).toBe(false);
  expect(r).toContain("web_search");
});

test("doWebSearch returns formatted results from the free DuckDuckGo backend (no key)", async () => {
  const r = await doWebSearch({ query: "typescript docs" }, ctx(), deps({}));

  expect(r).toContain("https://example.com/docs");
  expect(r).toContain("https://other.com");
});

test("doWebSearch passes recency and domain scope to DuckDuckGo", async () => {
  let requested = "";

  await doWebSearch(
    {
      query: "typescript decorators",
      recency: "month",
      domains: ["typescriptlang.org", "devblogs.microsoft.com/typescript"],
    },
    ctx(),
    deps({
      fetchFn: async (url) => {
        requested = url;

        return { ok: true, status: 200, text: async () => DDG_HTML };
      },
    })
  );

  const url = new URL(requested);
  const query = url.searchParams.get("q") ?? "";

  expect(url.searchParams.get("df")).toBe("m");
  expect(query).toContain("typescript decorators");
  expect(query).toContain("site:typescriptlang.org");
  expect(query).toContain("site:devblogs.microsoft.com");
});

test("doWebSearch rejects invalid recency and domains without touching the network", async () => {
  let called = false;
  const badRecency = await doWebSearch(
    { query: "typescript", recency: "hour" },
    ctx(),
    deps({
      fetchFn: async () => {
        called = true;

        throw new Error("should not be called");
      },
    })
  );
  const badDomain = await doWebSearch(
    { query: "typescript", domains: "localhost" },
    ctx(),
    deps({
      fetchFn: async () => {
        called = true;

        throw new Error("should not be called");
      },
    })
  );

  expect(called).toBe(false);
  expect(badRecency).toContain("recency");
  expect(badDomain).toContain("domains");
});

test("doWebSearch reports an HTTP error status gracefully", async () => {
  const r = await doWebSearch(
    { query: "x" },
    ctx(),
    deps({
      fetchFn: async () => ({ ok: false, status: 503, text: async () => "" }),
    })
  );

  expect(r).toContain("503");
});

test("doWebSearch routes to a self-hosted SearXNG instance when TSFORGE_SEARXNG_URL is set", async () => {
  process.env.TSFORGE_SEARXNG_URL = "http://localhost:8888";
  let requested = "";
  const json = JSON.stringify({
    results: [{ title: "S", url: "https://s.com", content: "searx snippet" }],
  });
  const r = await doWebSearch(
    { query: "rust" },
    ctx(),
    deps({
      fetchFn: async (u) => {
        requested = u;

        return { ok: true, status: 200, text: async () => json };
      },
    })
  );

  expect(requested).toContain("localhost:8888");
  expect(requested).toContain("format=json");
  expect(r).toContain("https://s.com");
  expect(r).toContain("searx snippet");
});

test("doWebSearch can require SearXNG and fail closed instead of falling back to DuckDuckGo", async () => {
  process.env.TSFORGE_WEB_SEARCH_BACKEND = "searxng";
  let called = false;
  const r = await doWebSearch(
    { query: "typescript" },
    ctx(),
    deps({
      fetchFn: async () => {
        called = true;

        throw new Error("should not be called");
      },
    })
  );

  expect(called).toBe(false);
  expect(r).toContain("TSFORGE_SEARXNG_URL");
});

test("doWebSearch rejects an invalid search backend before network", async () => {
  process.env.TSFORGE_WEB_SEARCH_BACKEND = "local";
  let called = false;
  const r = await doWebSearch(
    { query: "typescript" },
    ctx(),
    deps({
      fetchFn: async () => {
        called = true;

        throw new Error("should not be called");
      },
    })
  );

  expect(called).toBe(false);
  expect(r).toContain("TSFORGE_WEB_SEARCH_BACKEND");
});

test("doWebSearch can force DuckDuckGo even when a SearXNG URL is present", async () => {
  process.env.TSFORGE_SEARXNG_URL = "http://localhost:8888";
  process.env.TSFORGE_WEB_SEARCH_BACKEND = "duckduckgo";
  let requested = "";

  await doWebSearch(
    { query: "typescript" },
    ctx(),
    deps({
      fetchFn: async (url) => {
        requested = url;

        return { ok: true, status: 200, text: async () => DDG_HTML };
      },
    })
  );

  expect(requested).toContain("duckduckgo.com");
  expect(requested).not.toContain("localhost:8888");
});

test("doWebSearch passes recency to SearXNG and applies maxResults", async () => {
  process.env.TSFORGE_SEARXNG_URL = "http://localhost:8888";
  let requested = "";
  const json = JSON.stringify({
    results: [
      { title: "Fresh", url: "https://fresh.com", content: "new" },
      { title: "Old", url: "https://old.com", content: "old" },
    ],
  });
  const r = await doWebSearch(
    { query: "typescript 6", recency: "day", maxResults: 1 },
    ctx(),
    deps({
      fetchFn: async (url) => {
        requested = url;

        return { ok: true, status: 200, text: async () => json };
      },
    })
  );

  const url = new URL(requested);

  expect(url.searchParams.get("time_range")).toBe("day");
  expect(r).toContain("Fresh");
  expect(r).not.toContain("Old");
});
