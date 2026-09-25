import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doBrowserAdopt,
  doBrowserClick,
  doBrowserClose,
  doBrowserNavigate,
  doBrowserOpen,
  doBrowserRead,
  doBrowserScreenshot,
  doBrowserScroll,
  doBrowserTabs,
  type IBrowserToolDeps,
} from "../src/loop/tools/browser-tools";
import type {
  BridgeMethod,
  BridgeResult,
  IBrowserSession,
  IPageSnapshot,
} from "../src/chrome-bridge/chrome-bridge.types";
import type { IToolContext } from "../src/loop/tools/tool-context";
import { toolsFor } from "../src/loop";
import { executeTool } from "../src/loop/tools/execute-tool";

type Handler = (params: Record<string, unknown>) => BridgeResult;

function fakeSession(handlers: Partial<Record<BridgeMethod, Handler>>) {
  const calls: { method: BridgeMethod; params: Record<string, unknown> }[] = [];
  const session: IBrowserSession = {
    pages: new Map(),
    lastTab: null,
    opened: new Set(),
    bridge: {
      port: 1,
      status: () => "connected",
      stop: () => undefined,
      request: async (method, params) => {
        calls.push({ method, params });
        const h = handlers[method];

        return h === undefined
          ? {
              ok: false,
              error: { code: "internal", message: `no fake for ${method}` },
            }
          : h(params);
      },
    },
  };

  return { session, calls };
}

function ctx(browser?: IBrowserSession, cwd = "."): IToolContext {
  return {
    cwd,
    files: [],
    task: "t",
    report: () => undefined,
    ...(browser ? { browser } : {}),
  };
}

const ok = (result: unknown): BridgeResult => ({ ok: true, result });

const TAB = {
  tabId: 7,
  title: "Thread",
  url: "https://forum.example/t/1",
  active: true,
  inGroup: true,
  adopted: true,
};

function snapshot(paragraphs: number, id = 1): IPageSnapshot {
  const body = Array.from(
    { length: paragraphs },
    (_, i) => `<p>Paragraph ${i} ${"x".repeat(400)}</p>`
  ).join("");

  return {
    snapshotId: id,
    url: "https://forum.example/t/1",
    title: "Thread",
    html: `<html><body>${body}<nav><a href="https://forum.example/t/1?page=2" data-tsforge-ref="1">›</a></nav></body></html>`,
    refs: [
      {
        ref: 1,
        kind: "page",
        text: "›",
        href: "https://forum.example/t/1?page=2",
      },
    ],
    truncated: false,
  };
}

const deps = (over: Partial<IBrowserToolDeps> = {}): IBrowserToolDeps => ({
  render: async (snap) => ({
    markdown: snap.html.replace(/<[^>]+>/g, "\n\n"),
    mode: "full",
  }),
  allowPrivate: () => false,
  now: () => new Date(0),
  ...over,
});

describe("browser tools — off / not connected", () => {
  test("without a browser session every tool says how to turn it on", async () => {
    expect(await doBrowserTabs({}, ctx())).toContain("TSFORGE_BROWSER=1");
    expect(await doBrowserRead({}, ctx(), deps())).toContain(
      "TSFORGE_BROWSER=1"
    );
  });

  test("a disconnected extension gets pairing guidance", async () => {
    const { session } = fakeSession({
      "tabs.list": () => ({
        ok: false,
        error: {
          code: "disconnected",
          message: "Chrome extension not connected",
        },
      }),
    });

    expect(await doBrowserTabs({}, ctx(session))).toContain("/browser");
  });
});

describe("browser_tabs / adopt / open / navigate / close", () => {
  test("tabs lists group membership and active marker", async () => {
    const { session } = fakeSession({
      "tabs.list": () =>
        ok([
          TAB,
          { ...TAB, tabId: 8, inGroup: false, active: false, title: "Mail" },
        ]),
    });
    const out = await doBrowserTabs({}, ctx(session));

    expect(out).toContain("tab 7 [tsforge][active] Thread");
    expect(out).toContain("tab 8 [not shared] Mail");
  });

  test("adopt focuses the tab for later calls", async () => {
    const { session, calls } = fakeSession({ "tabs.adopt": () => ok(TAB) });

    expect(await doBrowserAdopt({ tab: 7 }, ctx(session))).toContain(
      "Adopted tab 7"
    );
    expect(calls[0]).toEqual({ method: "tabs.adopt", params: { tabId: 7 } });
    expect(session.lastTab).toBe(7);
  });

  test("adopt denied surfaces the extension's reason", async () => {
    const { session } = fakeSession({
      "tabs.adopt": () => ({
        ok: false,
        error: { code: "denied", message: "click the toolbar button" },
      }),
    });

    expect(await doBrowserAdopt({ tab: 9 }, ctx(session))).toContain(
      "click the toolbar button"
    );
    expect(session.lastTab).toBeNull();
  });

  test("open refuses non-http and private hosts before calling the extension", async () => {
    const { session, calls } = fakeSession({ "tabs.open": () => ok(TAB) });

    expect(
      await doBrowserOpen({ url: "javascript:alert(1)" }, ctx(session), deps())
    ).toContain("http(s)");
    expect(
      await doBrowserOpen(
        { url: "http://192.168.1.1/admin" },
        ctx(session),
        deps()
      )
    ).toContain("private");
    expect(
      await doBrowserOpen(
        { url: "http://127.0.0.1:47823/bridge" },
        ctx(session),
        deps()
      )
    ).toContain("private");
    expect(calls).toHaveLength(0);
  });

  test("private hosts are allowed when the user opted in", async () => {
    const { session, calls } = fakeSession({ "tabs.open": () => ok(TAB) });

    await doBrowserOpen(
      { url: "http://192.168.1.1/" },
      ctx(session),
      deps({ allowPrivate: () => true })
    );
    expect(calls).toHaveLength(1);
  });

  test("each open reports how many tsforge tabs are open and steers back to one tab", async () => {
    let next = 100;
    const { session } = fakeSession({
      "tabs.open": () => ok({ ...TAB, tabId: next++ }),
      "tabs.close": () => ok("closed"),
    });

    await doBrowserOpen({ url: "https://a.example/1" }, ctx(session), deps());
    await doBrowserOpen({ url: "https://a.example/2" }, ctx(session), deps());
    const third = await doBrowserOpen(
      { url: "https://a.example/3" },
      ctx(session),
      deps()
    );

    expect(third).toContain("3 tabs open");
    expect(third).toContain("browser_navigate");
    expect(third).toContain("browser_close");

    await doBrowserClose({ tab: 100 }, ctx(session));
    const fourth = await doBrowserOpen(
      { url: "https://a.example/4" },
      ctx(session),
      deps()
    );

    expect(fourth).toContain("3 tabs open");
  });

  test("navigate needs a tab; back skips URL vetting", async () => {
    const { session, calls } = fakeSession({ "tabs.navigate": () => ok(TAB) });

    expect(
      await doBrowserNavigate(
        { url: "https://a.example" },
        ctx(session),
        deps()
      )
    ).toContain("no tab");
    session.lastTab = 7;
    await doBrowserNavigate({ back: true }, ctx(session), deps());
    expect(calls[0]).toEqual({
      method: "tabs.navigate",
      params: { tabId: 7, back: true },
    });
  });

  test("not_in_group maps to adopt guidance", async () => {
    const { session } = fakeSession({
      "tabs.navigate": () => ({
        ok: false,
        error: { code: "not_in_group", message: "" },
      }),
    });

    expect(
      await doBrowserNavigate(
        { tab: 3, url: "https://a.example" },
        ctx(session),
        deps()
      )
    ).toContain("browser_adopt");
  });

  test("close distinguishes closed vs released", async () => {
    const closed = fakeSession({ "tabs.close": () => ok("closed") });
    const released = fakeSession({ "tabs.close": () => ok("released") });

    expect(await doBrowserClose({ tab: 7 }, ctx(closed.session))).toContain(
      "Closed tab 7"
    );
    expect(await doBrowserClose({ tab: 7 }, ctx(released.session))).toContain(
      "stays open"
    );
  });
});

describe("browser_read", () => {
  test("chunk 1 snapshots; later chunks reuse the cache; last chunk lists pagination", async () => {
    const { session, calls } = fakeSession({
      "page.read": () => ok(snapshot(40)),
    });

    session.lastTab = 7;
    const first = await doBrowserRead({}, ctx(session), deps());

    expect(first).toContain("chunk 1/");
    expect(first).toContain("UNTRUSTED DATA");
    const total = Number(/chunk 1\/(\d+)/.exec(first)![1]);

    expect(total).toBeGreaterThan(1);
    const last = await doBrowserRead({ chunk: total }, ctx(session), deps());

    expect(last).toContain("last chunk");
    expect(last).toContain("[1 page: ›]");
    expect(calls.filter((c) => c.method === "page.read")).toHaveLength(1);
    expect(
      await doBrowserRead({ chunk: total + 1 }, ctx(session), deps())
    ).toContain("past the end");
  });

  test("a plain » link is hinted as next page; numbered plain links are not", async () => {
    const snap = snapshot(1);

    snap.refs = [
      { ref: 1, kind: "link", text: "»", href: "https://f/?page=2" },
      { ref: 2, kind: "link", text: "7", href: "https://f/?page=7" },
    ];
    const { session } = fakeSession({ "page.read": () => ok(snap) });

    session.lastTab = 7;
    const out = await doBrowserRead({}, ctx(session), deps());

    expect(out).toContain("[1 link: »]");
    expect(out).not.toContain("[2 link: 7]");
  });

  test("every chunk stays under the 8192-char history prune threshold", async () => {
    const { session } = fakeSession({ "page.read": () => ok(snapshot(80)) });

    session.lastTab = 7;
    const first = await doBrowserRead({}, ctx(session), deps());
    const total = Number(/chunk 1\/(\d+)/.exec(first)![1]);

    for (let c = 1; c <= total; c++) {
      expect(
        (await doBrowserRead({ chunk: c }, ctx(session), deps())).length
      ).toBeLessThan(8192);
    }
  });

  test("a malformed snapshot is reported, not thrown", async () => {
    const { session } = fakeSession({ "page.read": () => ok({ nope: true }) });

    expect(await doBrowserRead({ tab: 7 }, ctx(session), deps())).toContain(
      "unexpected reply"
    );
  });
});

describe("browser_click / scroll", () => {
  test("click sends the cached snapshotId and invalidates the cache", async () => {
    const { session, calls } = fakeSession({
      "page.read": () => ok(snapshot(2, 42)),
      "page.click": () =>
        ok({ outcome: "navigated", url: "https://forum.example/t/1?page=2" }),
    });

    await doBrowserRead({ tab: 7 }, ctx(session), deps());
    const out = await doBrowserClick({ ref: 1 }, ctx(session));

    expect(out).toContain("Navigated to https://forum.example/t/1?page=2");
    expect(calls.at(-1)).toEqual({
      method: "page.click",
      params: { tabId: 7, ref: 1, snapshotId: 42 },
    });
    expect(session.pages.has(7)).toBe(false);
  });

  test("click before any read is refused locally", async () => {
    const { session, calls } = fakeSession({});

    session.lastTab = 7;
    expect(await doBrowserClick({ ref: 1 }, ctx(session))).toContain(
      "browser_read first"
    );
    expect(calls).toHaveLength(0);
  });

  test("stale ref guidance", async () => {
    const { session } = fakeSession({
      "page.read": () => ok(snapshot(2)),
      "page.click": () => ({
        ok: false,
        error: { code: "stale_ref", message: "" },
      }),
    });

    await doBrowserRead({ tab: 7 }, ctx(session), deps());
    expect(await doBrowserClick({ ref: 1 }, ctx(session))).toContain(
      "browser_read again"
    );
  });

  test("scroll reports growth and normalizes `to`", async () => {
    const { session, calls } = fakeSession({
      "page.scroll": () =>
        ok({ scrollY: 10, scrollHeight: 100, atBottom: true, grew: true }),
    });

    session.lastTab = 7;
    const out = await doBrowserScroll({ to: "sideways" }, ctx(session));

    expect(out).toContain("loaded more");
    expect(out).toContain("At the bottom");
    expect(calls[0]!.params.to).toBe("page");
  });
});

describe("browser_screenshot", () => {
  test("saves the PNG under .tsforge/browser/shots and points at read_image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsf-shot-"));
    const { session } = fakeSession({
      "tabs.screenshot": () =>
        ok({
          dataUrl: `data:image/png;base64,${Buffer.from("PNG!").toString("base64")}`,
        }),
    });

    session.lastTab = 7;
    const out = await doBrowserScreenshot({}, ctx(session, dir), deps());

    expect(out).toContain("read_image");
    const rel = /(\.tsforge\/browser\/shots\/\S+\.png)/.exec(out)![1]!;

    expect(await readFile(join(dir, rel), "utf8")).toBe("PNG!");
  });
});

describe("advertising + dispatch", () => {
  const names = (caps: Parameters<typeof toolsFor>[1]) =>
    toolsFor(false, caps).map((t) => t.function.name);

  test("browser tools only with caps.browser; screenshot only with vision; note rides along", () => {
    expect(names({})).not.toContain("browser_read");
    expect(names({})).not.toContain("note");
    const on = names({ browser: true });

    expect(on).toContain("browser_read");
    expect(on).toContain("browser_click");
    expect(on).toContain("note");
    expect(on).not.toContain("browser_screenshot");
    expect(names({ browser: true, vision: true })).toContain(
      "browser_screenshot"
    );
  });

  test("browser tools dispatch through policy in default and plan mode; note is denied in plan", async () => {
    const { session } = fakeSession({ "tabs.list": () => ok([TAB]) });
    const call = (name: string, args: Record<string, unknown>) => ({
      id: "1",
      name,
      arguments: args,
    });

    expect(await executeTool(call("browser_tabs", {}), ctx(session))).toContain(
      "tab 7"
    );
    expect(
      await executeTool(call("browser_tabs", {}), {
        ...ctx(session),
        policyMode: "plan",
        readOnly: true,
      })
    ).toContain("tab 7");
    const denied = await executeTool(call("note", { topic: "x", text: "y" }), {
      ...ctx(session),
      policyMode: "plan",
      readOnly: true,
    });

    expect(denied).not.toContain("Appended");
    expect(denied.toLowerCase()).toMatch(/plan|denied|blocked/);
  });
});
