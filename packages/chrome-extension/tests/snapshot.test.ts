import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { snapshotDocument } from "../src/snapshot";
import { createPageAgent, type IPageEnv } from "../src/page-agent";
import { isDestructiveUrl, isNavigableUrl } from "../src/url-policy";

function page(body: string, url = "https://forum.example/t/1"): JSDOM {
  return new JSDOM(
    `<!doctype html><html><head><title>Thread</title><script>evil()</script></head><body>${body}</body></html>`,
    {
      url,
    }
  );
}

describe("snapshotDocument", () => {
  const dom = page(`
    <main class="topic" id="m">
      <h1 style="color:red" onclick="x()">Title</h1>
      <p>Hello &amp; <b>world</b></p>
      <script>steal()</script><style>.x{}</style>
      <form><input value="secret-draft"><textarea>unsent draft text</textarea><button>Post reply</button></form>
      <div hidden>hidden text</div>
      <span aria-hidden="true">icon</span>
      <img src="/a.png" alt="a cat">
      <a href="/t/2">Next thread here</a>
      <button>Reply</button>
      <nav><a href="?page=2">›</a></nav>
    </main>`);
  const snap = snapshotDocument(dom.window.document);

  test("keeps structure, whitelisted attributes and text", () => {
    expect(snap.html).toContain('<main class="topic" id="m">');
    expect(snap.html).toContain("<h1>Title</h1>");
    expect(snap.html).toContain("Hello &amp; <b>world</b>");
    expect(snap.html).toContain('<img alt="a cat">');
  });

  test("drops scripts, styles, event handlers, form values, hidden content", () => {
    for (const bad of [
      "steal",
      "evil",
      ".x{}",
      "onclick",
      "style=",
      "secret-draft",
      "unsent draft",
      "hidden text",
      "icon",
      "src=",
    ]) {
      expect(snap.html).not.toContain(bad);
    }
  });

  test("refs only for allowed clickables, with absolute hrefs, in document order", () => {
    expect(snap.refs).toEqual([
      {
        ref: 1,
        kind: "link",
        text: "Next thread here",
        href: "https://forum.example/t/2",
      },
      {
        ref: 2,
        kind: "page",
        text: "›",
        href: "https://forum.example/t/1?page=2",
      },
    ]);
    expect(snap.html).toContain(
      'href="https://forum.example/t/2" data-tsforge-ref="1"'
    );
    expect(snap.html).not.toContain("Post reply</button> data-tsforge-ref");
    expect(snap.elements.get(1)?.textContent).toBe("Next thread here");
  });

  test("a page-authored data-tsforge-ref attribute is not copied through", () => {
    const forged = snapshotDocument(
      page(`<button data-tsforge-ref="1">Reply</button>`).window.document
    );

    expect(forged.html).not.toContain("data-tsforge-ref");
    expect(forged.refs).toEqual([]);
  });

  test("open shadow roots are included", () => {
    const d = page(`<x-post id="h"></x-post>`);
    const host = d.window.document.getElementById("h")!;

    host.attachShadow({ mode: "open" }).innerHTML = "<p>shadow reply text</p>";
    expect(snapshotDocument(d.window.document).html).toContain(
      "shadow reply text"
    );
  });
});

function env(dom: JSDOM, over: Partial<IPageEnv> = {}): IPageEnv {
  return {
    document: dom.window.document,
    window: {
      innerHeight: 800,
      scrollY: 0,
      scrollBy: () => undefined,
      scrollTo: () => undefined,
      location: dom.window.location,
    },
    sleep: async () => undefined,
    waitForQuiet: async () => true,
    ...over,
  };
}

describe("page agent", () => {
  test("link to another page → navigate (no in-page click)", async () => {
    const dom = page(`<a href="/t/2">Another thread</a>`);
    const agent = createPageAgent(env(dom));
    const snap = agent.snapshot();

    expect(await agent.click(1, snap.snapshotId)).toEqual({
      status: "navigate",
      url: "https://forum.example/t/2",
    });
  });

  test("expander → dispatched click", async () => {
    const dom = page(`<button id="b">Show more replies</button>`);
    let clicked = 0;

    dom.window.document.getElementById("b")!.addEventListener("click", () => {
      clicked += 1;
    });
    const agent = createPageAgent(env(dom));
    const snap = agent.snapshot();

    expect(await agent.click(1, snap.snapshotId)).toEqual({
      status: "clicked",
      changed: true,
    });
    expect(clicked).toBe(1);
  });

  test("wrong snapshot id, unknown ref, or detached element → stale", async () => {
    const dom = page(`<button id="b">Show more replies</button>`);
    const agent = createPageAgent(env(dom));
    const snap = agent.snapshot();

    expect(await agent.click(1, snap.snapshotId + 1)).toEqual({
      status: "stale",
    });
    expect(await agent.click(99, snap.snapshotId)).toEqual({ status: "stale" });
    dom.window.document.getElementById("b")!.remove();
    expect(await agent.click(1, snap.snapshotId)).toEqual({ status: "stale" });
  });

  test("a newer snapshot invalidates older refs", async () => {
    const dom = page(`<a href="/t/2">Another thread</a>`);
    const agent = createPageAgent(env(dom));
    const first = agent.snapshot();

    agent.snapshot();
    expect(await agent.click(1, first.snapshotId)).toEqual({ status: "stale" });
  });

  test("an element moved into a form after the read is denied at click time", async () => {
    const dom = page(
      `<div id="c"><button id="b">Show more replies</button></div>`
    );
    const agent = createPageAgent(env(dom));
    const snap = agent.snapshot();
    const doc = dom.window.document;
    const form = doc.createElement("form");

    doc.getElementById("c")!.appendChild(form);
    form.appendChild(doc.getElementById("b")!);
    expect(await agent.click(1, snap.snapshotId)).toEqual({
      status: "denied",
      reason: "inside a form",
    });
  });

  test("scroll to bottom reports growth", async () => {
    const dom = page(`<p>x</p>`);
    let height = 1000;
    const doc = dom.window.document;

    Object.defineProperty(doc.body, "scrollHeight", { get: () => height });
    const agent = createPageAgent(
      env(dom, {
        sleep: async () => {
          height = 2000;
        },
      })
    );

    expect(await agent.scroll("bottom")).toMatchObject({
      grew: true,
      scrollHeight: 2000,
    });
  });
});

describe("url policy", () => {
  test("navigable = http(s) only", () => {
    expect(isNavigableUrl("https://a.example/x")).toBe(true);

    for (const bad of [
      "javascript:1",
      "file:///etc/passwd",
      "chrome://settings",
      "data:,x",
      "nope",
    ]) {
      expect(isNavigableUrl(bad)).toBe(false);
    }
  });

  test("destructive GET links", () => {
    const u = (s: string) => new URL(s, "https://f.example");

    expect(isDestructiveUrl(u("/logout"))).toBe(true);
    expect(isDestructiveUrl(u("/p?do=delete_post"))).toBe(true);
    expect(isDestructiveUrl(u("/p?csrf=1"))).toBe(true);
    expect(isDestructiveUrl(u("/t/how-to-remove-rust?page=2"))).toBe(false);
    expect(isDestructiveUrl(u("/viewtopic.php?t=1&sid=x"))).toBe(false);
  });
});
