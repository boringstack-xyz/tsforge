/**
 * The read + navigate enforcement point: decides whether one DOM element may
 * be clicked by the agent. Default DENY. Deny rules run first and win; an
 * element is allowed only if it is a real link, a <summary>, or an expander
 * ("show more replies", aria-expanded toggles). Runs in the extension's
 * isolated world — at snapshot time (to hand out refs) AND again at click
 * time on the live element, so a page that swaps a link for a form button
 * after the read gets denied.
 *
 * Pure DOM logic: tag/attribute checks only (no `instanceof`), so it works on
 * any Document — Chrome's or a jsdom one in tests.
 */
import type { ClickVerdict, RefKind } from "./extension.types";
import { hasActionWord, isDestructiveUrl } from "./url-policy";

const FORM_CONTROL_TAGS: ReadonlySet<string> = new Set([
  "input",
  "textarea",
  "select",
  "option",
  "label",
  "optgroup",
  "datalist",
]);

const INPUT_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "slider",
  "spinbutton",
  "switch",
  "checkbox",
  "radio",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
]);

const SUBMIT_TYPES: ReadonlySet<string> = new Set(["submit", "reset", "image"]);

/** Labels that reveal more of what is already on the page. */
export const EXPANDER_RE =
  /^(?:(?:show|load|view|see|read|expand|display)\s+(?:more|all|\d+|previous|earlier|older|newer|hidden|full|replies|reply|comments|answers|thread|rest)\b.*|(?:more|next|previous|prev|older|newer)(?:\s+(?:page|replies|comments|posts|answers))?|\d+\s+(?:more\s+)?(?:replies|reply|comments|answers|posts)|continue\s+(?:reading|thread)|read\s+more|[›»…])$/iu;

const PAGE_LABEL_RE =
  /^(?:\d+|next|prev|previous|older|newer|first|last|next page|previous page|[›»‹«→←])$/iu;

// pager, paging, pagination, and vBulletin/phpBB's `pagenav` / `pagelinks`.
const PAGINATION_CLASS_RE =
  /pag(?:e|es|ing|ination|er)\b|pagination|pagenav|pagelinks/iu;

const MAX_NAME = 80;
/** Table-based pagers (vBulletin) nest the link ~6 levels under the pager div. */
const MAX_PAGER_DEPTH = 8;
const MAX_ACTION_LABEL_WORDS = 4;

function tag(el: Element): string {
  return el.tagName.toLowerCase();
}

/** The label a user would read: aria-label, then title, then visible text. */
export function accessibleName(el: Element): string {
  const raw =
    el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent;

  return raw.replace(/\s+/gu, " ").trim().slice(0, MAX_NAME);
}

function hrefOf(el: Element): { raw: string; url: URL | null } | null {
  const raw = el.getAttribute("href");

  if (raw === null) {
    return null;
  }

  try {
    return { raw, url: new URL(raw, el.baseURI) };
  } catch {
    return { raw, url: null };
  }
}

function isHttp(url: URL | null): url is URL {
  return (
    url !== null && (url.protocol === "http:" || url.protocol === "https:")
  );
}

function isButtonLike(el: Element): boolean {
  return tag(el) === "button" || el.getAttribute("role") === "button";
}

function inFormOrEditable(el: Element): string | null {
  if (el.closest("form") !== null || el.hasAttribute("form")) {
    return "inside a form";
  }

  if (el.closest('[contenteditable]:not([contenteditable="false"])') !== null) {
    return "editable content";
  }

  return null;
}

function isControl(el: Element): string | null {
  if (
    FORM_CONTROL_TAGS.has(tag(el)) ||
    el.closest("input, textarea, select") !== null
  ) {
    return "form control";
  }

  if (INPUT_ROLES.has(el.getAttribute("role") ?? "")) {
    return "input control";
  }

  if (SUBMIT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase())) {
    return "submit button";
  }

  if (el.closest('[disabled], [aria-disabled="true"]') !== null) {
    return "disabled";
  }

  return null;
}

function badLink(el: Element): string | null {
  const href = hrefOf(el);

  if (href === null) {
    return null;
  }

  if (el.hasAttribute("download")) {
    return "download link";
  }

  if (href.raw.startsWith("#")) {
    return null;
  }

  if (!isHttp(href.url)) {
    return "not an http(s) link";
  }

  return isDestructiveUrl(href.url) ? "link performs an action" : null;
}

function actionLabel(el: Element): string | null {
  const name = accessibleName(el);
  const words = name.split(" ").filter(Boolean).length;

  // Expander labels ("View 1 reply") are reveals, not actions; long labels are
  // titles ("How to delete a branch"), not verbs.
  if (EXPANDER_RE.test(name) || words > MAX_ACTION_LABEL_WORDS) {
    return null;
  }

  return hasActionWord(name) ? `action: "${name}"` : null;
}

/** First reason this element must not be clicked, or null. */
export function denyReason(el: Element): string | null {
  return (
    inFormOrEditable(el) ?? isControl(el) ?? badLink(el) ?? actionLabel(el)
  );
}

function inPagination(el: Element): boolean {
  if (el.closest('nav, [role="navigation"]') !== null) {
    return true;
  }

  let node: Element | null = el;

  for (let depth = 0; node !== null && depth < MAX_PAGER_DEPTH; depth += 1) {
    if (PAGINATION_CLASS_RE.test(node.getAttribute("class") ?? "")) {
      return true;
    }

    node = node.parentElement;
  }

  return false;
}

function linkKind(el: Element): RefKind {
  const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/u);
  const isPage =
    rel.includes("next") ||
    rel.includes("prev") ||
    (inPagination(el) && PAGE_LABEL_RE.test(accessibleName(el)));

  return isPage ? "page" : "link";
}

/** What kind of allowed clickable this is, or null (→ denied). */
export function allowKind(el: Element): ClickVerdict | null {
  const t = tag(el);
  const href = hrefOf(el);

  if (
    t === "summary" &&
    el.parentElement?.tagName.toLowerCase() === "details"
  ) {
    return { allow: true, kind: "summary" };
  }

  if (t === "a" && href !== null && href.raw !== "#" && href.url !== null) {
    return { allow: true, kind: linkKind(el), href: href.url.href };
  }

  const toggles =
    el.hasAttribute("aria-expanded") && (isButtonLike(el) || t === "a");
  const expander =
    (isButtonLike(el) || t === "a") && EXPANDER_RE.test(accessibleName(el));

  return toggles || expander ? { allow: true, kind: "expand" } : null;
}

export function classifyClickable(el: Element): ClickVerdict {
  const deny = denyReason(el);

  if (deny !== null) {
    return { allow: false, reason: deny };
  }

  return allowKind(el) ?? { allow: false, reason: "not a link or expander" };
}
