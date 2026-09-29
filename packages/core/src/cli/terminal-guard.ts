import { format } from "node:util";

/**
 * While the pane console owns the screen, the renderer is the ONLY thing that
 * may write to the terminal. Anything else painting raw bytes lands on top of
 * the frame: it scrolls the alternate screen, leaves stacked duplicate rows,
 * and corrupts the input box. This has leaked three ways so far — jsdom's CSS
 * warnings, library console.error, and stdio MCP servers' stderr (mcp-remote's
 * `[pid] [Local→Remote] tools/call`) — each fixed at the site that showed it.
 * The guard closes the class for in-process writers:
 *
 *   - the renderer gets `terminal`, a handle bound to the real stdout;
 *   - while engaged, every other `process.stdout.write` becomes transcript text
 *     (`onStdout`) and every `process.stderr.write` goes to the debug trace
 *     (`onStderr`);
 *   - console.* too: Bun's console writes natively and never passes through
 *     process.stdout/stderr.write, so it is patched separately — log/info/dir
 *     to `onStdout`, error/warn/debug/trace to `onStderr`.
 *
 * Child processes write to the terminal's file descriptors directly, which no
 * JS-level guard can see; tests/terminal-ownership.test.ts forbids spawning one
 * that inherits stdout/stderr, and the PTY test drives the real UI with noisy
 * components to catch anything that slips past both.
 */

/** The writable surface the guard patches — `process.stdout` / `process.stderr`. */
export interface IGuardableStream {
  write: (...args: never[]) => boolean;
  readonly isTTY?: boolean;
  readonly rows?: number;
  readonly columns?: number;
}

/** What the renderer writes through: always the real terminal. */
export interface IOwnedTerminal {
  readonly isTTY?: boolean;
  readonly rows?: number;
  readonly columns?: number;
  write(data: string): boolean;
}

export interface ITerminalGuardOptions {
  stdout: IGuardableStream;
  stderr: IGuardableStream;
  /** Stray stdout while engaged — shown in the transcript, not painted raw. */
  onStdout: (text: string) => void;
  /** Stray stderr while engaged — to the debug trace. */
  onStderr: (text: string) => void;
  /** The console to take over (default: the global one). */
  console?: IConsoleLike;
}

type RawWrite = (chunk: unknown, ...rest: unknown[]) => boolean;

function isRawWrite(v: unknown): v is RawWrite {
  return typeof v === "function";
}

const decoder = new TextDecoder();

/** The console methods the guard takes over, and where each one goes. */
const CONSOLE_ROUTES = {
  log: "out",
  info: "out",
  dir: "out",
  error: "err",
  warn: "err",
  debug: "err",
  trace: "err",
} as const;

type ConsoleMethod = keyof typeof CONSOLE_ROUTES;

export type IConsoleLike = Record<ConsoleMethod, (...args: unknown[]) => void>;

/** A write() chunk as text (strings pass through; bytes are decoded). */
export function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return decoder.decode(chunk);
  }

  return String(chunk);
}

/** write(chunk, encoding?, callback?) — honour the callback so callers that
 *  wait on it (streams, loggers) are not left hanging. */
function callbackOf(rest: unknown[]): (() => void) | undefined {
  const last = rest.at(-1);

  return typeof last === "function"
    ? () => {
        Reflect.apply(last, undefined, []);
      }
    : undefined;
}

export class TerminalGuard {
  /** The renderer's handle: the real stdout, engaged or not. */
  readonly terminal: IOwnedTerminal;
  private readonly realOut: RawWrite;
  private savedConsole: Partial<IConsoleLike> = {};
  /** The exact write functions found at engage(), restored on release() —
   *  the originals themselves, not bound copies, so identity is preserved. */
  private savedWrites: { out: unknown; err: unknown } | null = null;
  private engagedNow = false;
  /** True while a diverted write is being handled — a sink that itself writes
   *  to a guarded stream must not loop back into the guard. */
  private diverting = false;

  constructor(private readonly opts: ITerminalGuardOptions) {
    const out: unknown = opts.stdout.write;

    if (!isRawWrite(out) || !isRawWrite(opts.stderr.write)) {
      throw new Error("terminal guard: streams have no write()");
    }

    this.realOut = out.bind(opts.stdout);

    const stdout = opts.stdout;
    const realOut = this.realOut;

    this.terminal = {
      get isTTY() {
        return stdout.isTTY;
      },
      get rows() {
        return stdout.rows;
      },
      get columns() {
        return stdout.columns;
      },
      write: (data: string): boolean => realOut(data),
    };
  }

  get engaged(): boolean {
    return this.engagedNow;
  }

  /** Start diverting every non-renderer write. Idempotent. */
  engage(): void {
    if (this.engagedNow) {
      return;
    }

    this.engagedNow = true;
    this.savedWrites = {
      out: this.opts.stdout.write,
      err: this.opts.stderr.write,
    };
    this.patch(this.opts.stdout, (text) => {
      this.opts.onStdout(text);
    });
    this.patch(this.opts.stderr, (text) => {
      this.opts.onStderr(text);
    });
    this.patchConsole();
  }

  /** Give the terminal back (the pane suspended or left). Idempotent. */
  release(): void {
    if (!this.engagedNow) {
      return;
    }

    this.engagedNow = false;

    if (this.savedWrites !== null) {
      Reflect.set(this.opts.stdout, "write", this.savedWrites.out);
      Reflect.set(this.opts.stderr, "write", this.savedWrites.err);
      this.savedWrites = null;
    }

    const target = this.opts.console ?? console;

    for (const [method, original] of Object.entries(this.savedConsole)) {
      Reflect.set(target, method, original);
    }

    this.savedConsole = {};
  }

  /** Route console.* to the sinks while engaged; restore exactly what was
   *  there before (which may itself be an earlier diverter). */
  private patchConsole(): void {
    const target = this.opts.console ?? console;

    for (const [method, route] of Object.entries(CONSOLE_ROUTES)) {
      const original: unknown = Reflect.get(target, method);

      if (typeof original !== "function") {
        continue;
      }

      Reflect.set(this.savedConsole, method, original);
      Reflect.set(target, method, (...args: unknown[]) => {
        const text = `${format(...args)}\n`;

        this.divertText(
          text,
          route === "out" ? this.opts.onStdout : this.opts.onStderr
        );
      });
    }
  }

  /** Hand text to a sink once; a sink that writes back into the guard is
   *  dropped instead of recursing or painting. */
  private divertText(text: string, sink: (text: string) => void): void {
    if (this.diverting) {
      return;
    }

    this.diverting = true;

    try {
      sink(text);
    } catch {
      // a failing sink must not break the caller
    } finally {
      this.diverting = false;
    }
  }

  private patch(stream: IGuardableStream, sink: (text: string) => void): void {
    const divert = (chunk: unknown, ...rest: unknown[]): boolean => {
      this.divertText(chunkText(chunk), sink);
      callbackOf(rest)?.();

      return true;
    };

    Reflect.set(stream, "write", divert);
  }
}
