/**
 * "Could not parse CSS stylesheet" (jsdom) was printed with console.error
 * straight over the interactive UI during web_fetch, scrolling the screen and
 * leaving duplicated header rows. Two layers keep it off the terminal.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderSnapshot } from "../src/chrome-bridge/page-render";
import { divertStrayConsole } from "../src/cli/stray-console";
import {
  htmlToReadableMarkdown,
  loadHtmlLibs,
  quietDocument,
} from "../src/lib/html";

/** Broken CSS jsdom can't parse — the real-world trigger. */
const BAD_CSS_PAGE = `<html><head><style>@media (min-width:1px){ .a{color:red} @@@{{{ }</style></head>
<body><article><h1>Title</h1><p>${"Readable body text. ".repeat(40)}</p></article></body></html>`;

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

/** Capture console.error/warn for the duration of a test. */
function capture(): string[] {
  const seen: string[] = [];

  restore = divertStrayConsole((m, msg) => {
    seen.push(`${m}: ${msg}`);
  });

  return seen;
}

describe("jsdom stays quiet", () => {
  test("the default jsdom console does report the broken stylesheet (the bug)", async () => {
    const seen = capture();
    const { JSDOM } = await loadHtmlLibs();

    new JSDOM(BAD_CSS_PAGE, { url: "https://x.test/" });
    expect(seen.join("\n")).toContain("Could not parse CSS stylesheet");
  });

  test("quietDocument, web_fetch extraction and page rendering print nothing", async () => {
    const seen = capture();
    const libs = await loadHtmlLibs();

    expect(quietDocument(libs, BAD_CSS_PAGE, "https://x.test/").title).toBe("");
    expect(
      await htmlToReadableMarkdown(BAD_CSS_PAGE, "https://x.test/")
    ).toContain("Readable body text");
    await renderSnapshot(
      {
        snapshotId: 1,
        url: "https://x.test/",
        title: "t",
        html: BAD_CSS_PAGE,
        refs: [],
        truncated: false,
      },
      "auto"
    );
    expect(seen).toEqual([]);
  });
});

describe("divertStrayConsole", () => {
  test("routes console.error/warn to the sink and restores them", () => {
    const target = {
      error: (..._a: unknown[]) => undefined,
      warn: (..._a: unknown[]) => undefined,
    };
    const originalError = target.error;
    const seen: string[] = [];
    const undo = divertStrayConsole(
      (m, msg) => seen.push(`${m}:${msg}`),
      target
    );

    target.error("Could not parse %s", "CSS");
    target.warn({ a: 1 });
    expect(seen).toEqual(["error:Could not parse CSS", "warn:{ a: 1 }"]);

    undo();
    expect(target.error).toBe(originalError);
  });
});
