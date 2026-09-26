/** The parts of Reddit's JSON this plugin reads, after narrowing. */

export interface IRedditPost {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  score: number;
  numComments: number;
  createdUtc: number;
  permalink: string;
  /** The link target (an image, an external site, or the post itself). */
  url: string;
  selftext: string;
  over18: boolean;
  stickied: boolean;
  /** Image URLs in display order (gallery order, else the image, else preview). */
  images: string[];
  videoUrl: string | null;
}

/** Collapsed replies under `parentId` (a `t1_`/`t3_` fullname). Empty `ids`
 *  (or Reddit's `_` stub) means "continue this thread" — fetch the subtree. */
export interface IMoreStub {
  parentId: string;
  ids: string[];
  count: number;
}

export interface IRedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  isSubmitter: boolean;
  stickied: boolean;
  distinguished: string | null;
  replies: IRedditComment[];
  more: IMoreStub[];
  images: string[];
}

export interface IRedditThread {
  post: IRedditPost;
  comments: IRedditComment[];
  /** Top-level collapsed replies (parent is the post). */
  more: IMoreStub[];
}

export interface IListingPage {
  posts: IRedditPost[];
  after: string | null;
}

export interface ISubredditInfo {
  name: string;
  subscribers: number;
  description: string;
  over18: boolean;
}
