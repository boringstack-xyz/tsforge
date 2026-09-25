/**
 * The in-page half of the extension, run in the ISOLATED world (page scripts
 * can't see or call it). Holds the element table behind the latest snapshot
 * and performs clicks/scrolls — re-checking the click policy on the live
 * element at click time.
 */
import { classifyClickable } from "./click-policy";
import type { PageClickResult } from "./extension.types";
import { snapshotDocument } from "./snapshot";

export interface IPageEnv {
  document: Document;
  window: {
    innerHeight: number;
    scrollY: number;
    scrollBy(x: number, y: number): void;
    scrollTo(x: number, y: number): void;
    location: { href: string };
  };
  sleep: (ms: number) => Promise<void>;
  /** Resolves true if the DOM mutated, once it has been quiet for a while. */
  waitForQuiet: () => Promise<boolean>;
}

export interface IPageSnapshotOut {
  snapshotId: number;
  url: string;
  title: string;
  html: string;
  refs: ReturnType<typeof snapshotDocument>["refs"];
  truncated: boolean;
}

export interface IScrollOut {
  scrollY: number;
  scrollHeight: number;
  atBottom: boolean;
  grew: boolean;
}

export interface IPageAgent {
  snapshot(): IPageSnapshotOut;
  click(ref: number, snapshotId: number): Promise<PageClickResult>;
  scroll(to: string): Promise<IScrollOut>;
}

const GROW_WAIT_MS = 2500;
const GROW_POLL_MS = 250;

function stripHash(href: string): string {
  const i = href.indexOf("#");

  return i === -1 ? href : href.slice(0, i);
}

function scrollHeight(doc: Document): number {
  return doc.scrollingElement?.scrollHeight ?? doc.body.scrollHeight;
}

export function createPageAgent(env: IPageEnv): IPageAgent {
  // A random base so a snapshot id from a previous document (new isolated
  // world after navigation) can't collide with one issued here.
  let nextId = Math.floor(Math.random() * 1_000_000) * 1000;
  let current: { id: number; elements: Map<number, WeakRef<Element>> } | null =
    null;

  const resolve = (ref: number, snapshotId: number): Element | null => {
    if (current?.id !== snapshotId) {
      return null;
    }

    const el = current.elements.get(ref)?.deref();

    return el?.isConnected === true ? el : null;
  };

  return {
    snapshot() {
      const snap = snapshotDocument(env.document);

      nextId += 1;
      current = {
        id: nextId,
        elements: new Map(
          [...snap.elements].map(([ref, el]) => [ref, new WeakRef(el)])
        ),
      };

      return {
        snapshotId: nextId,
        url: env.window.location.href,
        title: env.document.title,
        html: snap.html,
        refs: snap.refs,
        truncated: snap.truncated,
      };
    },

    async click(ref, snapshotId) {
      const el = resolve(ref, snapshotId);

      if (el === null) {
        return { status: "stale" };
      }

      const verdict = classifyClickable(el);

      if (!verdict.allow) {
        return { status: "denied", reason: verdict.reason };
      }

      const here = stripHash(env.window.location.href);

      if (verdict.href !== undefined && stripHash(verdict.href) !== here) {
        // Another page: the background follows it with tabs.update — no page
        // script runs, and target=_blank can't escape the group.
        return { status: "navigate", url: verdict.href };
      }

      const view = env.document.defaultView;

      if (view === null) {
        return { status: "stale" };
      }

      el.dispatchEvent(
        new view.MouseEvent("click", { bubbles: true, cancelable: true })
      );

      return { status: "clicked", changed: await env.waitForQuiet() };
    },

    async scroll(to) {
      const doc = env.document;
      const before = scrollHeight(doc);
      const win = env.window;

      if (to === "bottom") {
        win.scrollTo(0, before);
      } else {
        win.scrollBy(0, win.innerHeight * (to === "down" ? 0.5 : 0.9));
      }

      let after = scrollHeight(doc);

      for (
        let waited = 0;
        after === before && waited < GROW_WAIT_MS;
        waited += GROW_POLL_MS
      ) {
        await env.sleep(GROW_POLL_MS);
        after = scrollHeight(doc);
      }

      return {
        scrollY: win.scrollY,
        scrollHeight: after,
        atBottom: win.scrollY + win.innerHeight >= after - 2,
        grew: after > before,
      };
    },
  };
}
