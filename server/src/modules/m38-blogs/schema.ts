import { z } from "zod";

export const POST_STATUSES = ["draft", "scheduled", "published", "unpublished"] as const;

export const BlogPost = z.object({
  id: z.string(),
  title: z.string(),
  /** Unique across posts. */
  slug: z.string(),
  body: z.string(),
  /** A user (M48). */
  authorId: z.string(),
  categories: z.array(z.string()),
  /** Media assets (M39), e.g. the cover image. */
  mediaIds: z.array(z.string()),
  seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
  /** draft → scheduled (publishAt in the future) → published ⇄ unpublished. */
  status: z.enum(POST_STATUSES),
  publishAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BlogPost = z.infer<typeof BlogPost>;
