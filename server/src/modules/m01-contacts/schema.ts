import { z } from "zod";

export const RELATIONSHIPS = ["spouse", "family", "colleague", "manager", "report", "assistant", "referred_by", "referred", "other"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** The other side of each relationship: if A is B's manager, B is A's report. */
export const INVERSE: Record<Relationship, Relationship> = {
  spouse: "spouse",
  family: "family",
  colleague: "colleague",
  manager: "report",
  report: "manager",
  assistant: "other",
  referred_by: "referred",
  referred: "referred_by",
  other: "other",
};

export const Preferences = z.object({
  email: z.boolean().describe("may receive marketing and follow-up email"),
  sms: z.boolean().describe("may receive text messages"),
  call: z.boolean().describe("may be called"),
  /** Do not disturb: blocks every channel, whatever the others say. */
  dnd: z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;

export const Contact = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  ownerId: z.string().nullable(),
  tags: z.array(z.string()),
  preferences: Preferences,
  relationships: z.array(z.object({ contactId: z.string(), type: z.enum(RELATIONSHIPS) })),
  status: z.enum(["active", "archived", "merged"]),
  /** Set when this contact was merged into another. */
  mergedInto: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Contact = z.infer<typeof Contact>;
