import { z } from "zod";

export const MediaAsset = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  /** Slash path, "" for the root ("brand/logos"). */
  folder: z.string(),
  altText: z.string().nullable(),
  /** Simulated storage location; replacing the file keeps the id and bumps `version`. */
  url: z.string(),
  version: z.number().int(),
  /** Time-limited links handed out by A09. */
  accessLinks: z.array(z.object({ url: z.string(), expiresAt: z.string() })),
  uploadedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

// An asset is "referenced" when its id appears in the `mediaIds` array of any record (landing pages, blog posts, lessons).
// A10 refuses to delete a referenced one.
