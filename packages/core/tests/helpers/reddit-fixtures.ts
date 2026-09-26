/**
 * Reddit JSON fixtures, shaped from Reddit's documented listing / thing format
 * (`{ kind, data }`, `Listing` with `children` and `after`, `more` stubs,
 * `gallery_data` + `media_metadata`, the morechildren `json.data.things`).
 * Hand-built: the live site cannot be reached from CI.
 */

export const NOW_UTC = 1_790_000_000;
export const YEAR = 365 * 86_400;

type Obj = Record<string, unknown>;

export function listing(children: Obj[], after: string | null = null): Obj {
  return { kind: "Listing", data: { after, children } };
}

export function post(id: string, extra: Obj = {}): Obj {
  return {
    kind: "t3",
    data: {
      id,
      title: `Post ${id}`,
      subreddit: "Guitar",
      author: "op_user",
      score: 412,
      num_comments: 87,
      created_utc: NOW_UTC - 2 * YEAR,
      permalink: `/r/Guitar/comments/${id}/post_${id}/`,
      url: `https://www.reddit.com/r/Guitar/comments/${id}/post_${id}/`,
      selftext: `Body of ${id}`,
      ...extra,
    },
  };
}

export function comment(id: string, extra: Obj = {}, replies: Obj[] = []): Obj {
  return {
    kind: "t1",
    data: {
      id,
      author: `user_${id}`,
      body: `comment ${id}`,
      score: 10,
      created_utc: NOW_UTC - YEAR,
      parent_id: "t3_p1",
      replies: replies.length > 0 ? listing(replies) : "",
      ...extra,
    },
  };
}

export function more(
  parentId: string,
  children: string[],
  count = children.length
): Obj {
  return {
    kind: "more",
    data: { id: children[0] ?? "_", parent_id: parentId, children, count },
  };
}

/** `/comments/p1.json`: a nested tree, a top-level `more` with 3 ids, a
 *  "continue this thread" stub under c2, AutoModerator, a deleted leaf, and a
 *  deleted comment that has replies (kept as a stub). */
export function threadJson(): Obj[] {
  return [
    listing([
      post("p1", {
        url: "https://i.redd.it/wiring.jpg",
        selftext: "Which caps for Jimmy Page wiring?",
      }),
    ]),
    listing([
      comment("auto", {
        author: "AutoModerator",
        body: "Rules reminder",
        stickied: true,
        distinguished: "moderator",
      }),
      comment(
        "c1",
        {
          body: "Use .022 caps. Photo: https://i.redd.it/mine.png)",
          score: 120,
        },
        [
          comment("c1a", {
            body: "thanks!",
            is_submitter: true,
            parent_id: "t1_c1",
          }),
        ]
      ),
      comment("c2", { body: "Long chain" }, [
        comment("c2a", { parent_id: "t1_c2" }, [more("t1_c2a", [], 0)]),
      ]),
      comment("gone", { body: "[deleted]", author: "[deleted]" }),
      comment("gone2", { body: "[removed]", author: "[deleted]" }, [
        comment("orphan", { parent_id: "t1_gone2" }),
      ]),
      more("t3_p1", ["m1", "m2", "m3"]),
    ]),
  ];
}

/** `/api/morechildren.json` for m1..m3 (m2 has a reply m2a). */
export function moreChildrenJson(): Obj {
  return {
    json: {
      errors: [],
      data: {
        things: [
          comment("m1", { parent_id: "t3_p1" }),
          comment("m2", { parent_id: "t3_p1" }),
          comment("m2a", { parent_id: "t1_m2" }),
          comment("m3", { parent_id: "t3_p1" }),
        ],
      },
    },
  };
}

/** `/comments/p1/_/c2a.json`: the subtree under c2a. */
export function continueJson(): Obj[] {
  return [
    listing([post("p1")]),
    listing([
      comment("c2a", { parent_id: "t1_c2" }, [
        comment("deep1", { parent_id: "t1_c2a" }),
      ]),
    ]),
  ];
}

export function galleryPost(id: string): Obj {
  return post(id, {
    is_gallery: true,
    url: `https://www.reddit.com/gallery/${id}`,
    gallery_data: { items: [{ media_id: "b" }, { media_id: "a" }] },
    media_metadata: {
      a: {
        status: "valid",
        e: "Image",
        m: "image/jpg",
        s: { u: "https://preview.redd.it/a.jpg?width=1&s=x" },
      },
      b: {
        status: "valid",
        e: "Image",
        m: "image/png",
        s: { u: "https://preview.redd.it/b.png?width=1&s=y" },
      },
      bad: { status: "failed" },
    },
  });
}

export function searchJson(): Obj {
  return listing(
    [
      post("p1"),
      post("p2", {
        is_video: true,
        secure_media: {
          reddit_video: { fallback_url: "https://v.redd.it/x/DASH_720.mp4" },
        },
      }),
      galleryPost("p3"),
    ],
    "t3_p3"
  );
}

export function subredditsJson(): Obj {
  return listing([
    {
      kind: "t5",
      data: {
        display_name: "Guitar",
        subscribers: 3_100_000,
        public_description: "All things guitar",
        over18: false,
      },
    },
    {
      kind: "t5",
      data: {
        display_name: "diypedals",
        subscribers: 120_000,
        public_description: "Build your own",
        over18: false,
      },
    },
  ]);
}
