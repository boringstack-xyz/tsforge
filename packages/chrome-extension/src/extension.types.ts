import type {
  BridgeErrorCode,
  IRefInfo,
  RefKind,
} from "../../core/src/chrome-bridge/chrome-bridge.types";

export type { BridgeErrorCode, IRefInfo, RefKind };

/** What the click policy decided about one element. */
export type ClickVerdict =
  | { allow: true; kind: RefKind; href?: string }
  | { allow: false; reason: string };

/** Result of a snapshot walk: sanitized HTML, the model-facing ref table, and
 *  the live elements behind each ref (kept only in the isolated world). */
export interface ISnapshotResult {
  html: string;
  refs: IRefInfo[];
  elements: Map<number, Element>;
  truncated: boolean;
}

/** What the page agent reports back for a click. */
export type PageClickResult =
  | { status: "stale" }
  | { status: "denied"; reason: string }
  | { status: "navigate"; url: string }
  | { status: "clicked"; changed: boolean };

/** The tab fields the handlers need (a subset of chrome.tabs.Tab). */
export interface ITab {
  id: number;
  windowId: number;
  groupId: number;
  title: string;
  url: string;
  active: boolean;
}

export interface IGroup {
  id: number;
  windowId: number;
  title: string;
}

/** Everything the request handlers need from Chrome — the real adapter lives
 *  in background.ts; tests pass a fake. */
export interface IChromeApi {
  listTabs(): Promise<ITab[]>;
  getTab(tabId: number): Promise<ITab | null>;
  /** The active tab of the last-focused normal window. */
  activeTabId(): Promise<number | null>;
  createTab(url: string): Promise<ITab>;
  navigate(tabId: number, url: string): Promise<void>;
  goBack(tabId: number): Promise<void>;
  removeTab(tabId: number): Promise<void>;
  waitForLoad(tabId: number): Promise<void>;
  getGroup(groupId: number): Promise<IGroup | null>;
  findGroup(windowId: number, title: string): Promise<IGroup | null>;
  /** Group tabs; into `groupId` when given, else a new group. Returns its id. */
  groupTabs(tabIds: number[], groupId?: number): Promise<number>;
  labelGroup(groupId: number, title: string): Promise<void>;
  ungroupTabs(tabIds: number[]): Promise<void>;
  /** Inject the page agent (idempotent) and send it one command. */
  runInPage(
    tabId: number,
    method: PageMethod,
    params: Record<string, unknown>
  ): Promise<unknown>;
  captureTab(tab: ITab): Promise<string>;
}

export type PageMethod = "snapshot" | "click" | "scroll";

/** Handler state that must survive service-worker restarts. */
export interface IHandlerState {
  groupIds: number[];
  adopted: number[];
  shared: number[];
}

export interface IStateStore {
  load(): Promise<IHandlerState>;
  save(state: IHandlerState): Promise<void>;
}

export type HandlerResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: BridgeErrorCode; message: string } };
