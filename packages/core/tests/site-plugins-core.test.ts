import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFetchResult,
  type BridgeMethod,
  type BridgeResult,
  type IBrowserSession,
  type ITabInfo,
} from "../src/chrome-bridge";
import { browserChipText } from "../src/cli/browser-command";
import { browserTools } from "../src/loop/turn";
import { doNote } from "../src/loop/tools/note-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import { classifyAction } from "../src/policy/classify";
import {
  assetUrlProblem,
  backoffMs,
  downloadAsset,
  Pacer,
  pageFetchJson,
  readSources,
  recordSource,
  sitePluginHosts,
  usePacer,
} from "../src/site-plugins";
import { REDDIT_MEDIA_HOSTS } from "../src/site-plugins/reddit";

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tsforge-siteplug-"));

  dirs.push(d);

  return d;
}

/** A pacer on a fake clock: records every sleep instead of waiting. */
function fakePacer(interval = 1000): { pacer: Pacer; sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];

  return {
    sleeps,
    pacer: new Pacer(interval, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    }),
  };
}

describe("pacer", () => {
  test("spaces requests to one host, not across hosts", async () => {
    const { pacer, sleeps } = fakePacer();

    await pacer.wait("a");
    await pacer.wait("a");
    await pacer.wait("b");
    await pacer.wait("a");
    expect(sleeps).toEqual([1000, 1000]);
  });

  test("backoff honours Retry-After, else doubles, capped at 60s", () => {
    expect(backoffMs(1, "7")).toBe(7000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(3, "soon")).toBe(8000);
    expect(backoffMs(20)).toBe(60_000);
    expect(backoffMs(1, "3600")).toBe(60_000);
  });
});

interface IFakeBridge {
  session: IBrowserSession;
  calls: { method: BridgeMethod; params: Record<string, unknown> }[];
}

/** A bridge with a tab list and scripted page.fetch replies. */
function fakeBridge(tabs: ITabInfo[], replies: unknown[]): IFakeBridge {
  const calls: IFakeBridge["calls"] = [];

  const request = async (
    method: BridgeMethod,
    params: Record<string, unknown>
  ): Promise<BridgeResult> => {
    calls.push({ method, params });

    if (method === "tabs.list") {
      return { ok: true, result: tabs };
    }

    if (method === "tabs.open") {
      const t: ITabInfo = {
        tabId: 99,
        title: "",
        url: String(params.url),
        active: false,
        inGroup: true,
        adopted: false,
      };

      tabs.push(t);

      return { ok: true, result: t };
    }

    const next = replies.shift();

    return next === "bridge-error"
      ? { ok: false, error: { code: "no_tab", message: "gone" } }
      : { ok: true, result: next };
  };

  return {
    calls,
    session: {
      bridge: {
        port: 0,
        status: () => "connected",
        request,
        stop: () => undefined,
      },
      pages: new Map(),
      lastTab: null,
      opened: new Set(),
    },
  };
}

const ok = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
  truncated: false,
});
const tab = (id: number, url: string, inGroup = true): ITabInfo => ({
  tabId: id,
  title: "",
  url,
  active: false,
  inGroup,
  adopted: false,
});

describe("page fetch", () => {
  test("reuses one group tab on the host — never a tab per request", async () => {
    const b = fakeBridge(
      [tab(1, "https://mail.example/"), tab(2, "https://www.reddit.com/r/x/")],
      [ok({ a: 1 }), ok({ b: 2 })]
    );

    usePacer(b.session, fakePacer().pacer);

    expect(await pageFetchJson(b.session, "www.reddit.com", "/a.json")).toEqual(
      { ok: true, value: { a: 1 } }
    );
    expect(await pageFetchJson(b.session, "www.reddit.com", "/b.json")).toEqual(
      { ok: true, value: { b: 2 } }
    );

    const fetches = b.calls.filter((c) => c.method === "page.fetch");

    expect(fetches.map((c) => c.params)).toEqual([
      { tabId: 2, url: "https://www.reddit.com/a.json" },
      { tabId: 2, url: "https://www.reddit.com/b.json" },
    ]);
    expect(b.calls.some((c) => c.method === "tabs.open")).toBe(false);
  });

  test("opens the host once when no group tab is on it (a tab outside the group doesn't count)", async () => {
    const b = fakeBridge([tab(3, "https://www.reddit.com/", false)], [ok({})]);

    usePacer(b.session, fakePacer().pacer);
    await pageFetchJson(b.session, "www.reddit.com", "/x.json");
    expect(
      b.calls.filter((c) => c.method === "tabs.open").map((c) => c.params)
    ).toEqual([{ url: "https://www.reddit.com/" }]);
    expect(b.session.opened.has(99)).toBe(true);
  });

  test("429 retries with backoff, then gives up with advice", async () => {
    const limited = {
      status: 429,
      contentType: "text/html",
      body: "",
      truncated: false,
      retryAfter: "3",
    };
    const b = fakeBridge(
      [tab(2, "https://www.reddit.com/")],
      [limited, limited, ok({ fine: true })]
    );
    const { pacer, sleeps } = fakePacer();

    usePacer(b.session, pacer);
    expect(await pageFetchJson(b.session, "www.reddit.com", "/x.json")).toEqual(
      { ok: true, value: { fine: true } }
    );
    expect(sleeps.filter((s) => s === 3000)).toHaveLength(2);

    const always = fakeBridge(
      [tab(2, "https://www.reddit.com/")],
      Array.from({ length: 5 }, () => limited)
    );

    usePacer(always.session, fakePacer().pacer);

    const res = await pageFetchJson(
      always.session,
      "www.reddit.com",
      "/x.json"
    );

    expect(res).toMatchObject({ ok: false, failure: { kind: "rate_limited" } });
  });

  test("a vanished tab is re-resolved once; non-JSON is a clean failure", async () => {
    const b = fakeBridge(
      [tab(2, "https://www.reddit.com/")],
      [
        "bridge-error",
        {
          status: 200,
          contentType: "text/html",
          body: "<html>",
          truncated: false,
        },
      ]
    );

    usePacer(b.session, fakePacer().pacer);

    const res = await pageFetchJson(b.session, "www.reddit.com", "/x.json");

    expect(res).toMatchObject({ ok: false, failure: { kind: "bad_body" } });
    expect(b.calls.filter((c) => c.method === "page.fetch")).toHaveLength(2);
  });

  test("the protocol parser accepts fetch results and rejects junk", () => {
    expect(
      parseFetchResult({
        status: 200,
        contentType: "a",
        body: "b",
        retryAfter: "1",
      })
    ).toEqual({
      status: 200,
      contentType: "a",
      body: "b",
      truncated: false,
      retryAfter: "1",
    });
    expect(parseFetchResult({ status: "200", body: "b" })).toBeNull();
  });
});

describe("sources log", () => {
  test("records once per call and reads back keys", async () => {
    const cwd = await tempDir();
    const at = new Date("2026-09-26T10:00:00Z");

    await recordSource(
      cwd,
      "Wiring Issues",
      {
        site: "reddit",
        id: "p1",
        title: "A\ntitle",
        url: "https://x",
        meta: "↑1",
      },
      at
    );
    await recordSource(
      cwd,
      "Wiring Issues",
      { site: "reddit", id: "p2", title: "B", url: "https://y", meta: "↑2" },
      at
    );

    const text = await readFile(
      join(cwd, "notes/wiring-issues/sources.md"),
      "utf8"
    );

    expect(text).toBe(
      "# Sources — Wiring Issues\n\n- [reddit:p1] A title — https://x (↑1; read 2026-09-26)\n- [reddit:p2] B — https://y (↑2; read 2026-09-26)\n"
    );
    expect(await readSources(cwd, "wiring issues")).toEqual(
      new Set(["reddit:p1", "reddit:p2"])
    );
  });

  test("a topic folder symlinked outside the workspace is refused", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();

    await mkdir(join(cwd, "notes"));
    await symlink(outside, join(cwd, "notes/t"));

    const res = await recordSource(
      cwd,
      "t",
      { site: "reddit", id: "p1", title: "x", url: "u", meta: "m" },
      new Date()
    );

    expect(res).toMatchObject({
      error: expect.stringContaining("outside the workspace"),
    });
  });
});

function imageResponse(type: string, bytes = 4, length?: number): Response {
  const headers = new Headers({ "content-type": type });

  if (length !== undefined) {
    headers.set("content-length", String(length));
  }

  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

describe("asset downloads", () => {
  test.each([
    ["https://i.redd.it/a.jpg", null],
    ["http://i.redd.it/a.jpg", "not https"],
    [
      "https://evil.example/a.jpg",
      "host evil.example is not an allowed media host",
    ],
    [
      "https://v.redd.it/x/DASH.mp4",
      "host v.redd.it is not an allowed media host",
    ],
    ["nope", "not a URL"],
  ])("%p", (url, expected) => {
    expect(assetUrlProblem(url, REDDIT_MEDIA_HOSTS)).toBe(expected);
  });

  test("saves an image under notes/<topic>/assets/<group>/", async () => {
    const cwd = await tempDir();
    const res = await downloadAsset(
      cwd,
      { url: "https://i.redd.it/a.png", topic: "T", group: "p1", name: "1" },
      REDDIT_MEDIA_HOSTS,
      async () => imageResponse("image/png")
    );

    expect(res).toEqual({ ok: true, rel: "notes/t/assets/p1/1.png" });
    expect(
      (await readFile(join(cwd, "notes/t/assets/p1/1.png"))).byteLength
    ).toBe(4);
  });

  test("refuses non-images, oversize files, and never throws on network errors", async () => {
    const cwd = await tempDir();
    const req = {
      url: "https://i.redd.it/a.png",
      topic: "t",
      group: "p1",
      name: "1",
    };

    expect(
      await downloadAsset(cwd, req, REDDIT_MEDIA_HOSTS, async () =>
        imageResponse("text/html")
      )
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not an image"),
    });
    expect(
      await downloadAsset(cwd, req, REDDIT_MEDIA_HOSTS, async () =>
        imageResponse("image/png", 4, 50 * 1024 * 1024)
      )
    ).toMatchObject({ ok: false, reason: "larger than 10 MB" });
    expect(
      await downloadAsset(cwd, req, REDDIT_MEDIA_HOSTS, async () => {
        throw new Error("ECONNRESET");
      })
    ).toEqual({ ok: false, reason: "ECONNRESET" });
  });
});

function noteCtx(cwd: string): IToolContext {
  return {
    cwd,
    files: [],
    report: () => undefined,
    task: "t",
    touched: new Set(),
  } as unknown as IToolContext;
}

describe("note topic folders", () => {
  test("findings append; report can be replaced; nothing else can", async () => {
    const cwd = await tempDir();
    const ctx = noteCtx(cwd);

    await doNote({ topic: "T", text: "one", file: "findings" }, ctx);
    await doNote({ topic: "T", text: "two", file: "findings" }, ctx);
    await doNote(
      { topic: "T", text: "draft", file: "report", replace: true },
      ctx
    );
    await doNote(
      { topic: "T", text: "final", file: "report", replace: true },
      ctx
    );

    const findings = await readFile(join(cwd, "notes/t/findings.md"), "utf8");

    expect(findings).toContain("one");
    expect(findings).toContain("two");
    expect(await readFile(join(cwd, "notes/t/report.md"), "utf8")).toBe(
      "final\n"
    );
    expect(
      await doNote(
        { topic: "T", text: "x", file: "findings", replace: true },
        ctx
      )
    ).toContain("only allowed with file");
    expect(
      await doNote({ topic: "T", text: "x", file: "sources" }, ctx)
    ).toContain('must be "findings" or "report"');
  });
});

describe("wiring", () => {
  test("reddit tools ride the browser capability, and only it", () => {
    const on = browserTools({ browser: true }).map((t) => t.function.name);

    expect(on).toEqual(
      expect.arrayContaining([
        "reddit_search",
        "reddit_thread",
        "reddit_listing",
        "reddit_subreddits",
      ])
    );
    expect(browserTools({})).toEqual([]);
  });

  test("reddit tools are network actions", () => {
    expect(
      classifyAction({ name: "reddit_thread", arguments: {} }, "/tmp").kind
    ).toBe("network");
  });

  test("plugin hosts are the Reddit hosts", () => {
    expect(sitePluginHosts()).toEqual(["old.reddit.com", "www.reddit.com"]);
  });

  test("an outdated extension says so instead of 'waiting'", () => {
    expect(browserChipText("outdated", 47823)).toContain("outdated");
  });
});
