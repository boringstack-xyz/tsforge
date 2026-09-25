/** Build the extension into dist/ — load it via chrome://extensions → Load unpacked. */
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });

const builds = [
  // content.js is injected with chrome.scripting.executeScript({files}) — a
  // classic script, so it must be a self-contained IIFE.
  { entry: "src/content.ts", format: "iife" as const },
  { entry: "src/background.ts", format: "esm" as const },
  { entry: "src/options.ts", format: "esm" as const },
];

for (const { entry, format } of builds) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: dist,
    format,
    target: "browser",
    minify: false,
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }

    process.exit(1);
  }
}

await cp(join(root, "static"), dist, { recursive: true });

console.log(`built ${dist}`);
