/**
 * Split rendered page markdown into model-sized chunks at paragraph
 * boundaries; only a single paragraph longer than a chunk is cut mid-block
 * (at a line break or space).
 */

const REF_MARKER = /\[(\d+) (?:link|page|expand|summary):/gu;

function hardSplit(block: string, size: number): string[] {
  const out: string[] = [];
  let rest = block;

  while (rest.length > size) {
    // Prefer a line break, then a space, before the limit.
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > size / 2 ? cut : size;

    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }

  if (rest.length > 0) {
    out.push(rest);
  }

  return out;
}

export function chunkMarkdown(markdown: string, size: number): string[] {
  const blocks = markdown
    .split(/\n{2,}/u)
    .flatMap((b) => (b.length > size ? hardSplit(b, size) : [b]));
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const joined = current.length === 0 ? block : `${current}\n\n${block}`;

    if (joined.length <= size) {
      current = joined;
      continue;
    }

    chunks.push(current);
    current = block;
  }

  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

/** Ref numbers that appear in a chunk, in order of appearance. */
export function refsIn(chunk: string): number[] {
  return [...chunk.matchAll(REF_MARKER)].map((m) => Number(m[1]));
}
