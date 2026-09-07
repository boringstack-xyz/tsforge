import { test, expect, describe, spyOn } from "bun:test";
import { OutputRouter } from "../src/cli/output-router";

/** Capture stdout writes made during fn. spyOn + mockRestore puts back the
 *  ORIGINAL method (identity and all) so later tests see an untouched stream. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk));

      return true;
    }
  );

  try {
    fn();
  } finally {
    spy.mockRestore();
  }

  return chunks.join("");
}

describe("OutputRouter", () => {
  test("routes to stdout when no sinks are installed", () => {
    const router = new OutputRouter();

    const out = captureStdout(() => {
      router.route("plain\n");
    });

    expect(out).toBe("plain\n");
  });

  test("parent sink wins over stdout once installed, and clears back", () => {
    const router = new OutputRouter();
    const parent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.route("to-parent");
    expect(parent).toEqual(["to-parent"]);

    router.setParentSink(null);

    const out = captureStdout(() => {
      router.route("back-to-stdout");
    });

    expect(out).toBe("back-to-stdout");
    expect(parent).toEqual(["to-parent"]); // untouched after clear
  });

  test("an agent's writes go to its own sink, not the parent's", () => {
    const router = new OutputRouter();
    const parent: string[] = [];
    const agent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.setAgentSink("run:explore", (text) => agent.push(text));

    router.route("child-text", "run:explore");
    router.route("parent-text");

    expect(agent).toEqual(["child-text"]);
    expect(parent).toEqual(["parent-text"]);
  });

  test("an agentId with no registered sink falls back to the parent sink", () => {
    const router = new OutputRouter();
    const parent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.route("orphan-child", "run:unknown");

    expect(parent).toEqual(["orphan-child"]);
  });

  test("a sink is cleared even if the agent produced NO output (no leak)", () => {
    // resetTree clears every installed sink via agentSinkIds — including an agent
    // that streamed nothing (no agentOutput entry). Model that: install a sink,
    // never write to it, clear it, then a later write for that id must fall back
    // to the parent (else the stale sink would keep diverting future chunks).
    const router = new OutputRouter();
    const parent: string[] = [];
    const agent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.setAgentSink("run:silent", (text) => agent.push(text));
    router.clearAgentSink("run:silent"); // agent produced nothing

    router.route("post-turn chunk", "run:silent");

    expect(agent).toEqual([]); // never leaked to the dead sink
    expect(parent).toEqual(["post-turn chunk"]); // fell back to parent
  });

  test("capture holds every write, and endCapture hands it back in order", () => {
    const router = new OutputRouter();

    router.beginCapture();
    expect(router.capturing).toBe(true);

    const out = captureStdout(() => {
      router.route("first\n");
      router.route("second\n");
    });

    // Nothing reached the terminal while the pane console had yet to paint.
    expect(out).toBe("");
    expect(router.endCapture()).toBe("first\nsecond\n");
    expect(router.capturing).toBe(false);
  });

  test("capture outranks BOTH sinks — boot output can't paint into an undrawn frame", () => {
    const router = new OutputRouter();
    const parent: string[] = [];
    const agent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.setAgentSink("run:a", (text) => agent.push(text));
    router.beginCapture();

    router.route("parent-boot");
    router.route("agent-boot", "run:a");

    expect(parent).toEqual([]);
    expect(agent).toEqual([]);
    expect(router.endCapture()).toBe("parent-bootagent-boot");
  });

  test("routing resumes to the installed sink after endCapture", () => {
    const router = new OutputRouter();
    const parent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.beginCapture();
    router.route("held");
    router.endCapture();

    router.route("live");

    expect(parent).toEqual(["live"]);
  });

  test("beginCapture is idempotent — a second call keeps what the first held", () => {
    const router = new OutputRouter();

    router.beginCapture();
    router.route("early");
    router.beginCapture(); // must not reset the buffer
    router.route("late");

    expect(router.endCapture()).toBe("earlylate");
  });

  test("endCapture without a capture is empty and harmless", () => {
    const router = new OutputRouter();

    expect(router.endCapture()).toBe("");
    expect(router.capturing).toBe(false);
  });

  test("clearAgentSink removes the route; later writes fall back", () => {
    const router = new OutputRouter();
    const parent: string[] = [];
    const agent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.setAgentSink("run:a", (text) => agent.push(text));

    router.route("first", "run:a");
    router.clearAgentSink("run:a");
    router.route("second", "run:a");

    expect(agent).toEqual(["first"]);
    expect(parent).toEqual(["second"]);
  });
});
