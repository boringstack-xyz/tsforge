/**
 * Reddit research end to end over a real localhost WebSocket: core's reddit_*
 * handlers → bridge server → extension Connection + Handlers → the in-page
 * `page.fetch` (with its origin / host checks) → a faked Reddit that serves
 * the JSON fixtures. Only Chrome and reddit.com are faked. Checks the agent
 * gets search results and a whole thread through ONE tab, and that the notes
 * folder ends up with the source log and the findings.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserBridge } from "../../core/src/chrome-bridge/bridge-server";
import { EXTENSION_ID } from "../../core/src/chrome-bridge/chrome-bridge.constants";
import type { IBrowserSession } from "../../core/src/chrome-bridge/chrome-bridge.types";
import { doNote } from "../../core/src/loop/tools/note-tool";
import type { IToolContext } from "../../core/src/loop/tools/tool-context";
import { Pacer, pageFetchJson, usePacer } from "../../core/src/site-plugins";
import { createRedditHandlers } from "../../core/src/site-plugins/reddit";
import {
  moreChildrenJson,
  NOW_UTC,
  searchJson,
  threadJson,
  continueJson,
} from "../../core/tests/helpers/reddit-fixtures";
import { Connection, type IWsLike } from "../src/connection";
import type { IChromeApi, IHandlerState, ITab } from "../src/extension.types";
import { Handlers } from "../src/handlers";
import { pageFetch } from "../src/page-fetch";

const TOKEN = "reddit-e2e-token-0123456789ab";

/** reddit.com, faked: the JSON view for each read endpoint the plugin builds. */
function fakeReddit(url: string): Response {
  const { pathname } = new URL(url);
  const body =
    pathname === "/search.json"
      ? searchJson()
      : pathname === "/api/morechildren.json"
        ? moreChildrenJson()
        : pathname === "/comments/p1/_/c2a.json"
          ? continueJson()
          : pathname === "/comments/p1.json"
            ? threadJson()
            : null;
  const res =
    body === null
      ? new Response("not found", {
          status: 404,
          headers: { "content-type": "text/html" },
        })
      : new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json; charset=UTF-8" },
        });

  Object.defineProperty(res, "url", { value: url });

  return res;
}

/** A Chrome with one unrelated tab; the plugin must open (and reuse) its own. */
function fakeChrome() {
  const tabs = new Map<number, ITab>([
    [
      1,
      {
        id: 1,
        windowId: 1,
        groupId: -1,
        title: "Mail",
        url: "https://mail.example/",
        active: true,
      },
    ],
  ]);
  const created: string[] = [];
  const fetched: string[] = [];
  let groupTitle = "";

  const api: IChromeApi = {
    listTabs: async () => [...tabs.values()].map((t) => ({ ...t })),
    getTab: async (id) => {
      const t = tabs.get(id);

      return t === undefined ? null : { ...t };
    },
    activeTabId: async () => 1,
    createTab: async (url) => {
      const t: ITab = {
        id: 10 + created.length,
        windowId: 1,
        groupId: -1,
        title: "reddit",
        url,
        active: false,
      };

      tabs.set(t.id, t);
      created.push(url);

      return { ...t };
    },
    navigate: async () => undefined,
    goBack: async () => undefined,
    removeTab: async () => undefined,
    waitForLoad: async () => undefined,
    getGroup: async (id) =>
      id === 100 ? { id, windowId: 1, title: groupTitle } : null,
    findGroup: async () => null,
    groupTabs: async (ids) => {
      for (const id of ids) {
        const t = tabs.get(id);

        if (t !== undefined) {
          t.groupId = 100;
        }
      }

      return 100;
    },
    labelGroup: async (_id, title) => {
      groupTitle = title;
    },
    ungroupTabs: async () => undefined,
    runInPage: async (id, method, params) => {
      const tab = tabs.get(id);

      if (method !== "fetch" || tab === undefined) {
        throw new Error(`unexpected page method ${method}`);
      }

      fetched.push(String(params.url));

      return pageFetch(params.url, {
        pageUrl: () => tab.url,
        fetch: async (url) => fakeReddit(url),
      });
    },
    captureTab: async () => "data:image/png;base64,AA",
  };

  return { api, created, fetched, groupTitle: () => groupTitle };
}

function bunSocket(url: string): IWsLike {
  const ws = new WebSocket(url, {
    headers: { Origin: `chrome-extension://${EXTENSION_ID}` },
  } as unknown as string[]);
  const like: IWsLike = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  ws.onopen = () => like.onopen?.();
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  ws.onclose = (ev) => like.onclose?.({ code: ev.code });

  return like;
}

const bridge = startBrowserBridge({ port: 0, token: TOKEN });
const dirs: string[] = [];

afterAll(() => {
  bridge.stop();
});

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function connect(chrome: ReturnType<typeof fakeChrome>): Promise<void> {
  let state: IHandlerState = { groupIds: [], adopted: [], shared: [] };
  const handlers = new Handlers(chrome.api, {
    load: async () => structuredClone(state),
    save: async (s) => {
      state = structuredClone(s);
    },
  });
  const conn = new Connection({
    createSocket: bunSocket,
    handle: (m, p) => handlers.handle(m, p),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onStatus: () => undefined,
    version: "e2e",
  });

  conn.configure({ token: TOKEN, port: bridge.port });

  for (let i = 0; i < 50 && bridge.status() !== "connected"; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("reddit research over the real bridge", () => {
  test("search → whole thread → notes, all through one Reddit tab", async () => {
    const chrome = fakeChrome();

    await connect(chrome);
    expect(bridge.status()).toBe("connected");

    const cwd = await mkdtemp(join(tmpdir(), "tsforge-reddit-e2e-"));

    dirs.push(cwd);

    const session: IBrowserSession = {
      bridge,
      pages: new Map(),
      lastTab: null,
      opened: new Set(),
    };

    usePacer(session, new Pacer(0));

    const reddit = createRedditHandlers({
      now: () => new Date(NOW_UTC * 1000),
      fetchJson: (s, path) => pageFetchJson(s, "www.reddit.com", path),
      download: async () => ({ ok: false, reason: "offline test" }),
    });
    const ctx = { session, cwd, progress: () => undefined };

    const search = await reddit.reddit_search?.(
      { query: "jimmy page wiring", topic: "wiring" },
      ctx
    );

    expect(search).toContain("- p1 · r/Guitar · ↑412 · 87 comments");

    const thread = await reddit.reddit_thread?.(
      { post: "p1", topic: "wiring" },
      ctx
    );

    // The whole discussion, collapsed replies included, in one call.
    expect(thread).toContain("Which caps for Jimmy Page wiring?");
    expect(thread).toContain("comment m2a");
    expect(thread).toContain("comment deep1");
    expect(thread).toContain("not saved: offline test");

    // ONE tab opened on reddit, in the tsforge group, reused for every request.
    expect(chrome.created).toEqual(["https://www.reddit.com/"]);
    expect(chrome.groupTitle()).toBe("tsforge");
    expect(
      chrome.fetched.every((u) => u.startsWith("https://www.reddit.com/"))
    ).toBe(true);
    expect(chrome.fetched.length).toBeGreaterThanOrEqual(4);

    const toolCtx: IToolContext = {
      cwd,
      files: [],
      task: "e2e",
      report: () => undefined,
      browser: session,
    };

    await doNote(
      {
        topic: "wiring",
        file: "findings",
        text: "## Cap values confuse people\n- Evidence: …",
      },
      toolCtx
    );

    expect(
      await readFile(join(cwd, "notes/wiring/sources.md"), "utf8")
    ).toContain("[reddit:p1]");
    expect(
      await readFile(join(cwd, "notes/wiring/findings.md"), "utf8")
    ).toContain("Cap values confuse people");
  });

  test("the extension refuses a host no plugin declares, whatever tsforge asks", async () => {
    const chrome = fakeChrome();

    await connect(chrome);

    const session: IBrowserSession = {
      bridge,
      pages: new Map(),
      lastTab: null,
      opened: new Set(),
    };

    usePacer(session, new Pacer(0));

    const res = await pageFetchJson(session, "mail.example", "/api/messages");

    expect(res.ok).toBe(false);
    expect(chrome.fetched).toHaveLength(0);
  });
});
