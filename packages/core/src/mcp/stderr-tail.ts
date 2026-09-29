import { trace } from "../lib/trace";

/** A terminal colour/cursor sequence (ESC [ … letter), built from the char
 *  code so the pattern holds no literal control character. */
const ANSI_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
  "gu"
);

/** Lines of a server's stderr kept for error messages. */
const TAIL_LINES = 10;
/** Cap on one kept line — a server can print a whole stack or JSON blob. */
const MAX_LINE_CHARS = 300;

/**
 * A stdio MCP server's stderr, captured instead of inherited. Inherited, it
 * wrote straight onto the terminal over the interactive UI — `mcp-remote` (the
 * bridge for Linear, Notion and Sentry) logs every call as
 * `[pid] [Local→Remote] tools/call`. Each complete line goes to the debug
 * trace (TSFORGE_TRACE); the last few are kept so a server that dies can say
 * why in its error message.
 */
export class StderrTail {
  private buffer = "";
  private readonly lines: string[] = [];

  constructor(
    private readonly server: string,
    private readonly sink: (scope: string, line: string) => void = trace
  ) {}

  /** Feed a decoded chunk; complete lines are traced and kept. */
  push(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      this.keep(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
  }

  /** Flush a trailing partial line (the stream ended without a newline). */
  end(): void {
    if (this.buffer.length > 0) {
      this.keep(this.buffer);
      this.buffer = "";
    }
  }

  /** The kept lines, oldest first, as one line for an error message. */
  text(): string {
    return this.lines.join(" | ");
  }

  private keep(raw: string): void {
    // Drop colour codes (ESC [ … letter) and carriage returns: they are for a
    // terminal, not a log.
    const line = raw.replace(ANSI_RE, "").replace(/\r/gu, "").trim();

    if (line.length === 0) {
      return;
    }

    this.sink(`mcp:${this.server}`, line);
    this.lines.push(
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
    );

    if (this.lines.length > TAIL_LINES) {
      this.lines.shift();
    }
  }
}

/** Drain a stderr stream into `tail` until it closes. Never rejects. */
export async function drainStderr(
  stream: ReadableStream<Uint8Array>,
  tail: StderrTail
): Promise<void> {
  const decoder = new TextDecoder();

  try {
    for await (const chunk of stream) {
      tail.push(decoder.decode(chunk, { stream: true }));
    }
  } catch {
    // the process was killed mid-read; whatever arrived is already kept
  } finally {
    tail.end();
  }
}
