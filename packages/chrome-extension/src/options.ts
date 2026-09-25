/** Options page: paste the pairing token, optionally change the port, and see
 *  the live connection status. */
import { DEFAULT_BRIDGE_PORT } from "../../core/src/chrome-bridge/chrome-bridge.constants";

const STATUS_TEXT: Readonly<Record<string, string>> = {
  connected: "Connected to tsforge.",
  connecting: "Connecting…",
  waiting: "Waiting for tsforge (start it with TSFORGE_BROWSER=1).",
  "bad-token": "tsforge rejected the token — paste the one /browser prints.",
  "no-token": "Paste the token from tsforge's /browser command.",
};

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);

  if (el === null) {
    throw new Error(`options.html is missing #${id}`);
  }

  return el;
}

function input(id: string): HTMLInputElement {
  const el = byId(id);

  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }

  return el;
}

async function showStatus(): Promise<void> {
  const got: Record<string, unknown> =
    await chrome.storage.session.get("tsforgeStatus");
  const status =
    typeof got.tsforgeStatus === "string" ? got.tsforgeStatus : "no-token";

  byId("status").textContent = STATUS_TEXT[status] ?? status;
}

async function init(): Promise<void> {
  const got: Record<string, unknown> = await chrome.storage.local.get([
    "token",
    "port",
  ]);

  input("token").value = typeof got.token === "string" ? got.token : "";
  input("port").value = String(
    typeof got.port === "number" ? got.port : DEFAULT_BRIDGE_PORT
  );

  byId("save").addEventListener("click", () => {
    const port = Number(input("port").value);

    void chrome.storage.local.set({
      token: input("token").value.trim(),
      port:
        Number.isInteger(port) && port >= 1024 && port <= 65_535
          ? port
          : DEFAULT_BRIDGE_PORT,
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && "tsforgeStatus" in changes) {
      void showStatus();
    }
  });

  await showStatus();
}

void init();
