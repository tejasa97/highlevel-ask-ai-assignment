import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, atLeastOne, contains, inDateRange, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { BlogPost, POST_STATUSES } from "./schema.js";

export { BlogPost } from "./schema.js";

// Posts move draft → scheduled (a future publishAt) → published, and published ⇄ unpublished. Nothing publishes them when the clock passes publishAt.

const PostId = z.string().describe("blog post id (blg_…)");
const Text = z.string().trim().min(1);
const SeoText = z.string().trim().nullable().optional();

function noChange(): never {
  throw new ActionError("CONFLICT", "The record already has that value");
}

function load(store: Store, id: string): BlogPost {
  return mustGet<BlogPost>(store, "blog_posts", id, "blog post");
}

function slugTaken(store: Store, slug: string, exceptId?: string): boolean {
  const key = slug.trim().toLowerCase();
  return store.find<BlogPost>("blog_posts", (p) => p.id !== exceptId && p.slug.toLowerCase() === key).length > 0;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requireFuture(iso: string, nowIso: string, label: string): void {
  const when = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(when)) throw new ActionError("INVALID", `${label} is not a valid timestamp`);
  if (when < now) throw new ActionError("INVALID", `${label} ${iso} is in the past (now is ${nowIso})`);
  if (when === now) throw new ActionError("INVALID", `${label} ${iso} is not in the future (now is ${nowIso})`);
}

function mediaIdsOf(store: Store, ids: string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    mustGet(store, "media_assets", id, "media asset");
    next.push(id);
  }
  return next;
}

const createPost = defineAction({
  id: "M38.A01",
  description:
    "Create a draft blog post with a title, a slug unique across posts, and a body. It stays a draft until M38.A08 schedules it. This does not upload media; deleting a referenced file is M39.A10.",
  risk: "write",
  input: z.strictObject({
    title: Text,
    slug: Text,
    body: z.string().min(1),
    authorId: z.string().optional().describe("user id (us_…); defaults to the acting user"),
  }),
  output: BlogPost,
  siblings: ["M39.A10"],
  entities: { produces: "blog_post", consumes: ["user"] },
  example: () => ({ title: "Spring notes", slug: "spring-notes", body: "What changed this spring." }),
  handler: (a, { store, clock, actorId }) => {
    const slug = a.slug.trim();
    if (slugTaken(store, slug)) throw new ActionError("DUPLICATE", `A blog post with slug "${slug}" already exists`);
    const author = activeUser(store, a.authorId ?? actorId ?? "us_1", "author posts");
    const at = clock.now().toISOString();
    return store.insert("blog_posts", "blg", {
      title: a.title.trim(),
      slug,
      body: a.body,
      authorId: author.id,
      categories: [],
      mediaIds: [],
      seo: { title: null, description: null },
      status: "draft" as const,
      publishAt: null,
      publishedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  },
});

const getPost = defineAction({
  id: "M38.A02",
  description:
    "Get one blog post: body, author, categories, SEO, status and the time it is scheduled or was published. To find posts, use M38.A03 Search blog posts.",
  risk: "read",
  input: z.strictObject({ postId: PostId }),
  output: BlogPost,
  entities: { consumes: ["blog_post"] },
  example: (f) => ({ postId: f.blogPost().id }),
  handler: ({ postId }, { store }) => load(store, postId),
});

const searchPosts = defineAction({
  id: "M38.A03",
  description:
    "Search blog posts by title, slug, body, author, category, status or created date (inclusive). Newest createdAt first, then id. To read one post in full, use M38.A02 Get blog post.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional(),
    status: z.enum(POST_STATUSES).optional(),
    authorId: z.string().optional(),
    category: z.string().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(BlogPost),
  entities: { produces: "blog_post" },
  example: () => ({}),
  handler: (a, { store }) => {
    const query = a.query?.trim();
    const category = a.category?.trim().toLowerCase();
    const items = store.find<BlogPost>(
      "blog_posts",
      (p) =>
        (!a.status || p.status === a.status) &&
        (!a.authorId || p.authorId === a.authorId) &&
        (!category || p.categories.some((c) => c.toLowerCase() === category)) &&
        inDateRange(p.createdAt, a.from, a.to) &&
        (!query || contains(p.title, query) || contains(p.slug, query) || contains(p.body, query)),
    );
    items.sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updatePost = defineAction({
  id: "M38.A04",
  description:
    "Change a post's title, slug or body, or replace the media assets it uses. Title, slug and body are refused while it is published (unpublish with M38.A10 first). Media can change in any status so a file can be detached. This does not publish the post.",
  risk: "write",
  input: z.strictObject({
    postId: PostId,
    title: Text.optional(),
    slug: Text.optional(),
    body: z.string().min(1).optional(),
    mediaIds: z.array(z.string()).optional().describe("media asset ids (md_…) used by the post"),
  }),
  output: BlogPost,
  entities: { consumes: ["blog_post"] },
  example: (f) => ({ postId: f.blogPost().id, title: "Spring notes revised" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["title", "slug", "body", "mediaIds"]);
    const post = load(store, a.postId);
    if ((a.title !== undefined || a.slug !== undefined || a.body !== undefined) && post.status === "published") {
      requireState(`Post "${post.title}"`, post.status, ["draft", "scheduled", "unpublished"], "have its title, slug or body changed — unpublish it first");
    }
    const title = a.title === undefined ? post.title : a.title.trim();
    const slug = a.slug === undefined ? post.slug : a.slug.trim();
    const body = a.body === undefined ? post.body : a.body;
    if (a.slug !== undefined && slug.toLowerCase() !== post.slug.toLowerCase() && slugTaken(store, slug, post.id)) {
      throw new ActionError("DUPLICATE", `A blog post with slug "${slug}" already exists`);
    }
    const mediaIds = a.mediaIds === undefined ? post.mediaIds : mediaIdsOf(store, a.mediaIds);
    if (title === post.title && slug === post.slug && body === post.body && JSON.stringify(mediaIds) === JSON.stringify(post.mediaIds)) noChange();
    return store.update<BlogPost>("blog_posts", post.id, { title, slug, body, mediaIds, updatedAt: clock.now().toISOString() });
  },
});

const assignAuthor = defineAction({
  id: "M38.A05",
  description:
    "Set the active user who authors a post. This changes only the author, not the title or body (M38.A04). A published post must be unpublished first (M38.A10).",
  risk: "write",
  input: z.strictObject({ postId: PostId, authorId: z.string().describe("user id (us_…)") }),
  output: BlogPost,
  entities: { consumes: ["blog_post", "user"] },
  example: (f) => ({ postId: f.blogPost().id, authorId: f.user().id }),
  handler: ({ postId, authorId }, { store, clock }) => {
    const post = load(store, postId);
    requireState(`Post "${post.title}"`, post.status, ["draft", "scheduled", "unpublished"], "have its author changed — unpublish it first");
    const author = activeUser(store, authorId, "author posts");
    if (post.authorId === author.id) noChange();
    return store.update<BlogPost>("blog_posts", post.id, { authorId: author.id, updatedAt: clock.now().toISOString() });
  },
});

const setCategories = defineAction({
  id: "M38.A06",
  description:
    "Replace a post's category list. This does not change the body (M38.A04) or the SEO metadata (M38.A07). A published post must be unpublished first (M38.A10).",
  risk: "write",
  input: z.strictObject({ postId: PostId, categories: z.array(z.string()) }),
  output: BlogPost,
  entities: { consumes: ["blog_post"] },
  example: (f) => ({ postId: f.blogPost().id, categories: ["News"] }),
  handler: ({ postId, categories }, { store, clock }) => {
    const post = load(store, postId);
    requireState(`Post "${post.title}"`, post.status, ["draft", "scheduled", "unpublished"], "have its categories changed — unpublish it first");
    const next: string[] = [];
    const seen = new Set<string>();
    for (const raw of categories) {
      const category = raw.trim();
      if (!category) throw new ActionError("INVALID", "Categories can't be blank");
      const key = category.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(category);
    }
    if (JSON.stringify(next) === JSON.stringify(post.categories)) noChange();
    return store.update<BlogPost>("blog_posts", post.id, { categories: next, updatedAt: clock.now().toISOString() });
  },
});

const setSeo = defineAction({
  id: "M38.A07",
  description:
    "Set a post's SEO title and description. This is metadata, not the article body (M38.A04). Pass at least one field. A published post must be unpublished first (M38.A10).",
  risk: "write",
  input: z.strictObject({ postId: PostId, title: SeoText, description: SeoText }),
  output: BlogPost,
  entities: { consumes: ["blog_post"] },
  example: (f) => ({ postId: f.blogPost().id, title: "Spring notes" }),
  handler: (a, { store, clock }) => {
    atLeastOne(a, ["title", "description"]);
    const post = load(store, a.postId);
    requireState(`Post "${post.title}"`, post.status, ["draft", "scheduled", "unpublished"], "have its SEO changed — unpublish it first");
    const title = a.title === undefined ? post.seo.title : blankToNull(a.title);
    const description = a.description === undefined ? post.seo.description : blankToNull(a.description);
    if (title === post.seo.title && description === post.seo.description) noChange();
    return store.update<BlogPost>("blog_posts", post.id, { seo: { title, description }, updatedAt: clock.now().toISOString() });
  },
});

const schedulePost = defineAction({
  id: "M38.A08",
  description:
    "Schedule a draft post, moving it to scheduled with a publishAt in the future. A past or current time is rejected. Publishing immediately is M38.A09, which accepts scheduled or unpublished posts, not drafts.",
  risk: "write",
  input: z.strictObject({ postId: PostId, publishAt: z.iso.datetime() }),
  output: BlogPost,
  entities: { consumes: ["blog_post"] },
  example: (f) => ({ postId: f.blogPost().id, publishAt: "2026-12-01T15:00:00.000Z" }),
  handler: ({ postId, publishAt }, { store, clock }) => {
    const post = load(store, postId);
    requireState(`Post "${post.title}"`, post.status, ["draft"], "be scheduled");
    requireFuture(publishAt, clock.now().toISOString(), "publishAt");
    return store.update<BlogPost>("blog_posts", post.id, { status: "scheduled", publishAt, updatedAt: clock.now().toISOString() });
  },
});

const publishPost = defineAction({
  id: "M38.A09",
  description:
    "Publish a scheduled or unpublished post now. A draft must be scheduled first (M38.A08); this does not wait for publishAt. Taking it offline again is M38.A10 Unpublish post.",
  risk: "external",
  input: z.strictObject({ postId: PostId }),
  output: BlogPost,
  entities: { consumes: ["blog_post"] },
  example: (f) => ({ postId: f.blogPost({ status: "scheduled", publishAt: "2026-12-01T15:00:00.000Z" }).id }),
  handler: ({ postId }, { store, clock }) => {
    const post = load(store, postId);
    requireState(`Post "${post.title}"`, post.status, ["scheduled", "unpublished"], "be published — schedule a draft first");
    const at = clock.now().toISOString();
    return store.update<BlogPost>("blog_posts", post.id, { status: "published", publishedAt: at, updatedAt: at });
  },
});

const unpublishPost = defineAction({
  id: "M38.A10",
  description:
    "Take a published post offline (status unpublished). It can be published again with M38.A09. This does not delete the post or change its slug.",
  risk: "destructive",
  input: z.strictObject({ postId: PostId }),
  output: BlogPost,
  entities: { consumes: ["blog_post"] },
  example: (f) => ({ postId: f.blogPost({ status: "published", publishedAt: f.now() }).id }),
  handler: ({ postId }, { store, clock }) => {
    const post = load(store, postId);
    requireState(`Post "${post.title}"`, post.status, ["published"], "be unpublished");
    return store.update<BlogPost>("blog_posts", post.id, { status: "unpublished", updatedAt: clock.now().toISOString() });
  },
});

export default {
  actions: [createPost, getPost, searchPosts, updatePost, assignAuthor, setCategories, setSeo, schedulePost, publishPost, unpublishPost],
} satisfies ModuleExports;
