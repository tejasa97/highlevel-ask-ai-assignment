import { z } from "zod";

/** Record types a note can be attached to, and the table each lives in. */
export const NOTE_TABLES = {
  contact: "contacts",
  lead: "leads",
  opportunity: "opportunities",
  appointment: "appointments",
  invoice: "invoices",
} as const;
export const NOTE_TARGETS = ["contact", "lead", "opportunity", "appointment", "invoice"] as const;

export const NoteTarget = z.object({ type: z.enum(NOTE_TARGETS), id: z.string() });
export type NoteTarget = z.infer<typeof NoteTarget>;

export const Note = z.object({
  id: z.string(),
  body: z.string(),
  /** The records this note is about; one note can sit on several (a call about a contact and their deal). */
  attachedTo: z.array(NoteTarget),
  pinned: z.boolean(),
  authorId: z.string(),
  /** Earlier versions, oldest first. The current text is `body`. */
  revisions: z.array(z.object({ body: z.string(), at: z.string(), by: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof Note>;
