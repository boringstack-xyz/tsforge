/**
 * Download public media (post / comment images) next to the notes. Fetched
 * directly by tsforge — these are public CDN files, no login involved — and
 * vetted hard: https only, the plugin's media-host allowlist, no private
 * addresses, an image content-type, and a size cap. A failure never fails the
 * tool call; the caller renders the item as a plain link instead.
 */
import { writeFile } from "node:fs/promises";
import { isPrivateHost } from "../lib/net/ssrf";
import { resolveNotesPath, slugifyTopic } from "../lib/notes/notes-path";

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const ASSET_TIMEOUT_MS = 30_000;

const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

export type AssetFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface IAssetRequest {
  url: string;
  /** Topic folder under notes/. */
  topic: string;
  /** Sub-folder under assets/, e.g. the post id. */
  group: string;
  /** File stem, e.g. "3". */
  name: string;
}

export type AssetResult =
  { ok: true; rel: string } | { ok: false; reason: string };

/** Why `raw` may not be downloaded, or null when it may. */
export function assetUrlProblem(
  raw: string,
  mediaHosts: readonly string[]
): string | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }

  if (url.protocol !== "https:") {
    return "not https";
  }

  if (!mediaHosts.includes(url.hostname)) {
    return `host ${url.hostname} is not an allowed media host`;
  }

  return isPrivateHost(url.hostname) ? "private host" : null;
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");

  if (declared > MAX_ASSET_BYTES) {
    return null;
  }

  const body = new Uint8Array(await res.arrayBuffer());

  return body.byteLength > MAX_ASSET_BYTES ? null : body;
}

export async function downloadAsset(
  cwd: string,
  req: IAssetRequest,
  mediaHosts: readonly string[],
  fetchImpl: AssetFetch = fetch
): Promise<AssetResult> {
  const problem = assetUrlProblem(req.url, mediaHosts);

  if (problem !== null) {
    return { ok: false, reason: problem };
  }

  let res: Response;

  try {
    res = await fetchImpl(req.url, {
      redirect: "error",
      signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${String(res.status)}` };
  }

  const type =
    (res.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase() ?? "";
  const ext = EXT_BY_TYPE[type];

  if (ext === undefined) {
    return {
      ok: false,
      reason: `not an image (${type.length > 0 ? type : "no content-type"})`,
    };
  }

  const body = await readCapped(res);

  if (body === null) {
    return { ok: false, reason: "larger than 10 MB" };
  }

  const target = await resolveNotesPath(cwd, [
    slugifyTopic(req.topic),
    "assets",
    req.group,
    `${req.name}.${ext}`,
  ]);

  if ("error" in target) {
    return { ok: false, reason: target.error };
  }

  await writeFile(target.path, body);

  return { ok: true, rel: target.rel };
}
