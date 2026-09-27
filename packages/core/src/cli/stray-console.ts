/**
 * While the interactive UI owns the terminal, a library writing with
 * console.error / console.warn paints raw text over the frame. That scrolls
 * the alternate screen, and the UI's fixed rows (header, status, task panel)
 * are then redrawn one line off — leaving stacked duplicates behind. seen with
 * jsdom's "Could not parse CSS stylesheet" during web_fetch.
 *
 * tsforge's UI never uses console.error/warn (it writes through its own
 * renderer), so diverting them while the UI is up loses nothing: they go to
 * `sink` (the debug trace) instead.
 */
import { format } from "node:util";

type ConsoleMethod = "error" | "warn";

const METHODS: readonly ConsoleMethod[] = ["error", "warn"];

export interface IConsoleLike {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** Divert console.error/warn to `sink`; returns a function that restores them. */
export function divertStrayConsole(
  sink: (method: ConsoleMethod, message: string) => void,
  target: IConsoleLike = console
): () => void {
  const original = { error: target.error, warn: target.warn };

  for (const method of METHODS) {
    target[method] = (...args: unknown[]) => {
      sink(method, format(...args));
    };
  }

  return () => {
    target.error = original.error;
    target.warn = original.warn;
  };
}
