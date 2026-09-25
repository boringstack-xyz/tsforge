import { describe, expect, test } from "bun:test";
import {
  isAuthorizedUpgrade,
  parseClickResult,
  parseExtensionFrame,
  parseScreenshot,
  parseServerFrame,
  parseSnapshot,
  parseTabList,
} from "../src/chrome-bridge/protocol";

const EXT = "fjlgfemoomkhjnjdcajjgkcdpmjkgedi";

describe("parseExtensionFrame", () => {
  test("hello with token + protocol", () => {
    expect(
      parseExtensionFrame(
        JSON.stringify({
          type: "hello",
          protocol: 1,
          token: "t",
          extVersion: "0.1",
        })
      )
    ).toEqual({ type: "hello", protocol: 1, token: "t", extVersion: "0.1" });
  });

  test("hello without token is rejected", () => {
    expect(
      parseExtensionFrame(JSON.stringify({ type: "hello", protocol: 1 }))
    ).toBeNull();
  });

  test("ok and error responses", () => {
    expect(
      parseExtensionFrame(
        JSON.stringify({ type: "res", id: 3, ok: true, result: [1] })
      )
    ).toEqual({ type: "res", id: 3, ok: true, result: [1] });
    expect(
      parseExtensionFrame(
        JSON.stringify({
          type: "res",
          id: 4,
          ok: false,
          error: { code: "denied", message: "no" },
        })
      )
    ).toEqual({
      type: "res",
      id: 4,
      ok: false,
      error: { code: "denied", message: "no" },
    });
  });

  test("unknown error code, non-integer id, garbage, arrays → null", () => {
    expect(
      parseExtensionFrame(
        JSON.stringify({
          type: "res",
          id: 1,
          ok: false,
          error: { code: "boom" },
        })
      )
    ).toBeNull();
    expect(
      parseExtensionFrame(JSON.stringify({ type: "res", id: 1.5, ok: true }))
    ).toBeNull();
    expect(parseExtensionFrame("{not json")).toBeNull();
    expect(parseExtensionFrame("[]")).toBeNull();
    expect(parseExtensionFrame(JSON.stringify({ type: "req" }))).toBeNull();
  });
});

describe("parseServerFrame", () => {
  test("request with a known method", () => {
    expect(
      parseServerFrame(
        JSON.stringify({
          type: "req",
          id: 1,
          method: "page.read",
          params: { tabId: 2 },
        })
      )
    ).toEqual({
      type: "req",
      id: 1,
      method: "page.read",
      params: { tabId: 2 },
    });
  });

  test("an unknown method (e.g. a typing verb) is refused", () => {
    expect(
      parseServerFrame(
        JSON.stringify({ type: "req", id: 1, method: "page.type", params: {} })
      )
    ).toBeNull();
  });

  test("welcome + pong", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "welcome", protocol: 1 }))
    ).toEqual({
      type: "welcome",
      protocol: 1,
    });
    expect(parseServerFrame(JSON.stringify({ type: "pong" }))).toEqual({
      type: "pong",
    });
  });
});

describe("isAuthorizedUpgrade", () => {
  const ok = {
    path: "/bridge",
    host: "127.0.0.1:47823",
    origin: `chrome-extension://${EXT}`,
  };

  test("our extension on loopback is allowed (127.0.0.1 and localhost)", () => {
    expect(isAuthorizedUpgrade(ok, 47823, EXT)).toBe(true);
    expect(
      isAuthorizedUpgrade({ ...ok, host: "localhost:47823" }, 47823, EXT)
    ).toBe(true);
  });

  test("a web page origin is refused", () => {
    expect(
      isAuthorizedUpgrade({ ...ok, origin: "https://evil.example" }, 47823, EXT)
    ).toBe(false);
  });

  test("another extension is refused", () => {
    expect(
      isAuthorizedUpgrade(
        { ...ok, origin: "chrome-extension://abc" },
        47823,
        EXT
      )
    ).toBe(false);
  });

  test("a rebinding Host is refused", () => {
    expect(
      isAuthorizedUpgrade({ ...ok, host: "evil.example:47823" }, 47823, EXT)
    ).toBe(false);
    expect(isAuthorizedUpgrade({ ...ok, host: null }, 47823, EXT)).toBe(false);
  });

  test("a wrong path is refused", () => {
    expect(isAuthorizedUpgrade({ ...ok, path: "/" }, 47823, EXT)).toBe(false);
  });
});

describe("payload parsers", () => {
  test("tab list drops malformed entries and defaults flags to false", () => {
    expect(
      parseTabList([
        { tabId: 1, title: "A", url: "https://a", active: true },
        { tabId: "x" },
      ])
    ).toEqual([
      {
        tabId: 1,
        title: "A",
        url: "https://a",
        active: true,
        inGroup: false,
        adopted: false,
      },
    ]);
    expect(parseTabList({})).toBeNull();
  });

  test("snapshot keeps valid refs only", () => {
    const snap = parseSnapshot({
      snapshotId: 7,
      url: "https://f",
      title: "T",
      html: "<p>x</p>",
      refs: [
        { ref: 1, kind: "link", text: "a", href: "https://f/2" },
        { ref: 2, kind: "submit", text: "Post" },
      ],
    });

    expect(snap?.refs).toEqual([
      { ref: 1, kind: "link", text: "a", href: "https://f/2" },
    ]);
    expect(parseSnapshot({ snapshotId: 1 })).toBeNull();
  });

  test("click outcome is narrowed; screenshot must be an image data URL", () => {
    expect(parseClickResult({ outcome: "weird", url: "u" })).toEqual({
      outcome: "none",
      url: "u",
    });
    expect(parseScreenshot({ dataUrl: "data:image/png;base64,AA" })).toEqual({
      dataUrl: "data:image/png;base64,AA",
    });
    expect(parseScreenshot({ dataUrl: "javascript:1" })).toBeNull();
  });
});
