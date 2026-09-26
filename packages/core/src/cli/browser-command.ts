/** `/browser` + the boot chip for the Chrome research bridge. Pure text
 *  builders; the REPL supplies status, port and token. */
import type { BridgeStatus } from "../chrome-bridge";

export function browserChipText(status: BridgeStatus, port: number): string {
  switch (status) {
    case "connected":
      return `connected · :${String(port)} · /browser`;
    case "listening":
      return `waiting for the Chrome extension · :${String(port)} · /browser to pair`;
    case "outdated":
      return `the Chrome extension is outdated — rebuild it and reload it in chrome://extensions · /browser`;
    case "in-use":
      return `port ${String(port)} in use (another tsforge session drives Chrome) — tools off here`;
  }
}

export interface IBrowserReport {
  status: BridgeStatus | null;
  port: number;
  tokenPath: string;
  token: string | null;
}

const SETUP = [
  "  1. Build the extension:  bun run --cwd packages/chrome-extension build",
  "  2. chrome://extensions → Developer mode → Load unpacked → packages/chrome-extension/dist",
  "  3. Open the extension's options, paste the token below, and save.",
];

export function browserReportText(r: IBrowserReport): string {
  if (r.status === null) {
    return [
      "  browser: off — start tsforge with TSFORGE_BROWSER=1 (or /config → Tools → Chrome browser).",
      "  Lets the agent read pages in your real, logged-in Chrome (read + navigate only).",
      "",
    ].join("\n");
  }

  const lines = [`  browser: ${browserChipText(r.status, r.port)}`];

  if (r.status === "outdated") {
    lines.push(
      "",
      "  tsforge was updated and the extension it talks to is older:",
      SETUP[0] ?? "",
      "  2. chrome://extensions → tsforge → the reload ↻ button (your token stays)."
    );
  } else if (r.status !== "connected") {
    lines.push("", "  Pair the tsforge Chrome extension:", ...SETUP);
  }

  lines.push(
    "",
    `  token (${r.tokenPath}):`,
    `    ${r.token ?? "(not created yet)"}`,
    "",
    '  Then open the tab you want researched and ask, e.g. "read the whole thread in my active tab and take notes".',
    ""
  );

  return lines.join("\n");
}
