/**
 * Local HTML → markdown extraction shared by `web_fetch` and `browser_read`:
 * jsdom + Mozilla Readability + Turndown, lazy-loaded so they cost nothing until
 * a page is actually read.
 */
import type {
  JSDOM as JSDOMType,
  VirtualConsole as VirtualConsoleType,
} from "jsdom";
import type { Readability as ReadabilityType } from "@mozilla/readability";
import type TurndownService from "turndown";

export interface IHtmlLibs {
  JSDOM: typeof JSDOMType;
  VirtualConsole: typeof VirtualConsoleType;
  Readability: typeof ReadabilityType;
  Turndown: typeof TurndownService;
}

let libs: Promise<IHtmlLibs> | null = null;

export function loadHtmlLibs(): Promise<IHtmlLibs> {
  libs ??= Promise.all([
    import("jsdom"),
    import("@mozilla/readability"),
    import("turndown"),
  ]).then(([jsdom, readability, turndown]) => ({
    JSDOM: jsdom.JSDOM,
    VirtualConsole: jsdom.VirtualConsole,
    Readability: readability.Readability,
    Turndown: turndown.default,
  }));

  return libs;
}

/**
 * Parse HTML into a document with jsdom's console SILENCED. By default jsdom
 * reports page problems ("Could not parse CSS stylesheet", script errors) with
 * console.error — straight onto the terminal, over the interactive UI, which
 * scrolled the screen and left duplicated header rows behind. Page problems
 * are not tsforge problems; a fresh VirtualConsole with no sink drops them.
 */
export function quietDocument(
  libs: Pick<IHtmlLibs, "JSDOM" | "VirtualConsole">,
  html: string,
  url: string
): Document {
  return new libs.JSDOM(html, {
    url,
    virtualConsole: new libs.VirtualConsole(),
  }).window.document;
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Readable article markdown for a fetched page. Falls back to a crude
 *  tag-strip if the libs are unavailable or parsing fails. */
export async function htmlToReadableMarkdown(
  html: string,
  url: string
): Promise<string> {
  try {
    const libs = await loadHtmlLibs();
    const { Readability, Turndown } = libs;
    const article = new Readability(quietDocument(libs, html, url)).parse();
    const content = article?.content ?? "";

    if (content.length === 0) {
      return stripTags(html);
    }

    const title = article?.title ?? "";
    const body = new Turndown().turndown(content);

    return title.length > 0 ? `# ${title}\n\n${body}` : body;
  } catch {
    return stripTags(html);
  }
}

/** An HTML FRAGMENT (a comment, an answer body) → markdown, keeping links and
 *  code blocks. Falls back to tag-stripping when the libs are unavailable. */
export async function htmlFragmentToMarkdown(html: string): Promise<string> {
  if (html.trim().length === 0) {
    return "";
  }

  try {
    const { Turndown } = await loadHtmlLibs();

    return new Turndown({ codeBlockStyle: "fenced" }).turndown(html).trim();
  } catch {
    return stripTags(html);
  }
}
