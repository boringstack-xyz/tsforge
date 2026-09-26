/**
 * Per-host request pacing with backoff. A long research run makes hundreds of
 * requests to one site; unpaced, that looks like scraping and earns 429s (or a
 * flagged account, since these go out with the user's own cookies).
 */

export interface IPacerDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;

const REAL_DEPS: IPacerDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class Pacer {
  private readonly nextAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    private readonly deps: IPacerDeps = REAL_DEPS
  ) {}

  /** Wait until `host` may be hit again, then reserve the next slot. */
  async wait(host: string): Promise<void> {
    const now = this.deps.now();
    const at = this.nextAt.get(host) ?? now;

    this.nextAt.set(host, Math.max(at, now) + this.minIntervalMs);

    if (at > now) {
      await this.deps.sleep(at - now);
    }
  }

  /** Push the host's next slot out (after a 429 / 5xx). */
  async backoff(host: string, ms: number): Promise<void> {
    const wait = Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);

    this.nextAt.set(host, this.deps.now() + wait + this.minIntervalMs);
    await this.deps.sleep(wait);
  }
}

/** Delay before retry `attempt` (1-based): Retry-After when the server sent a
 *  usable one, else 2s, 4s, 8s … capped. */
export function backoffMs(attempt: number, retryAfter?: string | null): number {
  const seconds =
    retryAfter === undefined || retryAfter === null
      ? Number.NaN
      : Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }

  return Math.min(2000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}
