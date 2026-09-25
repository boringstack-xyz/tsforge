/**
 * Sanitized page snapshot → markdown the model can read, with every allowed
 * clickable rendered inline as `[12 link: text](href)` / `[13 expand: text]`
 * so `browser_click` can address it by number.
 *
 * `auto` prefers Readability's article view but falls back to the full page
 * when Readability keeps too little of the text — the forum case, where it
 * picks the first post and silently drops every reply.
 */
import type TurndownService from "turndown";
import { loadHtmlLibs, type IHtmlLibs } from "../lib/html";
import type { IPageSnapshot, IRefInfo } from "./chrome-bridge.types";

export type ReadMode = "auto" | "article" | "full";

export interface IRenderedPage {
  markdown: string;
  mode: "article" | "full";
}

/** Readability must keep at least this share of the page text for `auto` to
 *  trust it; below it we render the whole page. */
const ARTICLE_MIN_TEXT_RATIO = 0.6;

const MAX_LABEL = 80;
const MAX_HREF = 120;

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function refLabel(content: string, info: IRefInfo): string {
  // Turndown already rendered nested markup; strip brackets that would make
  // the ref marker ambiguous.
  const label = collapse(content.replace(/[[\]]/gu, ""));

  return clip(label.length > 0 ? label : info.text, MAX_LABEL);
}

export function formatRef(content: string, info: IRefInfo): string {
  const head = `[${String(info.ref)} ${info.kind}: ${refLabel(content, info)}]`;
  const withHref = info.kind === "link" || info.kind === "page";

  return withHref && info.href !== undefined
    ? `${head}(${clip(info.href, MAX_HREF)})`
    : head;
}

function refAttr(node: HTMLElement): number | null {
  const raw = node.getAttribute("data-tsforge-ref");

  if (raw === null) {
    return null;
  }

  const n = Number(raw);

  return Number.isInteger(n) ? n : null;
}

function buildTurndown(
  Turndown: typeof TurndownService,
  refs: ReadonlyMap<number, IRefInfo>
): TurndownService {
  const td = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });

  td.addRule("tsforgeRef", {
    filter: (node) => {
      const ref = refAttr(node);

      return ref !== null && refs.has(ref);
    },
    replacement: (content, node) => {
      const ref = refAttr(node);
      const info = ref === null ? undefined : refs.get(ref);

      return info === undefined ? content : formatRef(content, info);
    },
  });
  td.addRule("tsforgeImage", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = collapse(node.getAttribute("alt") ?? "");

      return alt.length > 0 ? `[image: ${clip(alt, MAX_LABEL)}]` : "";
    },
  });

  return td;
}

function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/gu, "\n\n").trim();
}

export async function renderSnapshot(
  snapshot: IPageSnapshot,
  mode: ReadMode,
  libs?: IHtmlLibs
): Promise<IRenderedPage> {
  const { JSDOM, Readability, Turndown } = libs ?? (await loadHtmlLibs());
  const refs = new Map(snapshot.refs.map((r) => [r.ref, r]));
  const td = buildTurndown(Turndown, refs);
  const html = snapshot.html;
  const fullDoc = new JSDOM(html, { url: snapshot.url }).window.document;
  const full = (): IRenderedPage => ({
    markdown: tidy(td.turndown(fullDoc.body)),
    mode: "full",
  });

  if (mode === "full") {
    return full();
  }

  // Readability mutates its input — give it a separate document.
  const articleDoc = new JSDOM(html, { url: snapshot.url }).window.document;
  const article = new Readability(articleDoc, { keepClasses: true }).parse();
  const content = article?.content ?? "";

  if (content.length === 0) {
    return full();
  }

  if (mode === "auto") {
    const pageText = collapse(fullDoc.body.textContent).length;
    const articleText = collapse(article?.textContent ?? "").length;

    if (articleText < pageText * ARTICLE_MIN_TEXT_RATIO) {
      return full();
    }
  }

  return { markdown: tidy(td.turndown(content)), mode: "article" };
}
