/**
 * Walk the live DOM into sanitized structural HTML plus a ref table. Only
 * visible content is kept; scripts, styles, media and form controls are
 * dropped; attributes are whitelisted. Every element the click policy allows
 * gets a `data-tsforge-ref` number (for tsforge's markdown renderer) and is
 * remembered in `elements` — the ONLY place a click is resolved from, so a
 * page can't forge a ref by writing the attribute itself.
 */
import { accessibleName, classifyClickable } from "./click-policy";
import type { IRefInfo, ISnapshotResult } from "./extension.types";

const DROP_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "frame",
  "object",
  "embed",
  "video",
  "audio",
  "picture",
  "source",
  "track",
  "map",
  "input",
  "textarea",
  "select",
  "option",
  "datalist",
  "meta",
  "link",
  "head",
  "title",
  "base",
]);

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "img", "wbr"]);

const KEEP_ATTRS: readonly string[] = [
  "class",
  "id",
  "role",
  "aria-label",
  "datetime",
  "alt",
  "title",
  "rel",
];

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export const MAX_SNAPSHOT_CHARS = 2_000_000;

function escapeText(s: string): string {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/gu, "&quot;");
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
    return true;
  }

  // Real Chrome: layout-aware visibility. jsdom has no layout — skip there.
  return typeof el.checkVisibility === "function" && !el.checkVisibility();
}

/** Custom elements become <div>; everything else keeps its (lowercase) name. */
function outTag(el: Element): string {
  const t = el.tagName.toLowerCase();

  return /^[a-z][a-z0-9]*$/u.test(t) ? t : "div";
}

interface IWalk {
  parts: string[];
  size: number;
  truncated: boolean;
  refs: IRefInfo[];
  elements: Map<number, Element>;
  nextRef: number;
}

function attrs(el: Element, ref: number | null): string {
  let out = "";

  for (const name of KEEP_ATTRS) {
    const v = el.getAttribute(name);

    if (v !== null) {
      out += ` ${name}="${escapeAttr(v)}"`;
    }
  }

  const href = el.getAttribute("href");

  if (href !== null) {
    try {
      out += ` href="${escapeAttr(new URL(href, el.baseURI).href)}"`;
    } catch {
      // unparseable href — drop it
    }
  }

  return ref === null ? out : `${out} data-tsforge-ref="${String(ref)}"`;
}

function push(w: IWalk, s: string): void {
  if (w.size + s.length > MAX_SNAPSHOT_CHARS) {
    w.truncated = true;

    return;
  }

  w.parts.push(s);
  w.size += s.length;
}

function assignRef(w: IWalk, el: Element): number | null {
  const verdict = classifyClickable(el);

  if (!verdict.allow) {
    return null;
  }

  const ref = w.nextRef;

  w.nextRef += 1;
  w.elements.set(ref, el);
  w.refs.push({
    ref,
    kind: verdict.kind,
    text: accessibleName(el),
    ...(verdict.href === undefined ? {} : { href: verdict.href }),
  });

  return ref;
}

/** Children to walk: the light DOM, then an open shadow root's own content.
 *  Slotted content lives in the light DOM, so nothing is emitted twice. */
function childrenOf(el: Element): readonly Node[] {
  const light = Array.from(el.childNodes);

  return el.shadowRoot === null
    ? light
    : [...light, ...Array.from(el.shadowRoot.childNodes)];
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function walk(w: IWalk, node: Node): void {
  if (w.truncated) {
    return;
  }

  if (node.nodeType === TEXT_NODE) {
    push(w, escapeText(node.textContent ?? ""));

    return;
  }

  if (!isElement(node)) {
    return;
  }

  const el = node;
  const t = el.tagName.toLowerCase();

  if (DROP_TAGS.has(t) || isHidden(el)) {
    return;
  }

  const name = outTag(el);

  push(w, `<${name}${attrs(el, assignRef(w, el))}>`);

  if (VOID_TAGS.has(t)) {
    return;
  }

  for (const child of childrenOf(el)) {
    walk(w, child);
  }

  push(w, `</${name}>`);
}

export function snapshotDocument(doc: Document, firstRef = 1): ISnapshotResult {
  const w: IWalk = {
    parts: [],
    size: 0,
    truncated: false,
    refs: [],
    elements: new Map(),
    nextRef: firstRef,
  };

  push(w, "<html><body>");

  for (const child of Array.from(doc.body.childNodes)) {
    walk(w, child);
  }

  push(w, "</body></html>");

  return {
    html: w.parts.join(""),
    refs: w.refs,
    elements: w.elements,
    truncated: w.truncated,
  };
}
