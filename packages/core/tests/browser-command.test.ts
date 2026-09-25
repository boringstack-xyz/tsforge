import { describe, expect, test } from "bun:test";
import { browserChipText, browserReportText } from "../src/cli/browser-command";

describe("browserChipText", () => {
  test("one line per status", () => {
    expect(browserChipText("connected", 47823)).toContain("connected");
    expect(browserChipText("listening", 47823)).toContain("/browser to pair");
    expect(browserChipText("in-use", 47823)).toContain(
      "another tsforge session"
    );
  });
});

describe("browserReportText", () => {
  test("off explains how to turn it on", () => {
    expect(
      browserReportText({ status: null, port: 1, tokenPath: "p", token: null })
    ).toContain("TSFORGE_BROWSER=1");
  });

  test("waiting shows setup steps and the token", () => {
    const out = browserReportText({
      status: "listening",
      port: 47823,
      tokenPath: "/h/.tsforge/browser-token",
      token: "tok123",
    });

    expect(out).toContain("Load unpacked");
    expect(out).toContain("tok123");
  });

  test("connected skips setup steps", () => {
    expect(
      browserReportText({
        status: "connected",
        port: 47823,
        tokenPath: "p",
        token: "tok",
      })
    ).not.toContain("Load unpacked");
  });
});
