/**
 * Where a Reddit post or comment keeps its images:
 *  - gallery posts: `gallery_data.items` (the display order) → `media_metadata`
 *  - image posts: the link itself (`i.redd.it`, `i.imgur.com`), else the
 *    full-size `preview` source
 *  - comments: image links in the body, plus inline `media_metadata`
 * Video (`v.redd.it`) is reported as a link only — never downloaded.
 */
import { isArray, isRecord } from "../../lib/guards/guards";

type Obj = Record<string, unknown>;

const IMAGE_LINK_RE =
  /https:\/\/(?:i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it|i\.imgur\.com)\/[^\s)\]>"']+/gu;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp)(?:$|\?)/iu;
const DIRECT_IMAGE_HOSTS = new Set(["i.redd.it", "i.imgur.com"]);

function str(o: Obj, key: string): string {
  const v = o[key];

  return typeof v === "string" ? v : "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Images are saved at most this wide. Reddit's originals run ~1 MB each
 *  (1.3 GB over one long crawl); its 1080px previews are ~5× smaller and just
 *  as readable for a wiring photo or a diagram. */
export const MAX_IMAGE_WIDTH = 1080;

/** The widest rendition no wider than MAX_IMAGE_WIDTH, or null. Galleries
 *  list them as `{ u, x }`, post previews as `{ url, width }`. */
function bestRendition(
  list: unknown,
  urlKey: "u" | "url",
  widthKey: "x" | "width"
): string | null {
  let best: { url: string; width: number } | null = null;

  for (const r of isArray(list) ? list : []) {
    const url = isRecord(r) ? str(r, urlKey) : "";
    const width = isRecord(r) ? r[widthKey] : undefined;

    if (
      url.length > 0 &&
      typeof width === "number" &&
      width <= MAX_IMAGE_WIDTH &&
      (best === null || width > best.width)
    ) {
      best = { url, width };
    }
  }

  return best?.url ?? null;
}

/** URL of one `media_metadata` entry: its ≤1080px preview when Reddit made
 *  one, else the full-size image (animated → its gif). */
function metadataUrl(entry: unknown): string | null {
  if (!isRecord(entry) || entry.status !== "valid" || !isRecord(entry.s)) {
    return null;
  }

  const still = str(entry.s, "u");
  const full = still.length > 0 ? still : str(entry.s, "gif");
  const url = bestRendition(entry.p, "u", "x") ?? full;

  return url.length > 0 ? url : null;
}

function galleryImages(d: Obj): string[] {
  const items =
    isRecord(d.gallery_data) && isArray(d.gallery_data.items)
      ? d.gallery_data.items
      : [];
  const meta = isRecord(d.media_metadata) ? d.media_metadata : {};

  return items.flatMap((item) => {
    const id = isRecord(item) ? str(item, "media_id") : "";
    const url = id.length > 0 ? metadataUrl(meta[id]) : null;

    return url === null ? [] : [url];
  });
}

/** The post's preview image: the ≤1080px rendition, else the full source. */
function previewImage(d: Obj): string | null {
  const images =
    isRecord(d.preview) && isArray(d.preview.images) ? d.preview.images : [];
  const first = images[0];

  if (!isRecord(first)) {
    return null;
  }

  const source = isRecord(first.source) ? str(first.source, "url") : "";

  return (
    bestRendition(first.resolutions, "url", "width") ??
    (source.length > 0 ? source : null)
  );
}

export function postImages(d: Obj): string[] {
  if (d.is_gallery === true) {
    return galleryImages(d);
  }

  const url = str(d, "url");
  const direct = DIRECT_IMAGE_HOSTS.has(hostOf(url)) && IMAGE_EXT_RE.test(url);

  if (!direct && str(d, "post_hint") !== "image") {
    return [];
  }

  // An image post's preview is the same picture at ≤1080px — prefer it.
  const preview = previewImage(d);

  if (preview !== null) {
    return [preview];
  }

  return direct ? [url] : [];
}

export function postVideo(d: Obj): string | null {
  const media = isRecord(d.secure_media) ? d.secure_media : d.media;
  const video =
    isRecord(media) && isRecord(media.reddit_video) ? media.reddit_video : null;
  const url = video === null ? "" : str(video, "fallback_url");

  return d.is_video === true && url.length > 0 ? url : null;
}

/** Trim markdown/punctuation a link regex drags along (`…jpg).` / `…png,`). */
function tidy(url: string): string {
  return url.replace(/[.,;:!?*_]+$/u, "");
}

export function commentImages(d: Obj): string[] {
  const linked = [...str(d, "body").matchAll(IMAGE_LINK_RE)].map((m) =>
    tidy(m[0])
  );
  const meta = isRecord(d.media_metadata)
    ? Object.values(d.media_metadata)
    : [];
  const inline = meta.flatMap((entry) => {
    const url = metadataUrl(entry);

    return url === null ? [] : [url];
  });

  return [...new Set([...linked, ...inline])];
}
