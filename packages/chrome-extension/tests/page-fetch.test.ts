/**
 * `page.fetch` is the one capability site plugins add to the extension: a
 * same-origin GET in a tsforge tab. Every refusal rule is pinned here, in the
 * handler (background) and again in the page.
 */
import { describe, expect, test } from "bun:test";
import { Handlers } from "../src/handlers";
import {
  fetchUrlProblem,
  FETCH_HOSTS,
  isTextContentType,
  MAX_FETCH_BYTES,
} from "../src/fetch-policy";
import { pageFetch } from "../src/page-fetch";
import type { IChromeApi, IHandlerState, ITab } from "../src/extension.types";
import { sitePluginHosts } from "../../core/src/site-plugins/registry";

const REDDIT = "https://www.reddit.com";

function harness(tab: ITab, inGroup = true) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let reply: unknown = {
    status: 200,
    contentType: "application/json",
    body: "{}",
    truncated: false,
  };
  const api: Partial<IChromeApi> = {
    getTab: async (id) => (id === tab.id ? tab : null),
    getGroup: async (id) =>
      id === 7 ? { id: 7, windowId: 1, title: "tsforge" } : null,
    runInPage: async (_id, method, params) => {
      calls.push({ method, params });

      return reply;
    },
  };
  let state: IHandlerState = {
    groupIds: inGroup ? [7] : [],
    adopted: [],
    shared: [],
  };
  const handlers = new Handlers(api as IChromeApi, {
    load: async () => structuredClone(state),
    save: async (s) => {
      state = s;
    },
  });

  return {
    handlers,
    calls,
    setReply: (r: unknown) => {
      reply = r;
    },
  };
}

const redditTab: ITab = {
  id: 1,
  windowId: 1,
  groupId: 7,
  title: "reddit",
  url: `${REDDIT}/r/Guitar/`,
  active: true,
};

describe("page.fetch handler", () => {
  test("same-origin GET on an allowed host reaches the page", async () => {
    const h = harness(redditTab);
    const res = await h.handlers.handle("page.fetch", {
      tabId: 1,
      url: `${REDDIT}/search.json?q=x`,
    });

    expect(res).toMatchObject({ ok: true, result: { status: 200 } });
    expect(h.calls).toEqual([
      { method: "fetch", params: { url: `${REDDIT}/search.json?q=x` } },
    ]);
  });

  test("another origin than the tab's is refused before the page runs", async () => {
    const h = harness(redditTab);
    const res = await h.handlers.handle("page.fetch", {
      tabId: 1,
      url: "https://old.reddit.com/search.json",
    });

    expect(res).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(h.calls).toHaveLength(0);
  });

  test("a host no plugin declares is refused even on its own tab", async () => {
    const h = harness({ ...redditTab, url: "https://mail.example/inbox" });
    const res = await h.handlers.handle("page.fetch", {
      tabId: 1,
      url: "https://mail.example/api/messages",
    });

    expect(res).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(h.calls).toHaveLength(0);
  });

  test("a tab outside the tsforge group is refused", async () => {
    const h = harness(redditTab, false);
    const res = await h.handlers.handle("page.fetch", {
      tabId: 1,
      url: `${REDDIT}/search.json`,
    });

    expect(res).toMatchObject({ ok: false, error: { code: "not_in_group" } });
  });

  test("a page-side refusal comes back as denied", async () => {
    const h = harness(redditTab);

    h.setReply({ error: "not a JSON/text response (image/png)" });
    expect(
      await h.handlers.handle("page.fetch", {
        tabId: 1,
        url: `${REDDIT}/x.json`,
      })
    ).toMatchObject({
      ok: false,
      error: {
        code: "denied",
        message: "not a JSON/text response (image/png)",
      },
    });
  });
});

describe("fetch policy", () => {
  test.each([
    [`${REDDIT}/r/x.json`, null],
    ["http://www.reddit.com/r/x.json", "only https URLs can be fetched"],
    [
      "https://user:pw@www.reddit.com/x",
      "URLs with credentials are not allowed",
    ],
    [42, "missing url"],
  ])("%p", (url, expected) => {
    const problem = fetchUrlProblem(url, `${REDDIT}/`);

    expect(problem).toBe(expected);
  });

  test("the compiled-in hosts are exactly the core plugins' hosts", () => {
    expect([...FETCH_HOSTS].sort()).toEqual(sitePluginHosts());
  });

  test.each([
    ["application/json; charset=UTF-8", true],
    ["application/vnd.api+json", true],
    ["text/html", true],
    ["image/png", false],
    ["application/octet-stream", false],
  ])("content-type %p → %p", (type, ok) => {
    expect(isTextContentType(type)).toBe(ok);
  });
});

function response(
  body: string,
  init: {
    status?: number;
    type?: string;
    url?: string;
    retryAfter?: string;
  } = {}
): Response {
  const headers = new Headers({
    "content-type": init.type ?? "application/json",
  });

  if (init.retryAfter !== undefined) {
    headers.set("retry-after", init.retryAfter);
  }

  const res = new Response(body, { status: init.status ?? 200, headers });

  Object.defineProperty(res, "url", { value: init.url ?? `${REDDIT}/x.json` });

  return res;
}

describe("in-page fetch", () => {
  const page = () => `${REDDIT}/r/Guitar/`;

  test("GET with the user's credentials, no body", async () => {
    let seen: RequestInit | undefined;
    const reply = await pageFetch(`${REDDIT}/x.json`, {
      pageUrl: page,
      fetch: async (_u, init) => {
        seen = init;

        return response('{"a":1}');
      },
    });

    expect(reply).toMatchObject({ status: 200, body: '{"a":1}' });
    expect(seen).toMatchObject({ method: "GET", credentials: "include" });
    expect(seen?.body).toBeUndefined();
  });

  test("re-checks the origin in the page itself", async () => {
    const reply = await pageFetch("https://old.reddit.com/x.json", {
      pageUrl: page,
      fetch: async () => response("{}"),
    });

    expect(reply).toMatchObject({
      error: expect.stringContaining("same-origin"),
    });
  });

  test("a redirect to another site is refused", async () => {
    const reply = await pageFetch(`${REDDIT}/x.json`, {
      pageUrl: page,
      fetch: async () => response("{}", { url: "https://evil.example/x" }),
    });

    expect(reply).toMatchObject({
      error: expect.stringContaining("redirected"),
    });
  });

  test("non-text and oversized bodies are refused", async () => {
    expect(
      await pageFetch(`${REDDIT}/x.json`, {
        pageUrl: page,
        fetch: async () => response("x", { type: "image/png" }),
      })
    ).toMatchObject({ error: expect.stringContaining("not a JSON/text") });
    expect(
      await pageFetch(`${REDDIT}/x.json`, {
        pageUrl: page,
        fetch: async () => response("x".repeat(MAX_FETCH_BYTES + 1)),
      })
    ).toMatchObject({ error: expect.stringContaining("5 MB") });
  });

  test("a 429 comes back with its status and Retry-After", async () => {
    const reply = await pageFetch(`${REDDIT}/x.json`, {
      pageUrl: page,
      fetch: async () =>
        response("slow down", {
          status: 429,
          type: "text/html",
          retryAfter: "7",
        }),
    });

    expect(reply).toMatchObject({ status: 429, retryAfter: "7", body: "" });
  });
});
