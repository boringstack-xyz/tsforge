import { describe, expect, test } from "bun:test";
import { Handlers } from "../src/handlers";
import type {
  IChromeApi,
  IGroup,
  IHandlerState,
  ITab,
} from "../src/extension.types";
import type { ITabInfo } from "../../core/src/chrome-bridge/chrome-bridge.types";

function fakeChrome(initial: ITab[], active: number | null) {
  const tabs = new Map(initial.map((t) => [t.id, { ...t }]));
  const groups = new Map<number, IGroup>();
  const log: string[] = [];
  let nextGroup = 100;
  let nextTab = 50;
  let pageReply: unknown = { snapshotId: 1, html: "<p>x</p>", refs: [] };

  const api: IChromeApi = {
    listTabs: async () => [...tabs.values()],
    getTab: async (id) => tabs.get(id) ?? null,
    activeTabId: async () => active,
    createTab: async (url) => {
      const t: ITab = {
        id: nextTab++,
        windowId: 1,
        groupId: -1,
        title: "",
        url,
        active: false,
      };

      tabs.set(t.id, t);
      log.push(`create ${url}`);

      return t;
    },
    navigate: async (id, url) => {
      tabs.get(id)!.url = url;
      log.push(`navigate ${id} ${url}`);
    },
    goBack: async (id) => {
      log.push(`back ${id}`);
    },
    removeTab: async (id) => {
      tabs.delete(id);
      log.push(`remove ${id}`);
    },
    waitForLoad: async () => undefined,
    getGroup: async (id) => groups.get(id) ?? null,
    findGroup: async (windowId, title) =>
      [...groups.values()].find(
        (g) => g.windowId === windowId && g.title === title
      ) ?? null,
    groupTabs: async (ids, groupId) => {
      const id = groupId ?? nextGroup++;

      if (!groups.has(id)) {
        groups.set(id, {
          id,
          windowId: tabs.get(ids[0]!)!.windowId,
          title: "",
        });
      }

      for (const t of ids) {
        tabs.get(t)!.groupId = id;
      }

      log.push(`group ${ids.join(",")} → ${id}`);

      return id;
    },
    labelGroup: async (id, title) => {
      groups.get(id)!.title = title;
    },
    ungroupTabs: async (ids) => {
      for (const t of ids) {
        tabs.get(t)!.groupId = -1;
      }

      log.push(`ungroup ${ids.join(",")}`);
    },
    runInPage: async (id, method) => {
      log.push(`page ${id} ${method}`);

      return pageReply;
    },
    captureTab: async () => "data:image/png;base64,AA",
  };

  let state: IHandlerState = { groupIds: [], adopted: [], shared: [] };
  const handlers = new Handlers(api, {
    load: async () => structuredClone(state),
    save: async (s) => {
      state = structuredClone(s);
    },
  });

  return {
    handlers,
    log,
    tabs,
    groups,
    state: () => state,
    setPageReply: (r: unknown) => {
      pageReply = r;
    },
  };
}

const forum: ITab = {
  id: 1,
  windowId: 1,
  groupId: -1,
  title: "Forum",
  url: "https://forum.example/t/1",
  active: true,
};
const mail: ITab = {
  id: 2,
  windowId: 1,
  groupId: -1,
  title: "Mail",
  url: "https://mail.example/",
  active: false,
};

describe("adopt", () => {
  test("the user's active tab is adopted into a new 'tsforge' group", async () => {
    const c = fakeChrome([forum, mail], 1);
    const res = await c.handlers.handle("tabs.adopt", { tabId: 1 });

    expect(res).toMatchObject({
      ok: true,
      result: { tabId: 1, inGroup: true, adopted: true },
    });
    expect([...c.groups.values()][0]!.title).toBe("tsforge");
  });

  test("a background tab is refused until the user shares it", async () => {
    const c = fakeChrome([forum, mail], 1);

    expect(await c.handlers.handle("tabs.adopt", { tabId: 2 })).toMatchObject({
      ok: false,
      error: { code: "denied" },
    });
    await c.handlers.share(2);
    expect(await c.handlers.handle("tabs.adopt", { tabId: 2 })).toMatchObject({
      ok: true,
    });
  });

  test("non-web pages can't be adopted", async () => {
    const c = fakeChrome([{ ...forum, url: "chrome://settings" }], 1);

    expect(await c.handlers.handle("tabs.adopt", { tabId: 1 })).toMatchObject({
      ok: false,
      error: { code: "bad_url" },
    });
  });

  test("tabs in the same window share one group", async () => {
    const c = fakeChrome([forum, mail], 1);

    await c.handlers.handle("tabs.adopt", { tabId: 1 });
    await c.handlers.handle("tabs.open", { url: "https://a.example/" });
    expect(c.groups.size).toBe(1);
  });
});

describe("group scoping", () => {
  test("per-tab methods refuse tabs outside the group", async () => {
    const c = fakeChrome([forum, mail], 1);

    for (const [method, params] of [
      ["page.read", { tabId: 2 }],
      ["page.click", { tabId: 2, ref: 1, snapshotId: 1 }],
      ["page.scroll", { tabId: 2, to: "bottom" }],
      ["tabs.navigate", { tabId: 2, url: "https://x.example" }],
      ["tabs.close", { tabId: 2 }],
      ["tabs.screenshot", { tabId: 2 }],
    ] as const) {
      expect(await c.handlers.handle(method, params)).toMatchObject({
        ok: false,
        error: { code: "not_in_group" },
      });
    }

    expect(c.log.filter((l) => l.startsWith("page"))).toEqual([]);
  });

  test("missing tab → no_tab", async () => {
    const c = fakeChrome([forum], 1);

    expect(await c.handlers.handle("page.read", { tabId: 99 })).toMatchObject({
      ok: false,
      error: { code: "no_tab" },
    });
  });
});

describe("open / navigate / close", () => {
  test("open refuses non-http(s)", async () => {
    const c = fakeChrome([], null);

    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome://settings",
    ]) {
      expect(await c.handlers.handle("tabs.open", { url })).toMatchObject({
        ok: false,
        error: { code: "bad_url" },
      });
    }

    expect(c.log).toEqual([]);
  });

  test("close: adopted tabs are released, opened tabs are closed", async () => {
    const c = fakeChrome([forum], 1);

    await c.handlers.handle("tabs.adopt", { tabId: 1 });
    const opened = await c.handlers.handle("tabs.open", {
      url: "https://a.example/",
    });
    const openedId = (opened as any).result.tabId;

    expect(await c.handlers.handle("tabs.close", { tabId: 1 })).toEqual({
      ok: true,
      result: "released",
    });
    expect(c.tabs.has(1)).toBe(true);
    expect(await c.handlers.handle("tabs.close", { tabId: openedId })).toEqual({
      ok: true,
      result: "closed",
    });
    expect(c.tabs.has(openedId)).toBe(false);
  });

  test("navigate in a group tab", async () => {
    const c = fakeChrome([forum], 1);

    await c.handlers.handle("tabs.adopt", { tabId: 1 });
    expect(
      await c.handlers.handle("tabs.navigate", {
        tabId: 1,
        url: "https://forum.example/t/1?page=2",
      })
    ).toMatchObject({
      ok: true,
      result: { url: "https://forum.example/t/1?page=2" },
    });
  });
});

describe("click", () => {
  async function adopted() {
    const c = fakeChrome([forum], 1);

    await c.handlers.handle("tabs.adopt", { tabId: 1 });

    return c;
  }

  test("page says navigate → the extension follows it with tabs.update", async () => {
    const c = await adopted();

    c.setPageReply({
      status: "navigate",
      url: "https://forum.example/t/1?page=2",
    });
    expect(
      await c.handlers.handle("page.click", { tabId: 1, ref: 3, snapshotId: 9 })
    ).toEqual({
      ok: true,
      result: { outcome: "navigated", url: "https://forum.example/t/1?page=2" },
    });
  });

  test("a navigate reply with a non-http URL is refused", async () => {
    const c = await adopted();

    c.setPageReply({ status: "navigate", url: "javascript:alert(1)" });
    expect(
      await c.handlers.handle("page.click", { tabId: 1, ref: 3, snapshotId: 9 })
    ).toMatchObject({
      ok: false,
      error: { code: "bad_url" },
    });
  });

  test("denied / stale replies map to error codes", async () => {
    const c = await adopted();

    c.setPageReply({ status: "denied", reason: "inside a form" });
    expect(
      await c.handlers.handle("page.click", { tabId: 1, ref: 3, snapshotId: 9 })
    ).toEqual({
      ok: false,
      error: { code: "denied", message: "inside a form" },
    });
    c.setPageReply({ status: "stale" });
    expect(
      await c.handlers.handle("page.click", { tabId: 1, ref: 3, snapshotId: 9 })
    ).toMatchObject({
      ok: false,
      error: { code: "stale_ref" },
    });
  });

  test("expanded in place", async () => {
    const c = await adopted();

    c.setPageReply({ status: "clicked", changed: true });
    expect(
      await c.handlers.handle("page.click", { tabId: 1, ref: 3, snapshotId: 9 })
    ).toMatchObject({
      ok: true,
      result: { outcome: "expanded" },
    });
  });
});

describe("list", () => {
  test("marks group membership and forgets groups Chrome closed", async () => {
    const c = fakeChrome([forum, mail], 1);

    await c.handlers.handle("tabs.adopt", { tabId: 1 });
    const res = (await c.handlers.handle("tabs.list", {})) as {
      result: ITabInfo[];
    };

    expect(res.result.map((t) => [t.tabId, t.inGroup])).toEqual([
      [1, true],
      [2, false],
    ]);
    c.groups.clear();
    const after = (await c.handlers.handle("tabs.list", {})) as {
      result: ITabInfo[];
    };

    expect(after.result.every((t) => !t.inGroup)).toBe(true);
    expect(c.state().groupIds).toEqual([]);
  });
});
