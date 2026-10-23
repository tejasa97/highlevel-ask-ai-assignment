import { z } from "zod";

export const PageSection = z.object({
  id: z.string(),
  type: z.enum(["hero", "text", "image", "cta", "form"]),
  heading: z.string().nullable(),
  body: z.string().nullable(),
});
export type PageSection = z.infer<typeof PageSection>;

export const LandingPage = z.object({
  id: z.string(),
  title: z.string(),
  /** Unique across landing pages. */
  slug: z.string(),
  sections: z.array(PageSection),
  /** The form (M18) embedded on the page; a page can't be published with a draft form attached. */
  formId: z.string().nullable(),
  /** Media assets (M39) used on the page. M39.A08 finds references by scanning every `mediaIds` array. */
  mediaIds: z.array(z.string()),
  seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
  status: z.enum(["draft", "published"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type LandingPage = z.infer<typeof LandingPage>;
