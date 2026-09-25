import { describe, expect, test } from "bun:test";
import { chunkMarkdown, refsIn } from "../src/chrome-bridge/chunk";
import { formatRef, renderSnapshot } from "../src/chrome-bridge/page-render";
import type {
  IPageSnapshot,
  IRefInfo,
} from "../src/chrome-bridge/chrome-bridge.types";

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

function snap(html: string, refs: IRefInfo[] = []): IPageSnapshot {
  return {
    snapshotId: 1,
    url: "https://forum.example/t/1",
    title: "T",
    html,
    refs,
    truncated: false,
  };
}

/** A forum thread: an opening post plus 20 replies of similar length, each in
 *  a `.comment` block (a common forum class that Readability treats as an
 *  unlikely candidate and strips), with pagination in a nav. */
function forumThread(): IPageSnapshot {
  const replies = Array.from(
    { length: 20 },
    (_, i) =>
      `<div class="comment reply"><header><span class="author">user${i}</span></header><div class="cooked"><p>Reply number ${i} says: ${LOREM}</p></div></div>`
  ).join("");
  const html = `<html><body><main><h1>Thread title</h1>
    <article class="post topic"><div class="cooked"><p>Opening post. ${LOREM.repeat(10)}</p></div></article>
    ${replies}
    <nav aria-label="pagination"><a href="https://forum.example/t/1?page=2" data-tsforge-ref="1">›</a></nav>
    <button data-tsforge-ref="2">Show 12 more replies</button>
  </main></body></html>`;

  return snap(html, [
    {
      ref: 1,
      kind: "page",
      text: "›",
      href: "https://forum.example/t/1?page=2",
    },
    { ref: 2, kind: "expand", text: "Show 12 more replies" },
  ]);
}

describe("renderSnapshot", () => {
  test("auto keeps every forum reply (falls back to full when Readability drops them)", async () => {
    const out = await renderSnapshot(forumThread(), "auto");

    for (let i = 0; i < 20; i++) {
      expect(out.markdown).toContain(`Reply number ${i} says`);
    }
  });

  test("refs render inline with number, kind, label and href", async () => {
    const out = await renderSnapshot(forumThread(), "full");

    expect(out.mode).toBe("full");
    expect(out.markdown).toContain(
      "[1 page: ›](https://forum.example/t/1?page=2)"
    );
    expect(out.markdown).toContain("[2 expand: Show 12 more replies]");
  });

  test("article mode on a real article keeps refs through Readability", async () => {
    const body = Array.from(
      { length: 8 },
      (_, i) => `<p>Paragraph ${i}. ${LOREM.repeat(2)}</p>`
    ).join("");
    const html = `<html><body><div class="sidebar"><a href="/x">x</a></div>
      <article class="content"><h1>Big article</h1>${body}
      <p>See <a href="https://forum.example/doc" data-tsforge-ref="5">the docs</a> for more. ${LOREM}</p></article></body></html>`;
    const out = await renderSnapshot(
      snap(html, [
        {
          ref: 5,
          kind: "link",
          text: "the docs",
          href: "https://forum.example/doc",
        },
      ]),
      "article"
    );

    expect(out.mode).toBe("article");
    expect(out.markdown).toContain(
      "[5 link: the docs](https://forum.example/doc)"
    );
    expect(out.markdown).toContain("Paragraph 7");
  });

  test("an element whose data-tsforge-ref is not in the ref table renders as plain content", async () => {
    const out = await renderSnapshot(
      snap(`<p>hello <a href="https://a" data-tsforge-ref="99">forged</a></p>`),
      "full"
    );

    expect(out.markdown).not.toContain("[99");
    expect(out.markdown).toContain("forged");
  });

  test("images become alt text markers", async () => {
    const out = await renderSnapshot(
      snap(`<p>pic <img alt="a cat"></p>`),
      "full"
    );

    expect(out.markdown).toContain("[image: a cat]");
  });
});

describe("formatRef", () => {
  test("expand refs have no href; long labels are clipped", () => {
    expect(
      formatRef("  Show   more ", { ref: 3, kind: "expand", text: "" })
    ).toBe("[3 expand: Show more]");
    expect(
      formatRef("x".repeat(200), {
        ref: 4,
        kind: "link",
        text: "",
        href: "https://a",
      }).length
    ).toBeLessThan(120);
  });
});

describe("chunkMarkdown", () => {
  test("packs paragraphs up to the size and never exceeds it", () => {
    const md = Array.from(
      { length: 40 },
      (_, i) => `Para ${i} ${"w".repeat(200)}`
    ).join("\n\n");
    const chunks = chunkMarkdown(md, 1000);

    expect(chunks.length).toBeGreaterThan(5);

    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
    }

    expect(chunks.join("\n\n")).toBe(md);
  });

  test("a single over-long paragraph is hard-split", () => {
    const chunks = chunkMarkdown("word ".repeat(1000).trim(), 300);

    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(300);
    }

    expect(chunks.join(" ").split(" ")).toHaveLength(1000);
  });

  test("empty input yields one empty chunk", () => {
    expect(chunkMarkdown("", 100)).toEqual([""]);
  });

  test("refsIn finds ref numbers in order", () => {
    expect(refsIn("a [3 link: x](u) b [10 expand: y] [nope]")).toEqual([3, 10]);
  });
});
