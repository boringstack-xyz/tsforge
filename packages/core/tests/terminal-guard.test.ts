import { test, expect } from "bun:test";
import {
  TerminalGuard,
  chunkText,
  type IConsoleLike,
  type IGuardableStream,
} from "../src/cli/terminal-guard";

/** A stand-in for process.stdout / process.stderr that records raw writes. */
function fakeStream(): IGuardableStream & { raw: string[] } {
  const raw: string[] = [];

  return {
    raw,
    isTTY: true,
    rows: 40,
    columns: 120,
    write(...args: never[]): boolean {
      raw.push(chunkText(args[0]));

      return true;
    },
  };
}

function fakeConsole(): IConsoleLike & { raw: string[] } {
  const raw: string[] = [];

  const rec =
    (m: string) =>
    (...a: unknown[]): void => {
      raw.push(`${m}:${a.join(" ")}`);
    };

  return {
    raw,
    log: rec("log"),
    info: rec("info"),
    dir: rec("dir"),
    error: rec("error"),
    warn: rec("warn"),
    debug: rec("debug"),
    trace: rec("trace"),
  };
}

function setup(): {
  guard: TerminalGuard;
  out: ReturnType<typeof fakeStream>;
  err: ReturnType<typeof fakeStream>;
  con: ReturnType<typeof fakeConsole>;
  transcript: string[];
  traced: string[];
} {
  const out = fakeStream();
  const err = fakeStream();
  const con = fakeConsole();
  const transcript: string[] = [];
  const traced: string[] = [];
  const guard = new TerminalGuard({
    stdout: out,
    stderr: err,
    console: con,
    onStdout: (t) => transcript.push(t),
    onStderr: (t) => traced.push(t),
  });

  return { guard, out, err, con, transcript, traced };
}

/** Call a (possibly patched) stream's write the way a library would. */
function write(stream: IGuardableStream, ...args: unknown[]): boolean {
  return Reflect.apply(stream.write, stream, args) === true;
}

test("released: every write reaches the terminal as before", () => {
  const { out, err, con, transcript, traced } = setup();

  write(out, "a");
  write(err, "b");
  con.log("c");
  expect(out.raw).toEqual(["a"]);
  expect(err.raw).toEqual(["b"]);
  expect(con.raw).toEqual(["log:c"]);
  expect(transcript).toEqual([]);
  expect(traced).toEqual([]);
});

test("engaged: stray stdout → transcript, stderr → trace, nothing painted", () => {
  const { guard, out, err, transcript, traced } = setup();

  guard.engage();
  expect(write(out, "gate: x\n")).toBe(true);
  write(err, "[4242] [Local→Remote] tools/call\n");
  write(err, new TextEncoder().encode("bytes too\n"));

  expect(out.raw).toEqual([]);
  expect(err.raw).toEqual([]);
  expect(transcript).toEqual(["gate: x\n"]);
  expect(traced).toEqual(["[4242] [Local→Remote] tools/call\n", "bytes too\n"]);
});

test("engaged: the renderer's handle still reaches the real terminal", () => {
  const { guard, out } = setup();

  guard.engage();
  guard.terminal.write("\u001b[2J frame");
  expect(out.raw).toEqual(["\u001b[2J frame"]);
  expect(guard.terminal.isTTY).toBe(true);
  expect(guard.terminal.rows).toBe(40);
  expect(guard.terminal.columns).toBe(120);
});

test("engaged: console.* is taken over too (Bun's console bypasses the streams)", () => {
  const { guard, con, transcript, traced } = setup();

  guard.engage();
  con.log("hello %s", "there");
  con.info("i");
  con.error("Could not parse CSS stylesheet");
  con.warn("w");
  con.debug("d");

  expect(con.raw).toEqual([]);
  expect(transcript).toEqual(["hello there\n", "i\n"]);
  expect(traced).toEqual(["Could not parse CSS stylesheet\n", "w\n", "d\n"]);
});

test("release restores the exact previous writers and console methods", () => {
  const { guard, out, err, con } = setup();
  const before = { o: out.write, e: err.write, log: con.log, error: con.error };

  guard.engage();
  expect(out.write).not.toBe(before.o);
  guard.release();

  expect(out.write).toBe(before.o);
  expect(err.write).toBe(before.e);
  expect(con.log).toBe(before.log);
  expect(con.error).toBe(before.error);
});

test("engage / release are idempotent (double engage cannot lose the originals)", () => {
  const { guard, out, con } = setup();
  const original = out.write;
  const originalLog = con.log;

  guard.engage();
  guard.engage();
  guard.release();
  guard.release();
  expect(out.write).toBe(original);
  expect(con.log).toBe(originalLog);
  expect(guard.engaged).toBe(false);
});

test("a write callback is still called, so waiting callers don't hang", () => {
  const { guard, out } = setup();
  let called = 0;

  guard.engage();
  write(out, "x", "utf8", () => {
    called += 1;
  });
  write(out, "y", () => {
    called += 1;
  });
  expect(called).toBe(2);
});

test("a sink that writes back to a guarded stream cannot loop or paint", () => {
  const out = fakeStream();
  const err = fakeStream();
  let calls = 0;
  const guard = new TerminalGuard({
    stdout: out,
    stderr: err,
    console: fakeConsole(),
    onStdout: () => {
      calls += 1;
      write(err, "sink complains\n"); // e.g. trace() to stderr
    },
    onStderr: () => {
      calls += 1;
    },
  });

  guard.engage();
  write(out, "x");
  expect(calls).toBe(1);
  expect(out.raw).toEqual([]);
  expect(err.raw).toEqual([]);
});

test("a throwing sink never breaks the caller's write", () => {
  const out = fakeStream();
  const guard = new TerminalGuard({
    stdout: out,
    stderr: fakeStream(),
    console: fakeConsole(),
    onStdout: () => {
      throw new Error("boom");
    },
    onStderr: () => {},
  });

  guard.engage();
  expect(write(out, "x")).toBe(true);
});
