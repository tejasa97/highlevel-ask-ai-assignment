import { z } from "zod";

export const SitePage = z.object({
  id: z.string(),
  title: z.string(),
  /** Unique within the site. */
  slug: z.string(),
  /** A landing page (M37) that provides the content, if any. */
  landingPageId: z.string().nullable(),
});
export type SitePage = z.infer<typeof SitePage>;

export const Website = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  pages: z.array(SitePage),
  homePageId: z.string().nullable(),
  /** Menu entries, in order; each points at one of `pages`. */
  navigation: z.array(z.object({ label: z.string(), pageId: z.string() })),
  seoDefaults: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
  /** A site can be published only with a home page set. */
  status: z.enum(["draft", "published"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type Website = z.infer<typeof Website>;
