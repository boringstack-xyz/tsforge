import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IBrowserSession } from "../src/chrome-bridge";
import type { FetchOutcome } from "../src/site-plugins";
import {
  createRedditHandlers,
  type IRedditDeps,
} from "../src/site-plugins/reddit";
import { countComments, expandThread } from "../src/site-plugins/reddit/expand";
import {
  parseListing,
  parseSubreddits,
  parseThread,
} from "../src/site-plugins/reddit/parse";
import {
  age,
  imagesInOrder,
  renderThread,
} from "../src/site-plugins/reddit/render";
import {
  continuePath,
  listingPath,
  moreChildrenPath,
  parsePostId,
  parseSubreddit,
  searchPath,
  subredditSearchPath,
  threadPath,
} from "../src/site-plugins/reddit/urls";
import {
  comment,
  continueJson,
  galleryPost,
  listing,
  moreChildrenJson,
  NOW_UTC,
  searchJson,
  subredditsJson,
  threadJson,
} from "./helpers/reddit-fixtures";

const NOW = new Date(NOW_UTC * 1000);
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tsforge-reddit-"));

  dirs.push(d);

  return d;
}

function parsedThread() {
  const t = parseThread(threadJson());

  if (t === null) {
    throw new Error("fixture did not parse");
  }

  return t;
}

describe("urls", () => {
  test("post ids from ids, fullnames and every URL shape", () => {
    expect(parsePostId("1abc2d")).toBe("1abc2d");
    expect(parsePostId("t3_1abc2d")).toBe("1abc2d");
    expect(
      parsePostId("https://www.reddit.com/r/Guitar/comments/1abc2d/some_title/")
    ).toBe("1abc2d");
    expect(parsePostId("https://old.reddit.com/comments/1abc2d")).toBe(
      "1abc2d"
    );
    expect(parsePostId("https://redd.it/1abc2d")).toBe("1abc2d");
    expect(parsePostId("https://www.reddit.com/r/Guitar/")).toBeNull();
    expect(parsePostId("../../etc")).toBeNull();
  });

  test("subreddit names are normalised and validated", () => {
    expect(parseSubreddit("/r/Guitar/")).toBe("Guitar");
    expect(parseSubreddit("r/diypedals")).toBe("diypedals");
    expect(parseSubreddit("Guitar/../../api")).toBeNull();
  });

  test("search restricts to a subreddit only when given, and clamps options", () => {
    expect(
      searchPath({
        query: "caps",
        subreddit: "Guitar",
        sort: "top",
        time: "year",
        limit: 500,
      })
    ).toBe(
      "/r/Guitar/search.json?q=caps&restrict_sr=1&sort=top&t=year&limit=100&type=link&raw_json=1"
    );
    expect(searchPath({ query: "a b", sort: "bogus" })).toBe(
      "/search.json?q=a+b&sort=relevance&t=all&limit=25&type=link&raw_json=1"
    );
  });

  test("every built path is a read endpoint", () => {
    const paths = [
      searchPath({ query: "x" }),
      listingPath({ subreddit: "Guitar", sort: "top", time: "week" }),
      subredditSearchPath("x", 5),
      threadPath("p1", "new"),
      continuePath("p1", "c2", "top"),
      moreChildrenPath("p1", ["a", "b"], "top"),
    ];

    for (const p of paths) {
      expect(p).toMatch(
        /^\/(?:search\.json|r\/\w+\/(?:search|hot|new|top|rising)\.json|subreddits\/search\.json|comments\/[a-z0-9]+(?:\/_\/[a-z0-9]+)?\.json|api\/morechildren\.json)\?/u
      );
      expect(p).toContain("raw_json=1");
    }
  });
});

describe("parse + media", () => {
  test("thread: post, nested comments, stubs", () => {
    const t = parsedThread();

    expect(t.post.images).toEqual(["https://i.redd.it/wiring.jpg"]);
    expect(t.comments.map((c) => c.id)).toEqual([
      "auto",
      "c1",
      "c2",
      "gone",
      "gone2",
    ]);
    expect(t.comments[1]?.replies[0]?.isSubmitter).toBe(true);
    expect(t.more).toEqual([
      { parentId: "t3_p1", ids: ["m1", "m2", "m3"], count: 3 },
    ]);
    expect(t.comments[2]?.replies[0]?.more).toEqual([
      { parentId: "t1_c2a", ids: [], count: 0 },
    ]);
  });

  test("gallery images come in gallery order, invalid entries skipped", () => {
    const page = parseListing(listing([galleryPost("g1")]));

    expect(page?.posts[0]?.images).toEqual([
      "https://preview.redd.it/b.png?width=1&s=y",
      "https://preview.redd.it/a.jpg?width=1&s=x",
    ]);
  });

  test("comment image links are trimmed of trailing markdown", () => {
    expect(parsedThread().comments[1]?.images).toEqual([
      "https://i.redd.it/mine.png",
    ]);
  });

  test("video is a link, not an image; listing keeps `after`", () => {
    const page = parseListing(searchJson());

    expect(page?.after).toBe("t3_p3");
    expect(page?.posts[1]?.videoUrl).toBe("https://v.redd.it/x/DASH_720.mp4");
    expect(page?.posts[1]?.images).toEqual([]);
  });

  test("non-Reddit shapes parse to null", () => {
    expect(parseThread({ nope: true })).toBeNull();
    expect(parseListing([1, 2])).toBeNull();
    expect(parseSubreddits("x")).toBeNull();
  });
});

function fakeFetcher(): {
  fetch: (path: string) => Promise<FetchOutcome<unknown>>;
  paths: string[];
} {
  const paths: string[] = [];

  return {
    paths,
    fetch: async (path) => {
      paths.push(path);

      if (path.startsWith("/api/morechildren.json")) {
        return { ok: true, value: moreChildrenJson() };
      }

      if (path.startsWith("/comments/p1/_/c2a.json")) {
        return { ok: true, value: continueJson() };
      }

      if (path.startsWith("/comments/p1.json")) {
        return { ok: true, value: threadJson() };
      }

      return {
        ok: false,
        failure: { kind: "http", status: 404, message: "HTTP 404" },
      };
    },
  };
}

describe("expand", () => {
  test("fills collapsed replies and continued threads", async () => {
    const t = parsedThread();
    const f = fakeFetcher();
    const stats = await expandThread(t, f.fetch, 500, "top");

    expect(stats).toMatchObject({ requests: 2, error: null, remaining: 0 });
    expect(t.comments.map((c) => c.id)).toContain("m3");
    expect(
      t.comments.find((c) => c.id === "m2")?.replies.map((r) => r.id)
    ).toEqual(["m2a"]);
    expect(t.comments[2]?.replies[0]?.replies.map((r) => r.id)).toEqual([
      "deep1",
    ]);
    expect(t.more).toHaveLength(0);
  });

  test("stops at the comment budget and reports what is still collapsed", async () => {
    const t = parsedThread();
    const f = fakeFetcher();
    const before = countComments(t.comments);
    const stats = await expandThread(t, f.fetch, before, "top");

    expect(stats.requests).toBe(0);
    expect(stats.remaining).toBe(3);
  });

  test("a failed request stops expansion without throwing", async () => {
    const t = parsedThread();
    const stats = await expandThread(
      t,
      async () => ({
        ok: false,
        failure: { kind: "rate_limited", message: "429" },
      }),
      500,
      "top"
    );

    expect(stats.error).toBe("429");
  });
});

describe("render", () => {
  test("drops AutoModerator and empty deleted comments, keeps a deleted parent", () => {
    const text = renderThread(parsedThread(), new Map(), NOW);

    expect(text).not.toContain("AutoModerator");
    expect(text).not.toContain("user_gone ");
    expect(text).toContain("comment orphan");
    expect(text).toContain("- u/user_c1 ↑120 · 1y:");
    expect(text).toContain("  - u/user_c1a (OP) ↑10");
  });

  test("a plain (non-sticky) AutoModerator comment is dropped too", () => {
    const json = threadJson();

    json[1] = listing([
      comment("am", { author: "AutoModerator", body: "Your post was flaired" }),
      comment("keep"),
    ]);

    const t = parseThread(json);
    const text = t === null ? "" : renderThread(t, new Map(), NOW);

    expect(text).toContain("comment keep");
    expect(text).not.toContain("flaired");
  });

  test("images are numbered post-first and shown as saved paths or links", () => {
    const t = parsedThread();
    const labels = new Map([
      ["https://i.redd.it/wiring.jpg", { rel: "notes/t/assets/p1/1.jpg" }],
      ["https://i.redd.it/mine.png", { failed: "HTTP 403" }],
    ]);
    const text = renderThread(t, labels, NOW);

    expect(imagesInOrder(t)).toEqual([
      "https://i.redd.it/wiring.jpg",
      "https://i.redd.it/mine.png",
    ]);
    expect(text).toContain("[image 1: notes/t/assets/p1/1.jpg — post]");
    expect(text).toContain(
      "[image 2: https://i.redd.it/mine.png — comment by u/user_c1; not saved: HTTP 403]"
    );
  });

  test("age buckets", () => {
    expect(age(NOW_UTC - 90, NOW)).toBe("1m");
    expect(age(NOW_UTC - 3 * 86_400, NOW)).toBe("3d");
    expect(age(NOW_UTC - 400 * 86_400, NOW)).toBe("1y");
  });
});

function session(): IBrowserSession {
  return {
    bridge: {
      port: 0,
      status: () => "connected",
      request: async () => ({
        ok: false,
        error: { code: "internal", message: "unused" },
      }),
      stop: () => undefined,
    },
    pages: new Map(),
    lastTab: null,
    opened: new Set(),
  };
}

function deps(f = fakeFetcher()): IRedditDeps & { downloads: string[] } {
  const downloads: string[] = [];

  return {
    downloads,
    now: () => NOW,
    fetchJson: (_s, path) => f.fetch(path),
    download: async (_cwd, req) => {
      downloads.push(req.url);

      return req.url.includes("mine")
        ? { ok: false, reason: "HTTP 403" }
        : {
            ok: true,
            rel: `notes/${req.topic}/assets/${req.group}/${req.name}.jpg`,
          };
    },
  };
}

describe("handlers", () => {
  test("reddit_thread reads the whole thread, saves images, logs the source", async () => {
    const cwd = await tempDir();
    const d = deps();
    const h = createRedditHandlers(d);
    const ctx = { session: session(), cwd, progress: () => undefined };
    const out = await h.reddit_thread?.(
      {
        post: "https://www.reddit.com/r/Guitar/comments/p1/x/",
        topic: "Pickup wiring",
      },
      ctx
    );

    expect(out).toContain("reddit_thread p1 · chunk 1/1");
    expect(out).toContain("UNTRUSTED DATA");
    expect(out).toContain("comment m2a");
    expect(out).toContain(
      "[image 1: notes/Pickup wiring/assets/p1/1.jpg — post]"
    );
    expect(d.downloads).toHaveLength(2);

    const log = await readFile(
      join(cwd, "notes/pickup-wiring/sources.md"),
      "utf8"
    );

    expect(log).toContain(
      "- [reddit:p1] [r/Guitar] Post p1 — https://www.reddit.com/r/Guitar/comments/p1/post_p1/"
    );
  });

  test("a second read of the same thread is flagged in search and not logged twice", async () => {
    const cwd = await tempDir();
    const f = fakeFetcher();
    const d = deps(f);

    d.fetchJson = (_s, path) =>
      path.startsWith("/search.json")
        ? Promise.resolve({ ok: true, value: searchJson() })
        : f.fetch(path);

    const h = createRedditHandlers(d);
    const ctx = { session: session(), cwd, progress: () => undefined };

    await h.reddit_thread?.({ post: "p1", topic: "t" }, ctx);
    await h.reddit_thread?.({ post: "p1", topic: "t" }, ctx);

    const search = await h.reddit_search?.({ query: "caps", topic: "t" }, ctx);
    const log = await readFile(join(cwd, "notes/t/sources.md"), "utf8");

    expect(search).toMatch(/- p1 .* already read — Post p1/u);
    expect(search).not.toMatch(/- p2 .* already read/u);
    expect(search).toContain('More: pass after: "t3_p3".');
    expect(log.match(/\[reddit:p1\]/gu)).toHaveLength(1);
  });

  test("already-read survives a restart through sources.md", async () => {
    const cwd = await tempDir();
    const f = fakeFetcher();
    const first = createRedditHandlers(deps(f));

    await first.reddit_thread?.(
      { post: "p1", topic: "t" },
      { session: session(), cwd, progress: () => undefined }
    );

    const d = deps(f);

    d.fetchJson = async () => ({ ok: true, value: searchJson() });

    const fresh = createRedditHandlers(d);
    const out = await fresh.reddit_search?.(
      { query: "x", topic: "t" },
      { session: session(), cwd, progress: () => undefined }
    );

    expect(out).toMatch(/- p1 .* already read/u);
  });

  test("chunk 2+ is served from cache without refetching", async () => {
    const cwd = await tempDir();
    const f = fakeFetcher();
    const h = createRedditHandlers(deps(f));
    const ctx = { session: session(), cwd, progress: () => undefined };

    await h.reddit_thread?.({ post: "p1", topic: "t", maxComments: 2000 }, ctx);

    const count = f.paths.length;

    await h.reddit_thread?.({ post: "p1", topic: "t", chunk: 2 }, ctx);
    expect(f.paths.length).toBe(count);
  });

  test("failures come back as advice, never a throw", async () => {
    const d = deps();

    d.fetchJson = async () => ({
      ok: false,
      failure: { kind: "http", status: 403, message: "HTTP 403" },
    });

    const h = createRedditHandlers(d);
    const ctx = {
      session: session(),
      cwd: await tempDir(),
      progress: () => undefined,
    };

    expect(await h.reddit_thread?.({ post: "p1", topic: "t" }, ctx)).toContain(
      "HTTP 403"
    );
    expect(
      await h.reddit_thread?.({ post: "not a post", topic: "t" }, ctx)
    ).toContain("required");
    expect(await h.reddit_search?.({ query: "" }, ctx)).toContain(
      "`query` is required"
    );
  });

  test("reddit_subreddits lists communities", async () => {
    const d = deps();

    d.fetchJson = async () => ({ ok: true, value: subredditsJson() });

    const out = await createRedditHandlers(d).reddit_subreddits?.(
      { query: "guitar" },
      { session: session(), cwd: await tempDir(), progress: () => undefined }
    );

    expect(out).toContain("- r/Guitar · 3,100,000 members — All things guitar");
  });
});
