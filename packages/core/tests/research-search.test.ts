/**
 * web_search / web_fetch as the hub of a research run: several phrasings per
 * call, every result naming the reader that suits it, already-read flags from
 * the topic's sources.md, and web_fetch handing plugin-owned URLs to the plugin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pacer, recordSource, webKey } from "../src/site-plugins";
import {
  setDirectFetchDeps,
  type IDirectFetchDeps,
} from "../src/site-plugins/direct-fetch";
import { doWebFetch, type IWebFetchDeps } from "../src/loop/tools/web-fetch";
import {
  doWebSearch,
  mergeRoundRobin,
  type IWebSearchDeps,
} from "../src/loop/tools/web-search";
import type { IToolContext } from "../src/loop/tools/tool-context";

const dirs: string[] = [];
const savedUrl = process.env.TSFORGE_SEARXNG_URL;

afterEach(async () => {
  if (savedUrl === undefined) {
    delete process.env.TSFORGE_SEARXNG_URL;
  } else {
    process.env.TSFORGE_SEARXNG_URL = savedUrl;
  }

  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function ctx(): Promise<IToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "tsf-search-"));

  dirs.push(cwd);

  return { cwd, files: [], task: "t", report: () => undefined };
}

function searx(results: { url: string; title: string }[]): string {
  return JSON.stringify({
    results: results.map((r) => ({ ...r, content: `about ${r.title}` })),
  });
}

function searchDeps(
  byQuery: Record<string, string>,
  seen: string[]
): IWebSearchDeps {
  return {
    fetchFn: async (url) => {
      seen.push(url);

      const q = new URL(url).searchParams.get("q") ?? "";

      return {
        ok: true,
        status: 200,
        text: async () => byQuery[q] ?? searx([]),
      };
    },
  };
}

describe("web_search", () => {
  test("several phrasings: merged round-robin, deduplicated, each with its reader", async () => {
    process.env.TSFORGE_SEARXNG_URL = "http://searx.lan";

    const seen: string[] = [];
    const out = await doWebSearch(
      { queries: ["guitar hum", "guitar buzz fix"], recency: "week" },
      await ctx(),
      searchDeps(
        {
          "guitar hum": searx([
            {
              url: "https://www.reddit.com/r/Guitar/comments/abc12/hum/",
              title: "Hum help",
            },
            { url: "https://blog.example.com/hum", title: "Blog hum" },
          ]),
          "guitar buzz fix": searx([
            {
              url: "https://electronics.stackexchange.com/questions/446302/buzz",
              title: "Buzz Q",
            },
            {
              url: "https://www.reddit.com/r/Guitar/comments/abc12/hum/",
              title: "Hum help (dup)",
            },
          ]),
        },
        seen
      )
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("time_range=week");
    expect(out.indexOf("Hum help")).toBeLessThan(out.indexOf("Buzz Q"));
    expect(out.indexOf("Buzz Q")).toBeLessThan(out.indexOf("Blog hum"));
    expect(out).not.toContain("(dup)");
    expect(out).toContain('→ reddit_thread post:"abc12"');
    expect(out).toContain('→ se_question question:"446302" site:"electronics"');
    expect(out).toContain("→ web_fetch");
  });

  test("results already logged for the topic are flagged", async () => {
    process.env.TSFORGE_SEARXNG_URL = "http://searx.lan";

    const c = await ctx();

    await recordSource(
      c.cwd,
      "t",
      { site: "reddit", id: "abc12", title: "x", url: "u", meta: "m" },
      new Date()
    );
    await recordSource(
      c.cwd,
      "t",
      {
        site: "web",
        id: webKey("https://blog.example.com/hum").slice(4),
        title: "x",
        url: "u",
        meta: "m",
      },
      new Date()
    );

    const out = await doWebSearch(
      { query: "guitar hum", topic: "t" },
      c,
      searchDeps(
        {
          "guitar hum": searx([
            {
              url: "https://www.reddit.com/r/Guitar/comments/abc12/hum/",
              title: "Hum help",
            },
            { url: "https://blog.example.com/hum", title: "Blog hum" },
            {
              url: "https://news.ycombinator.com/item?id=4214",
              title: "HN hum",
            },
          ]),
        },
        []
      )
    );

    expect(out).toContain('→ reddit_thread post:"abc12" · already read');
    expect(out).toContain("→ web_fetch · already read");
    expect(out).toMatch(/→ hn_thread item:"4214"(?! · already read)/u);
  });

  test("round-robin merge interleaves lists", () => {
    const r = (u: string) => ({ url: u, title: u, snippet: "" });

    expect(
      mergeRoundRobin([[r("a1"), r("a2"), r("a3")], [r("b1")]]).map(
        (x) => x.url
      )
    ).toEqual(["a1", "b1", "a2", "a3"]);
  });
});

function page(html: string): IWebFetchDeps {
  return {
    fetchFn: async () => ({ ok: true, status: 200, text: async () => html }),
    extract: async () => "# Fixing guitar hum\n\nGround the bridge.",
  };
}

describe("web_fetch", () => {
  test("an ordinary page read for a topic is logged, then refused unless forced", async () => {
    const c = await ctx();
    const url = "https://blog.example.com/hum?utm_source=x";

    expect(await doWebFetch({ url, topic: "t" }, c, page("<p/>"))).toContain(
      "Ground the bridge"
    );
    expect(await readFile(join(c.cwd, "notes/t/sources.md"), "utf8")).toContain(
      `- [${webKey(url)}] Fixing guitar hum — ${url}`
    );
    expect(
      await doWebFetch(
        { url: "https://blog.example.com/hum", topic: "t" },
        c,
        page("<p/>")
      )
    ).toContain("already read");
    expect(
      await doWebFetch({ url, topic: "t", force: true }, c, page("<p/>"))
    ).toContain("Ground the bridge");
  });

  test("without a topic nothing is logged, and a plugin URL gets a tip", async () => {
    const c = await ctx();
    const out = await doWebFetch(
      { url: "https://news.ycombinator.com/item?id=4214" },
      c,
      page("<p/>")
    );

    expect(out).toContain('Tip: hn_thread item:"4214"');
    await expect(
      readFile(join(c.cwd, "notes/t/sources.md"), "utf8")
    ).rejects.toThrow();
  });

  describe("a plugin-owned URL with a topic", () => {
    let prev: IDirectFetchDeps;
    const calls: string[] = [];

    beforeEach(() => {
      calls.length = 0;
      prev = setDirectFetchDeps({
        pacer: new Pacer(0, { now: () => 0, sleep: async () => undefined }),
        fetch: async (url) => {
          calls.push(url);

          return new Response(
            JSON.stringify({
              id: 4214,
              type: "story",
              author: "pg",
              title: "HN title",
              url: "",
              points: 3,
              created_at_i: 1,
              text: "",
              children: [],
            }),
            { status: 200 }
          );
        },
      });
    });

    afterEach(() => {
      setDirectFetchDeps(prev);
    });

    test("is read by the plugin, not scraped", async () => {
      const c = await ctx();
      let scraped = false;
      const out = await doWebFetch(
        { url: "https://news.ycombinator.com/item?id=4214", topic: "t" },
        c,
        {
          fetchFn: async () => {
            scraped = true;

            return { ok: true, status: 200, text: async () => "" };
          },
          extract: async () => "",
        }
      );

      expect(scraped).toBe(false);
      expect(calls).toEqual(["https://hn.algolia.com/api/v1/items/4214"]);
      expect(out).toContain("# [HN] HN title");
      expect(
        await readFile(join(c.cwd, "notes/t/sources.md"), "utf8")
      ).toContain("[hn:4214]");
    });
  });
});
