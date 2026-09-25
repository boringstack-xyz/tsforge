/**
 * Entry injected into a tsforge-group tab (chrome.scripting, ISOLATED world).
 * Installs the page agent once per document and answers commands sent by the
 * background via chrome.tabs.sendMessage — only from this extension.
 */
import { isRecord } from "../../core/src/lib/guards/guards";
import { createPageAgent, type IPageAgent } from "./page-agent";

const INSTALLED = "__tsforgePageAgentInstalled";
const QUIET_MS = 400;
const QUIET_MAX_MS = 5000;

function waitForQuiet(): Promise<boolean> {
  return new Promise((resolve) => {
    let changed = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;

    const done = (): void => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      resolve(changed);
    };

    const observer = new MutationObserver(() => {
      changed = true;
      clearTimeout(quiet);
      quiet = setTimeout(done, QUIET_MS);
    });
    const cap = setTimeout(done, QUIET_MAX_MS);

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    quiet = setTimeout(done, QUIET_MS);
  });
}

async function dispatch(
  agent: IPageAgent,
  msg: Record<string, unknown>
): Promise<unknown> {
  const params = isRecord(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "snapshot":
      return agent.snapshot();
    case "click":
      return agent.click(
        typeof params.ref === "number" ? params.ref : -1,
        typeof params.snapshotId === "number" ? params.snapshotId : -1
      );
    case "scroll":
      return agent.scroll(typeof params.to === "string" ? params.to : "page");
    default:
      return { error: "unknown page method" };
  }
}

function install(): void {
  const agent = createPageAgent({
    document,
    window,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    waitForQuiet,
  });

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      !isRecord(msg) ||
      msg.tsforge !== true
    ) {
      return false;
    }

    dispatch(agent, msg).then(sendResponse, (err: unknown) => {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });

    return true;
  });
}

if (Reflect.get(globalThis, INSTALLED) !== true) {
  Reflect.set(globalThis, INSTALLED, true);
  install();
}
