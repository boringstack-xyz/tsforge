/**
 * End to end over a real localhost WebSocket: tsforge's bridge server + tool
 * handlers ⇄ the extension's Connection + Handlers + page agent. Only Chrome
 * itself is faked (tabs are jsdom documents), so this exercises the whole
 * read → click next page → read loop the agent runs on a forum thread.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { startBrowserBridge } from "../../core/src/chrome-bridge/bridge-server";
import { EXTENSION_ID } from "../../core/src/chrome-bridge/chrome-bridge.constants";
import type { IBrowserSession } from "../../core/src/chrome-bridge/chrome-bridge.types";
import {
  doBrowserAdopt,
  doBrowserClick,
  doBrowserRead,
  doBrowserTabs,
} from "../../core/src/loop/tools/browser-tools";
import type { IToolContext } from "../../core/src/loop/tools/tool-context";
import { Connection, type IWsLike } from "../src/connection";
import type { IChromeApi, IHandlerState, ITab } from "../src/extension.types";
import { Handlers } from "../src/handlers";
import { createPageAgent, type IPageAgent } from "../src/page-agent";

const TOKEN = "e2e-token-0123456789abcdef";
const PAGES = 3;

function forumPage(n: number): string {
  const replies = Array.from(
    { length: 5 },
    (_, i) =>
      `<div class="comment"><p>Page ${n} reply ${i}: ${"insight ".repeat(20)}</p></div>`
  ).join("");
  const next =
    n < PAGES
      ? `<nav class="pagination"><a href="/t/1?page=${n + 1}">›</a></nav>`
      : "";

  return `<html><head><title>Thread p${n}</title></head><body><main>
    <h1>Big thread</h1>${replies}
    <form><textarea>my unsent reply</textarea><button>Post reply</button></form>
    <button>Like</button>
    ${next}</main></body></html>`;
}

/** A fake Chrome whose single tab renders jsdom pages keyed by URL. */
function fakeChrome() {
  const tab: ITab = {
    id: 7,
    windowId: 1,
    groupId: -1,
    title: "Thread p1",
    url: "https://forum.example/t/1?page=1",
    active: true,
  };
  let agent: IPageAgent | null = null;
  let groupTitle = "";

  const load = (url: string): void => {
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const dom = new JSDOM(forumPage(page), { url });

    tab.url = url;
    tab.title = dom.window.document.title;
    agent = createPageAgent({
      document: dom.window.document,
      window: {
        innerHeight: 800,
        scrollY: 0,
        scrollBy: () => undefined,
        scrollTo: () => undefined,
        location: dom.window.location,
      },
      sleep: async () => undefined,
      waitForQuiet: async () => false,
    });
  };

  load(tab.url);

  const api: IChromeApi = {
    listTabs: async () => [{ ...tab }],
    getTab: async (id) => (id === tab.id ? { ...tab } : null),
    activeTabId: async () => tab.id,
    createTab: async () => {
      throw new Error("not used");
    },
    navigate: async (_id, url) => {
      load(url);
    },
    goBack: async () => undefined,
    removeTab: async () => undefined,
    waitForLoad: async () => undefined,
    getGroup: async (id) =>
      id === 100 ? { id, windowId: 1, title: groupTitle } : null,
    findGroup: async () => null,
    groupTabs: async () => {
      tab.groupId = 100;

      return 100;
    },
    labelGroup: async (_id, title) => {
      groupTitle = title;
    },
    ungroupTabs: async () => undefined,
    runInPage: async (_id, method, params) => {
      if (agent === null) {
        throw new Error("no page");
      }

      if (method === "snapshot") {
        return agent.snapshot();
      }

      if (method === "click") {
        return agent.click(Number(params.ref), Number(params.snapshotId));
      }

      return agent.scroll(String(params.to));
    },
    captureTab: async () => "data:image/png;base64,AA",
  };

  return { api, groupTitle: () => groupTitle };
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

afterAll(() => {
  bridge.stop();
});

describe("tsforge ⇄ extension over a real WebSocket", () => {
  test("adopt the active tab, read every page of a thread via next-page refs", async () => {
    const chrome = fakeChrome();
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

    expect(bridge.status()).toBe("connected");

    const session: IBrowserSession = {
      bridge,
      pages: new Map(),
      lastTab: null,
      opened: new Set(),
    };
    const ctx: IToolContext = {
      cwd: ".",
      files: [],
      task: "e2e",
      report: () => undefined,
      browser: session,
    };

    expect(await doBrowserTabs({}, ctx)).toContain(
      "tab 7 [not shared][active]"
    );
    expect(await doBrowserAdopt({ tab: 7 }, ctx)).toContain("Adopted tab 7");
    expect(chrome.groupTitle()).toBe("tsforge");

    const seen: string[] = [];

    for (let page = 1; page <= PAGES; page++) {
      const read = await doBrowserRead({}, ctx);

      seen.push(read);
      // The things the agent must never be offered: form content, Reply/Like.
      expect(read).not.toContain("my unsent reply");
      expect(read).not.toMatch(/\[\d+ \w+: (Post reply|Like)\]/);

      if (page < PAGES) {
        const next = /\[(\d+) page: ›\]/.exec(read);

        expect(next).not.toBeNull();
        expect(await doBrowserClick({ ref: Number(next![1]) }, ctx)).toContain(
          `Navigated to https://forum.example/t/1?page=${page + 1}`
        );
      } else {
        expect(read).toContain("No pagination found");
      }
    }

    const all = seen.join("\n");

    for (let p = 1; p <= PAGES; p++) {
      for (let r = 0; r < 5; r++) {
        expect(all).toContain(`Page ${p} reply ${r}`);
      }
    }
  });
});
