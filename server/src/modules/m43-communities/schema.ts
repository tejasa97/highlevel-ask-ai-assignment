import { z } from "zod";

export const Community = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  guidelines: z.string().nullable(),
  channels: z.array(z.object({ id: z.string(), name: z.string() })),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Community = z.infer<typeof Community>;

export const CommunityMember = z.object({
  id: z.string(),
  communityId: z.string(),
  contactId: z.string(),
  role: z.enum(["member", "moderator"]),
  /** Leaving keeps the row (with `leftAt`) so their posts keep an author; rejoining reactivates it. */
  joinedAt: z.string(),
  leftAt: z.string().nullable(),
});
export type CommunityMember = z.infer<typeof CommunityMember>;

export const CommunityPost = z.object({
  id: z.string(),
  communityId: z.string(),
  channelId: z.string(),
  /** A contact for member posts, a user (M48) for staff posts. */
  authorId: z.string(),
  /** Set on a reply; replies can't be pinned or replied to. */
  parentId: z.string().nullable(),
  body: z.string(),
  pinned: z.boolean(),
  reports: z.array(z.object({ by: z.string(), reason: z.string(), at: z.string() })),
  status: z.enum(["visible", "removed"]),
  createdAt: z.string(),
  removedAt: z.string().nullable(),
  removedBy: z.string().nullable(),
});
export type CommunityPost = z.infer<typeof CommunityPost>;
