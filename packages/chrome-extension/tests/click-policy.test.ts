import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { classifyClickable } from "../src/click-policy";

/** Build a page, return the element marked data-t. */
function el(html: string, url = "https://forum.example/t/1"): Element {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url });
  const found = dom.window.document.querySelector("[data-t]");

  if (found === null) {
    throw new Error("fixture needs a [data-t] element");
  }

  return found;
}

const verdict = (html: string) => classifyClickable(el(html));

describe("allowed — links and expanders", () => {
  test.each([
    [
      "relative thread link",
      `<a data-t href="/t/2">Another thread</a>`,
      "link",
    ],
    [
      "next-page link in a nav",
      `<nav><a data-t href="/t/1?page=2">›</a></nav>`,
      "page",
    ],
    [
      "numbered page in .pagination",
      `<div class="pagination"><a data-t href="?page=3">3</a></div>`,
      "page",
    ],
    [
      "vBulletin pagenav",
      `<div class="pagenav"><table><tr><td><a data-t href="forumdisplay.php?f=33&page=2">»</a></td></tr></table></div>`,
      "page",
    ],
    [
      "rel=next link",
      `<a data-t rel="next" href="/t/1?page=2">Older posts</a>`,
      "page",
    ],
    [
      "show-more button",
      `<button data-t>Show 12 more replies</button>`,
      "expand",
    ],
    [
      "view N reply (contains 'reply')",
      `<button data-t>View 1 reply</button>`,
      "expand",
    ],
    [
      "load more role=button",
      `<div role="button" data-t>Load more</div>`,
      "expand",
    ],
    [
      "aria-expanded toggle",
      `<button data-t aria-expanded="false">Thread options</button>`,
      "expand",
    ],
    [
      "details/summary",
      `<details><summary data-t>Spoiler</summary>x</details>`,
      "summary",
    ],
    [
      "long title with an action word",
      `<a data-t href="/t/9">How to delete a git branch safely</a>`,
      "link",
    ],
    [
      "phpBB link with sid",
      `<a data-t href="/viewtopic.php?t=5&sid=abc123">Topic</a>`,
      "link",
    ],
    [
      "slug containing remove",
      `<a data-t href="/t/how-to-remove-rust">thread</a>`,
      "link",
    ],
  ])("%s", (_name, html, kind) => {
    expect(verdict(html)).toMatchObject({ allow: true, kind });
  });

  test("links resolve to absolute hrefs", () => {
    expect(verdict(`<a data-t href="/t/2">x y z w v</a>`)).toEqual({
      allow: true,
      kind: "link",
      href: "https://forum.example/t/2",
    });
  });
});

describe("denied — anything that acts as the user", () => {
  test.each([
    ["Reply button", `<button data-t>Reply</button>`],
    ["Like button", `<button data-t aria-label="Like this post">♥</button>`],
    ["Post link", `<a data-t href="/new">Post</a>`],
    ["Log out link", `<a data-t href="/session">Log out</a>`],
    ["add to cart", `<button data-t>Add to cart</button>`],
    [
      "button inside a form",
      `<form><button data-t type="button">Show more</button></form>`,
    ],
    [
      "load more inside a form (deny wins)",
      `<form><div role="button" data-t>Load more</div></form>`,
    ],
    [
      "button bound to a form by id",
      `<form id="f"></form><button data-t form="f">Show more</button>`,
    ],
    ["submit input", `<input data-t type="submit" value="Show more">`],
    [
      "submit-typed button outside a form",
      `<button data-t type="submit">Show more</button>`,
    ],
    [
      "contenteditable",
      `<div contenteditable="true"><a data-t href="/x">link here now</a></div>`,
    ],
    ["textarea", `<textarea data-t></textarea>`],
    ["checkbox role", `<div role="checkbox" data-t>Watch</div>`],
    ["javascript: link", `<a data-t href="javascript:alert(1)">open</a>`],
    ["data: link", `<a data-t href="data:text/html,hi">open</a>`],
    ["download link", `<a data-t href="/file.zip" download>file</a>`],
    ["logout path", `<a data-t href="/logout">Bye now friend</a>`],
    [
      "?action=delete",
      `<a data-t href="/post?action=delete&id=1">x y z w v</a>`,
    ],
    [
      "phpBB mode=logout",
      `<a data-t href="/ucp.php?mode=logout&sid=1">x y z w v</a>`,
    ],
    ["wp nonce", `<a data-t href="/?p=1&_wpnonce=abc">x y z w v</a>`],
    [
      "phpBB hash action",
      `<a data-t href="/viewtopic.php?t=5&unwatch=topic&hash=ab12">x y z w v</a>`,
    ],
    ["disabled button", `<button data-t disabled>Show more</button>`],
    ["unlabelled clickable div", `<div data-t onclick="x()">⋯</div>`],
    ["plain button with no expander label", `<button data-t>Options</button>`],
    ['a href="#" without expander label', `<a data-t href="#">Actions</a>`],
  ])("%s", (_name, html) => {
    expect(verdict(html).allow).toBe(false);
  });
});

describe("click-time re-check", () => {
  test("an element swapped into a form after the snapshot is denied", () => {
    const dom = new JSDOM(
      `<body><div id="c"><button id="b">Show more</button></div></body>`,
      {
        url: "https://forum.example/",
      }
    );
    const doc = dom.window.document;
    const button = doc.getElementById("b")!;

    expect(classifyClickable(button).allow).toBe(true);

    const form = doc.createElement("form");

    doc.getElementById("c")!.appendChild(form);
    form.appendChild(button);

    expect(classifyClickable(button)).toEqual({
      allow: false,
      reason: "inside a form",
    });
  });
});
