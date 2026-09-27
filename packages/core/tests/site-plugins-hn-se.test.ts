import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pacer, routeUrl, sitePluginTools, webKey } from "../src/site-plugins";
import {
  directFetchJson,
  setDirectFetchDeps,
  type IDirectFetchDeps,
} from "../src/site-plugins/direct-fetch";
import { createHnHandlers, type IHnDeps } from "../src/site-plugins/hackernews";
import {
  parseItemId,
  searchPath as hnSearchPath,
} from "../src/site-plugins/hackernews/hn.urls";
import {
  createSeHandlers,
  type ISeDeps,
} from "../src/site-plugins/stackexchange";
import {
  parseQuestionRef,
  parseSite,
  searchPath as seSearchPath,
} from "../src/site-plugins/stackexchange/se.urls";
import type { FetchOutcome, ISitePluginContext } from "../src/site-plugins";

const NOW = new Date(1_790_000_000 * 1000);
const DAY = 86_400;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function ctx(): Promise<ISitePluginContext> {
  const cwd = await mkdtemp(join(tmpdir(), "tsf-hnse-"));

  dirs.push(cwd);

  return { stateKey: {}, cwd, progress: () => undefined };
}

// ── fixtures (shaped from the live APIs) ─────────────────────────────────────

function hnItem(): unknown {
  const t = 1_790_000_000 - 30 * DAY;

  return {
    id: 4214,
    type: "story",
    author: "pg",
    title: "Ask HN: Guitar wiring tools?",
    url: "",
    points: 120,
    created_at_i: t,
    text: "<p>What do you use to <i>plan</i> pickup wiring?</p>",
    children: [
      {
        id: 1,
        type: "comment",
        author: "alice",
        text: '<p>I sketch it, then check with a <a href="https://x.test">multimeter</a>.</p>',
        created_at_i: t,
        points: null,
        children: [
          {
            id: 2,
            type: "comment",
            author: "bob",
            text: "<p>Same, plus <code>DIYLC</code>.</p>",
            created_at_i: t,
            children: [],
          },
        ],
      },
      {
        id: 3,
        type: "comment",
        author: null,
        text: null,
        created_at_i: t,
        children: [],
      },
      {
        id: 4,
        type: "comment",
        author: null,
        text: null,
        created_at_i: t,
        children: [
          {
            id: 5,
            type: "comment",
            author: "carol",
            text: "<p>orphan reply</p>",
            created_at_i: t,
            children: [],
          },
        ],
      },
    ],
  };
}

function hnSearch(): unknown {
  return {
    hits: [
      {
        objectID: "4214",
        title: "Ask HN: Guitar wiring tools?",
        url: "",
        points: 120,
        num_comments: 4,
        created_at_i: 1_790_000_000 - DAY,
        author: "pg",
      },
      {
        objectID: "99",
        title: "Show HN: Pickup wiring diagrams",
        url: "https://www.example.com/x",
        points: 55,
        num_comments: 12,
        created_at_i: 1_790_000_000 - 2 * DAY,
        author: "d",
      },
    ],
    page: 0,
    nbPages: 2,
  };
}

function seQuestion(): unknown {
  return {
    items: [
      {
        question_id: 446302,
        title: "Guitar pickup &quot;hot&quot; wire?",
        score: 7,
        answer_count: 2,
        accepted_answer_id: 11,
        tags: ["guitar", "wiring"],
        link: "https://electronics.stackexchange.com/questions/446302/guitar-pickup-hot-wire",
        creation_date: 1_790_000_000 - 400 * DAY,
        owner: { display_name: "Jos&#233;" },
        body: "<p>Which wire is hot?</p><pre><code>red  -&gt; hot</code></pre>",
      },
    ],
    has_more: false,
    quota_max: 300,
    quota_remaining: 290,
  };
}

function seAnswers(): unknown {
  return {
    items: [
      {
        answer_id: 10,
        score: 9,
        is_accepted: false,
        creation_date: 1_790_000_000 - 300 * DAY,
        owner: { display_name: "top" },
        body: "<p>Most votes answer.</p>",
      },
      {
        answer_id: 11,
        score: 4,
        is_accepted: true,
        creation_date: 1_790_000_000 - 390 * DAY,
        owner: { display_name: "acc" },
        body: "<p>Accepted answer.</p>",
      },
    ],
    has_more: false,
    quota_remaining: 40,
    backoff: 3,
  };
}

// ── Hacker News ──────────────────────────────────────────────────────────────

describe("hacker news", () => {
  test("item ids from ids and item URLs only", () => {
    expect(parseItemId("8863")).toBe(8863);
    expect(parseItemId("https://news.ycombinator.com/item?id=8863")).toBe(8863);
    expect(parseItemId("https://evil.test/item?id=8863")).toBeNull();
    expect(parseItemId("abc")).toBeNull();
  });

  test("search path: sort, type and a time window", () => {
    const path = hnSearchPath(
      { query: "guitar wiring", sort: "date", time: "week", limit: 99 },
      1_790_000_000
    );

    expect(path).toStartWith("/api/v1/search_by_date?");
    expect(path).toContain("tags=story");
    expect(path).toContain("hitsPerPage=50");
    expect(decodeURIComponent(path)).toContain(
      `created_at_i>${String(1_790_000_000 - 7 * DAY)}`
    );
  });

  function hnDeps(): IHnDeps & { paths: string[] } {
    const paths: string[] = [];

    return {
      paths,
      now: () => NOW,
      fetchJson: async (path): Promise<FetchOutcome<unknown>> => {
        paths.push(path);

        return path.startsWith("/api/v1/items/")
          ? { ok: true, value: hnItem() }
          : { ok: true, value: hnSearch() };
      },
    };
  }

  test("hn_thread reads the whole tree as markdown and logs it", async () => {
    const c = await ctx();
    const h = createHnHandlers(hnDeps());
    const out = await h.hn_thread?.(
      { item: "https://news.ycombinator.com/item?id=4214", topic: "Wiring" },
      c
    );

    expect(out).toContain("# [HN] Ask HN: Guitar wiring tools? (120 points");
    expect(out).toContain("What do you use to _plan_ pickup wiring?");
    expect(out).toContain("- alice · 1mo:");
    expect(out).toContain("[multimeter](https://x.test)");
    expect(out).toContain("  - bob · 1mo:");
    expect(out).toContain("- [deleted]");
    expect(out).toContain("orphan reply");
    expect(out).toContain("— 3 comments shown");
    expect(
      await readFile(join(c.cwd, "notes/wiring/sources.md"), "utf8")
    ).toContain(
      "- [hn:4214] [HN] Ask HN: Guitar wiring tools? — https://news.ycombinator.com/item?id=4214"
    );
  });

  test("a logged thread is refused, flagged in search, and re-readable with force", async () => {
    const c = await ctx();
    const d = hnDeps();

    await createHnHandlers(d).hn_thread?.({ item: "4214", topic: "t" }, c);

    const fresh = createHnHandlers(d);
    const c2 = { ...c, stateKey: {} };

    expect(await fresh.hn_thread?.({ item: "4214", topic: "t" }, c2)).toContain(
      "already read"
    );
    expect(
      await fresh.hn_search?.({ query: "guitar", topic: "t" }, c2)
    ).toMatch(/- 4214 .* already read/u);
    expect(
      await fresh.hn_thread?.({ item: "4214", topic: "t", force: true }, c2)
    ).toContain("chunk 1/");
  });

  test("hn_search lines", async () => {
    const out = await createHnHandlers(hnDeps()).hn_search?.(
      { query: "guitar" },
      await ctx()
    );

    expect(out).toContain(
      "- 99 · 55 points · 12 comments · 2d — Show HN: Pickup wiring diagrams (example.com)"
    );
    expect(out).toContain("More: pass page: 1.");
  });
});

// ── Stack Exchange ───────────────────────────────────────────────────────────

describe("stack exchange", () => {
  test.each([
    [
      "https://stackoverflow.com/questions/123/title",
      { site: "stackoverflow", id: 123 },
    ],
    [
      "https://electronics.stackexchange.com/questions/446302/x",
      { site: "electronics", id: 446302 },
    ],
    ["https://superuser.com/q/77", { site: "superuser", id: 77 }],
    [
      "https://mathoverflow.net/questions/5",
      { site: "mathoverflow.net", id: 5 },
    ],
    ["https://api.stackexchange.com/questions/5", null],
    ["https://example.com/questions/5", null],
  ])("%p", (url, expected) => {
    expect(parseQuestionRef(url, undefined)).toEqual(expected);
  });

  test("site names: default, bare, host, invalid", () => {
    expect(parseSite(undefined)).toBe("stackoverflow");
    expect(parseSite("Electronics")).toBe("electronics");
    expect(parseSite("diy.stackexchange.com")).toBe("diy");
    expect(parseSite("../../etc")).toBeNull();
  });

  test("search path carries the key and the accepted filter", () => {
    const path = seSearchPath(
      { query: "hot wire", site: "electronics", accepted: true, sort: "votes" },
      "K123"
    );

    expect(path).toStartWith("/2.3/search/advanced?");
    expect(path).toContain("site=electronics");
    expect(path).toContain("accepted=True");
    expect(path).toContain("sort=votes");
    expect(path).toContain("key=K123");
  });

  function seDeps(): ISeDeps & { backoffs: number[]; paths: string[] } {
    const backoffs: number[] = [];
    const paths: string[] = [];

    return {
      backoffs,
      paths,
      now: () => NOW,
      key: () => "",
      backoff: async (s) => {
        backoffs.push(s);
      },
      fetchJson: async (path): Promise<FetchOutcome<unknown>> => {
        paths.push(path);

        if (path.includes("/answers?")) {
          return { ok: true, value: seAnswers() };
        }

        return path.startsWith("/2.3/questions/")
          ? { ok: true, value: seQuestion() }
          : { ok: true, value: seQuestion() };
      },
    };
  }

  test("se_question: accepted answer first, code kept, entities decoded, backoff honoured, logged with the real link", async () => {
    const c = await ctx();
    const d = seDeps();
    const out = await createSeHandlers(d).se_question?.(
      {
        question: "https://electronics.stackexchange.com/questions/446302/x",
        topic: "t",
      },
      c
    );

    expect(out).toContain(
      '# [electronics] Guitar pickup "hot" wire? (score 7 · 2 answers · ✓ accepted · 1y · José)'
    );
    expect(out).toContain("red  -> hot");
    expect(out?.indexOf("✓ Accepted — score 4")).toBeLessThan(
      out?.indexOf("score 9 · top") ?? 0
    );
    expect(out).toContain("40 requests left today");
    expect(d.backoffs).toContain(3);
    expect(await readFile(join(c.cwd, "notes/t/sources.md"), "utf8")).toContain(
      '- [se:electronics_446302] [electronics] Guitar pickup "hot" wire? — https://electronics.stackexchange.com/questions/446302/guitar-pickup-hot-wire'
    );
  });

  test("se_search flags a logged question", async () => {
    const c = await ctx();
    const d = seDeps();
    const h = createSeHandlers(d);

    await h.se_question?.(
      { question: "446302", site: "electronics", topic: "t" },
      c
    );
    expect(
      await h.se_search?.(
        { query: "hot wire", site: "electronics", topic: "t" },
        c
      )
    ).toMatch(/- electronics\/446302 .* ✓ already read/u);
  });
});

// ── routing, direct fetch, advertising ───────────────────────────────────────

describe("routing", () => {
  test.each([
    [
      "https://www.reddit.com/r/Guitar/comments/abc12/x/",
      "reddit_thread",
      "reddit:abc12",
    ],
    ["https://news.ycombinator.com/item?id=4214", "hn_thread", "hn:4214"],
    [
      "https://electronics.stackexchange.com/questions/446302/x",
      "se_question",
      "se:electronics_446302",
    ],
  ])("%p → %p", (url, tool, key) => {
    expect(routeUrl(url)).toMatchObject({ tool, key });
  });

  test("other pages have no plugin; their key is stable across trivial URL differences", () => {
    expect(routeUrl("https://blog.example.com/post")).toBeNull();
    expect(webKey("https://www.Example.com/a/?utm_source=x#top")).toBe(
      webKey("https://example.com/a")
    );
    expect(webKey("https://example.com/a")).not.toBe(
      webKey("https://example.com/b")
    );
  });

  test("direct plugins ride web tools; browser plugins need the bridge", () => {
    const web = sitePluginTools({ web: true }).map((t) => t.function.name);
    const browser = sitePluginTools({ browser: true }).map(
      (t) => t.function.name
    );

    expect(web).toEqual(
      expect.arrayContaining([
        "hn_search",
        "hn_thread",
        "se_search",
        "se_question",
      ])
    );
    expect(web).not.toContain("reddit_thread");
    expect(browser).toEqual(
      expect.arrayContaining(["reddit_thread", "hn_thread", "se_question"])
    );
    expect(sitePluginTools({})).toEqual([]);
  });
});

describe("direct fetch", () => {
  let prev: IDirectFetchDeps;
  const calls: string[] = [];
  let replies: Response[] = [];

  beforeEach(() => {
    calls.length = 0;
    prev = setDirectFetchDeps({
      pacer: new Pacer(0, { now: () => 0, sleep: async () => undefined }),
      fetch: async (url) => {
        calls.push(url);

        return replies.shift() ?? new Response("{}", { status: 200 });
      },
    });
  });

  afterEach(() => {
    setDirectFetchDeps(prev);
  });

  test("only a declared host, over https", async () => {
    expect(
      await directFetchJson(["hn.algolia.com"], "evil.test", "/x")
    ).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    await directFetchJson(
      ["hn.algolia.com"],
      "hn.algolia.com",
      "/api/v1/items/1"
    );
    expect(calls).toEqual(["https://hn.algolia.com/api/v1/items/1"]);
  });

  test("429 retries, then succeeds; a thrown fetch is a network failure", async () => {
    replies = [
      new Response("", { status: 429, headers: { "retry-after": "1" } }),
      new Response('{"ok":1}', { status: 200 }),
    ];
    expect(await directFetchJson(["h.test"], "h.test", "/x")).toEqual({
      ok: true,
      value: { ok: 1 },
    });

    setDirectFetchDeps({
      pacer: new Pacer(0, { now: () => 0, sleep: async () => undefined }),
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await directFetchJson(["h.test"], "h.test", "/x")).toMatchObject({
      ok: false,
      failure: { kind: "network" },
    });
  });
});
