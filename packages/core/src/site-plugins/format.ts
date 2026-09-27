/** Small formatting helpers shared by the site plugins. */

export function age(createdUtc: number, now: Date): string {
  const s = Math.max(0, Math.floor(now.getTime() / 1000 - createdUtc));
  const steps: [number, string][] = [
    [365 * 86_400, "y"],
    [30 * 86_400, "mo"],
    [86_400, "d"],
    [3600, "h"],
    [60, "m"],
  ];

  for (const [size, unit] of steps) {
    if (s >= size) {
      return `${String(Math.floor(s / size))}${unit}`;
    }
  }

  return "now";
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} […]`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Indent every line of a block (for nested comments). */
export function indent(text: string, pad: string): string[] {
  return text.split("\n").map((l) => `${pad}${l}`.trimEnd());
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/** Decode the HTML entities APIs put in plain-text fields (titles). */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/gu, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/giu, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&quot;/gu, '"')
    .replace(/&apos;|&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&");
}
