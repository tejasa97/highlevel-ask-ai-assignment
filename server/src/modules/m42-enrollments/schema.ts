import { z } from "zod";

export const ENROLLMENT_STATUSES = ["active", "suspended", "revoked", "completed"] as const;

export const Enrollment = z.object({
  id: z.string(),
  courseId: z.string(),
  contactId: z.string(),
  /** active ⇄ suspended; revoked is final; completed once every published lesson is done. */
  status: z.enum(ENROLLMENT_STATUSES),
  enrolledAt: z.string(),
  expiresAt: z.string().nullable(),
  completions: z.array(z.object({ lessonId: z.string(), at: z.string() })),
  certificate: z.object({ number: z.string(), issuedAt: z.string() }).nullable(),
  /** Set when a membership (M44) granted the access; revoking the membership revokes this too. */
  membershipId: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
});
export type Enrollment = z.infer<typeof Enrollment>;
