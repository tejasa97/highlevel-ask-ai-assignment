import { z } from "zod";

export const ENTITLEMENT_TYPES = ["course", "community"] as const;

export const Entitlement = z.object({ type: z.enum(ENTITLEMENT_TYPES), targetId: z.string() });
export type Entitlement = z.infer<typeof Entitlement>;

export const MembershipPlan = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** What membership gives access to: courses (M40) and communities (M43). */
  entitlements: z.array(Entitlement),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MembershipPlan = z.infer<typeof MembershipPlan>;

export const Membership = z.object({
  id: z.string(),
  planId: z.string(),
  contactId: z.string(),
  status: z.enum(["active", "expired", "revoked"]),
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
  grantedBy: z.string(),
  /** Community member rows this grant created or reactivated. Revoke sets leftAt on these only. */
  grantedCommunityMemberIds: z.array(z.string()),
});
export type Membership = z.infer<typeof Membership>;
