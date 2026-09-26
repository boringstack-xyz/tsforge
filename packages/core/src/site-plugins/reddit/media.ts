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

/** Full-size URL of one `media_metadata` entry (animated → its gif/mp4 still). */
function metadataUrl(entry: unknown): string | null {
  if (!isRecord(entry) || entry.status !== "valid" || !isRecord(entry.s)) {
    return null;
  }

  const still = str(entry.s, "u");
  const url = still.length > 0 ? still : str(entry.s, "gif");

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

function previewImage(d: Obj): string | null {
  const images =
    isRecord(d.preview) && isArray(d.preview.images) ? d.preview.images : [];
  const first = images[0];
  const source =
    isRecord(first) && isRecord(first.source) ? str(first.source, "url") : "";

  return source.length > 0 ? source : null;
}

export function postImages(d: Obj): string[] {
  if (d.is_gallery === true) {
    return galleryImages(d);
  }

  const url = str(d, "url");

  if (DIRECT_IMAGE_HOSTS.has(hostOf(url)) && IMAGE_EXT_RE.test(url)) {
    return [url];
  }

  const preview = str(d, "post_hint") === "image" ? previewImage(d) : null;

  return preview === null ? [] : [preview];
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
