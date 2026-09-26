/**
 * Bridge request handlers — the extension decides, tsforge only asks. Every
 * per-tab method requires the tab to be in a tsforge group; adopting a user
 * tab requires it to be their active tab (or one they shared with the toolbar
 * button); navigation is http(s) only; clicks are resolved and re-checked by
 * the page agent. Chrome is reached only through the injected IChromeApi.
 */
import { GROUP_TITLE } from "../../core/src/chrome-bridge/chrome-bridge.constants";
import type {
  BridgeMethod,
  ITabInfo,
} from "../../core/src/chrome-bridge/chrome-bridge.types";
import { isRecord } from "../../core/src/lib/guards/guards";
import type {
  BridgeErrorCode,
  HandlerResult,
  IChromeApi,
  IHandlerState,
  IStateStore,
  ITab,
} from "./extension.types";
import { fetchUrlProblem } from "./fetch-policy";
import { isNavigableUrl } from "./url-policy";

class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string
  ) {
    super(message);
  }
}

function num(params: Record<string, unknown>, key: string): number {
  const v = params[key];

  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new BridgeError("internal", `missing \`${key}\``);
  }

  return v;
}

function vetUrl(raw: unknown): string {
  if (typeof raw !== "string" || !isNavigableUrl(raw)) {
    throw new BridgeError("bad_url", "only http(s) URLs can be opened");
  }

  return raw;
}

export class Handlers {
  constructor(
    private readonly api: IChromeApi,
    private readonly store: IStateStore
  ) {}

  async handle(
    method: BridgeMethod,
    params: Record<string, unknown>
  ): Promise<HandlerResult> {
    try {
      const state = await this.store.load();
      const result = await this.dispatch(method, params, state);

      await this.store.save(state);

      return { ok: true, result };
    } catch (err) {
      return err instanceof BridgeError
        ? { ok: false, error: { code: err.code, message: err.message } }
        : {
            ok: false,
            error: {
              code: "internal",
              message: err instanceof Error ? err.message : String(err),
            },
          };
    }
  }

  /** The user clicked the toolbar button on a tab: it may now be adopted. */
  async share(tabId: number): Promise<void> {
    const state = await this.store.load();

    if (!state.shared.includes(tabId)) {
      state.shared.push(tabId);
    }

    await this.store.save(state);
  }

  private dispatch(
    method: BridgeMethod,
    p: Record<string, unknown>,
    s: IHandlerState
  ): Promise<unknown> {
    switch (method) {
      case "tabs.list":
        return this.list(s);
      case "tabs.adopt":
        return this.adopt(num(p, "tabId"), s);
      case "tabs.open":
        return this.open(vetUrl(p.url), s);
      case "tabs.navigate":
        return this.navigate(num(p, "tabId"), p, s);
      case "tabs.close":
        return this.close(num(p, "tabId"), s);
      case "tabs.screenshot":
        return this.screenshot(num(p, "tabId"), s);
      case "page.read":
        return this.inPage(num(p, "tabId"), s, "snapshot", {});
      case "page.click":
        return this.click(num(p, "tabId"), p, s);
      case "page.scroll":
        return this.inPage(num(p, "tabId"), s, "scroll", { to: p.to });
      case "page.fetch":
        return this.fetch(num(p, "tabId"), p.url, s);
    }
  }

  private info(tab: ITab, s: IHandlerState): ITabInfo {
    return {
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      inGroup: s.groupIds.includes(tab.groupId),
      adopted: s.adopted.includes(tab.id),
    };
  }

  private async list(s: IHandlerState): Promise<ITabInfo[]> {
    await this.refreshGroups(s);

    return (await this.api.listTabs()).map((t) => this.info(t, s));
  }

  /** Drop group ids Chrome no longer has (the group was closed/ungrouped). */
  private async refreshGroups(s: IHandlerState): Promise<void> {
    const alive: number[] = [];

    for (const id of s.groupIds) {
      if ((await this.api.getGroup(id)) !== null) {
        alive.push(id);
      }
    }

    s.groupIds = alive;
  }

  private async requireTab(tabId: number): Promise<ITab> {
    const tab = await this.api.getTab(tabId);

    if (tab === null) {
      throw new BridgeError("no_tab", `tab ${String(tabId)} does not exist`);
    }

    return tab;
  }

  private async requireGroup(tabId: number, s: IHandlerState): Promise<ITab> {
    const tab = await this.requireTab(tabId);

    if (!s.groupIds.includes(tab.groupId)) {
      throw new BridgeError(
        "not_in_group",
        `tab ${String(tabId)} is not in the ${GROUP_TITLE} group`
      );
    }

    return tab;
  }

  /** Put a tab into the tsforge group of ITS window (grouping into a group in
   *  another window would move the tab), creating the group if needed. */
  private async ensureGroup(tab: ITab, s: IHandlerState): Promise<void> {
    await this.refreshGroups(s);

    let target: number | null = null;

    for (const id of s.groupIds) {
      if ((await this.api.getGroup(id))?.windowId === tab.windowId) {
        target = id;
      }
    }

    target ??=
      (await this.api.findGroup(tab.windowId, GROUP_TITLE))?.id ?? null;

    const groupId = await this.api.groupTabs([tab.id], target ?? undefined);

    if (target === null) {
      await this.api.labelGroup(groupId, GROUP_TITLE);
    }

    if (!s.groupIds.includes(groupId)) {
      s.groupIds.push(groupId);
    }
  }

  private async adopt(tabId: number, s: IHandlerState): Promise<ITabInfo> {
    const tab = await this.requireTab(tabId);
    const permitted =
      (await this.api.activeTabId()) === tabId || s.shared.includes(tabId);

    if (!permitted) {
      throw new BridgeError(
        "denied",
        `tab ${String(tabId)} is not the user's active tab — ask the user to switch to it, or to click the tsforge toolbar button on it`
      );
    }

    if (!isNavigableUrl(tab.url)) {
      throw new BridgeError(
        "bad_url",
        "only web pages (http/https) can be adopted"
      );
    }

    await this.ensureGroup(tab, s);

    if (!s.adopted.includes(tabId)) {
      s.adopted.push(tabId);
    }

    return this.info(await this.requireTab(tabId), s);
  }

  private async open(url: string, s: IHandlerState): Promise<ITabInfo> {
    const tab = await this.api.createTab(url);

    await this.ensureGroup(tab, s);
    await this.api.waitForLoad(tab.id);

    return this.info(await this.requireTab(tab.id), s);
  }

  private async navigate(
    tabId: number,
    p: Record<string, unknown>,
    s: IHandlerState
  ): Promise<ITabInfo> {
    await this.requireGroup(tabId, s);

    if (p.back === true) {
      await this.api.goBack(tabId);
    } else {
      await this.api.navigate(tabId, vetUrl(p.url));
    }

    await this.api.waitForLoad(tabId);

    return this.info(await this.requireTab(tabId), s);
  }

  private async close(
    tabId: number,
    s: IHandlerState
  ): Promise<"closed" | "released"> {
    await this.requireGroup(tabId, s);

    if (s.adopted.includes(tabId)) {
      await this.api.ungroupTabs([tabId]);
      s.adopted = s.adopted.filter((id) => id !== tabId);
      s.shared = s.shared.filter((id) => id !== tabId);

      return "released";
    }

    await this.api.removeTab(tabId);

    return "closed";
  }

  private async screenshot(
    tabId: number,
    s: IHandlerState
  ): Promise<{ dataUrl: string }> {
    const tab = await this.requireGroup(tabId, s);

    return { dataUrl: await this.api.captureTab(tab) };
  }

  private async inPage(
    tabId: number,
    s: IHandlerState,
    method: "snapshot" | "scroll",
    params: Record<string, unknown>
  ): Promise<unknown> {
    const tab = await this.requireGroup(tabId, s);

    if (!isNavigableUrl(tab.url)) {
      throw new BridgeError("bad_url", "this tab is not showing a web page");
    }

    return this.api.runInPage(tabId, method, params);
  }

  /** Same-origin GET inside a group tab, for built-in site plugins. The URL is
   *  vetted here against the tab's live origin AND again in the page. */
  private async fetch(
    tabId: number,
    url: unknown,
    s: IHandlerState
  ): Promise<unknown> {
    const tab = await this.requireGroup(tabId, s);
    const problem = fetchUrlProblem(url, tab.url);

    if (problem !== null) {
      throw new BridgeError("denied", problem);
    }

    const res = await this.api.runInPage(tabId, "fetch", { url });

    if (!isRecord(res) || typeof res.error === "string") {
      throw new BridgeError(
        "denied",
        isRecord(res) && typeof res.error === "string"
          ? res.error
          : "page.fetch: no reply from the page"
      );
    }

    return res;
  }

  private async click(
    tabId: number,
    p: Record<string, unknown>,
    s: IHandlerState
  ): Promise<{ outcome: "navigated" | "expanded" | "none"; url: string }> {
    const tab = await this.requireGroup(tabId, s);
    const res = await this.api.runInPage(tabId, "click", {
      ref: num(p, "ref"),
      snapshotId: num(p, "snapshotId"),
    });

    if (!isRecord(res) || res.status === "stale") {
      throw new BridgeError(
        "stale_ref",
        "ref is from an older read of the page"
      );
    }

    if (res.status === "denied") {
      throw new BridgeError(
        "denied",
        typeof res.reason === "string" ? res.reason : "not clickable"
      );
    }

    if (res.status === "navigate") {
      await this.api.navigate(tabId, vetUrl(res.url));
      await this.api.waitForLoad(tabId);

      return { outcome: "navigated", url: (await this.requireTab(tabId)).url };
    }

    return {
      outcome: res.changed === true ? "expanded" : "none",
      url: tab.url,
    };
  }
}
