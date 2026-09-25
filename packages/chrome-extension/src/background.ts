/**
 * Service worker wiring only: the real chrome.* adapter behind IChromeApi, the
 * bridge connection, the keep-alive alarm, and the toolbar "share this tab"
 * button. Decisions live in handlers.ts / click-policy.ts / connection.ts.
 */
import { DEFAULT_BRIDGE_PORT } from "../../core/src/chrome-bridge/chrome-bridge.constants";
import { Connection, type ConnectionStatus, type IWsLike } from "./connection";
import type {
  IChromeApi,
  IGroup,
  IHandlerState,
  IStateStore,
  ITab,
  PageMethod,
} from "./extension.types";
import { Handlers } from "./handlers";

const LOAD_TIMEOUT_MS = 25_000;
const STATE_KEY = "tsforgeHandlerState";
const ALARM = "tsforge-keepalive";

function toTab(t: chrome.tabs.Tab): ITab | null {
  return t.id === undefined
    ? null
    : {
        id: t.id,
        windowId: t.windowId,
        groupId: t.groupId,
        title: t.title ?? "",
        url: t.url ?? "",
        active: t.active,
      };
}

function toGroup(g: chrome.tabGroups.TabGroup): IGroup {
  return { id: g.id, windowId: g.windowId, title: g.title ?? "" };
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo): void => {
      if (id === tabId && info.status === "complete") {
        done();
      }
    };

    const timer = setTimeout(done, LOAD_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then(
      (t) => {
        if (t.status === "complete" && t.pendingUrl === undefined) {
          done();
        }
      },
      () => {
        done();
      }
    );
  });
}

async function runInPage(
  tabId: number,
  method: PageMethod,
  params: Record<string, unknown>
): Promise<unknown> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  const reply: unknown = await chrome.tabs.sendMessage(tabId, {
    tsforge: true,
    method,
    params,
  });

  return reply;
}

const api: IChromeApi = {
  listTabs: async () =>
    (await chrome.tabs.query({})).flatMap((t) => toTab(t) ?? []),
  getTab: async (tabId) => {
    try {
      return toTab(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  },
  activeTabId: async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });

    return tab?.id ?? null;
  },
  createTab: async (url) => {
    const tab = toTab(await chrome.tabs.create({ url, active: false }));

    if (tab === null) {
      throw new Error("Chrome did not return the new tab");
    }

    return tab;
  },
  navigate: async (tabId, url) => {
    await chrome.tabs.update(tabId, { url });
  },
  goBack: (tabId) => chrome.tabs.goBack(tabId),
  removeTab: (tabId) => chrome.tabs.remove(tabId),
  waitForLoad,
  getGroup: async (groupId) => {
    try {
      return toGroup(await chrome.tabGroups.get(groupId));
    } catch {
      return null;
    }
  },
  findGroup: async (windowId, title) => {
    const [group] = await chrome.tabGroups.query({ windowId, title });

    return group === undefined ? null : toGroup(group);
  },
  groupTabs: (tabIds, groupId) =>
    chrome.tabs.group(
      groupId === undefined
        ? { tabIds: [tabIds[0] ?? -1, ...tabIds.slice(1)] }
        : { tabIds: [tabIds[0] ?? -1, ...tabIds.slice(1)], groupId }
    ),
  labelGroup: async (groupId, title) => {
    await chrome.tabGroups.update(groupId, {
      title,
      color: "blue",
      collapsed: false,
    });
  },
  ungroupTabs: (tabIds) =>
    chrome.tabs.ungroup([tabIds[0] ?? -1, ...tabIds.slice(1)]),
  runInPage,
  captureTab: async (tab) => {
    // captureVisibleTab shoots the window's ACTIVE tab — bring ours forward.
    await chrome.tabs.update(tab.id, { active: true });

    return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  },
};

function isState(v: unknown): v is IHandlerState {
  return (
    typeof v === "object" &&
    v !== null &&
    "groupIds" in v &&
    Array.isArray(v.groupIds) &&
    "adopted" in v &&
    Array.isArray(v.adopted) &&
    "shared" in v &&
    Array.isArray(v.shared)
  );
}

/** storage.session survives service-worker restarts (not browser restarts). */
const store: IStateStore = {
  load: async () => {
    const got: Record<string, unknown> =
      await chrome.storage.session.get(STATE_KEY);
    const v = got[STATE_KEY];

    return isState(v) ? v : { groupIds: [], adopted: [], shared: [] };
  },
  save: (state) => chrome.storage.session.set({ [STATE_KEY]: state }),
};

const handlers = new Handlers(api, store);

function setStatus(status: ConnectionStatus): void {
  void chrome.storage.session.set({ tsforgeStatus: status });
  void chrome.action.setBadgeText({ text: status === "connected" ? "on" : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

function openSocket(url: string): IWsLike {
  const ws = new WebSocket(url);
  const like: IWsLike = {
    send: (data) => {
      ws.send(data);
    },
    close: () => {
      ws.close();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  ws.onopen = () => like.onopen?.();
  ws.onmessage = (ev: MessageEvent<unknown>) =>
    like.onmessage?.({ data: ev.data });
  ws.onclose = (ev) => like.onclose?.({ code: ev.code });
  ws.onerror = () => like.onerror?.();

  return like;
}

const connection = new Connection({
  createSocket: openSocket,
  handle: (method, params) => handlers.handle(method, params),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => {
    if (typeof h === "number") {
      clearTimeout(h);
    }
  },
  onStatus: setStatus,
  version: chrome.runtime.getManifest().version,
});

async function loadConfig(): Promise<void> {
  const got: Record<string, unknown> = await chrome.storage.local.get([
    "token",
    "port",
  ]);
  const token = typeof got.token === "string" ? got.token.trim() : "";
  const port = typeof got.port === "number" ? got.port : DEFAULT_BRIDGE_PORT;

  connection.configure({ token, port });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("token" in changes || "port" in changes)) {
    void loadConfig();
  }
});

// MV3 service workers die when idle; the alarm wakes this one to retry while
// tsforge isn't running (WebSocket traffic keeps it alive once connected).
void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    connection.ensure();
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    void handlers.share(tab.id);
    void chrome.action.setBadgeText({ tabId: tab.id, text: "✓" });
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void chrome.runtime.openOptionsPage();
  }
});

void loadConfig();
