import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, inDateRange, Limit, listOf, page } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { Note, NOTE_TABLES, NOTE_TARGETS, NoteTarget } from "./schema.js";

export { Note } from "./schema.js";

// Free-text notes on contacts, leads, deals, appointments and invoices. Edits keep the earlier text.

const NoteId = z.string().describe("note id (nt_…)");
const Target = z.strictObject(NoteTarget.shape);

function target(store: Store, t: NoteTarget): void {
  mustGet(store, NOTE_TABLES[t.type], t.id, t.type);
}

const same = (a: NoteTarget, b: NoteTarget) => a.type === b.type && a.id === b.id;

const createNote = defineAction({
  id: "M07.A01",
  description: "Write a note about a contact, lead, deal, appointment or invoice (e.g. what was said on a call). To log a to-do instead, use M06.A01 Create task.",
  risk: "write",
  input: z.strictObject({ body: z.string().min(1), attachTo: Target.optional().describe("the record it's about"), pinned: z.boolean().optional() }),
  typedIds: { "attachTo.id": "attachTo.type" },
  output: Note,
  siblings: ["M06.A01"],
  entities: { produces: "note" },
  example: () => ({ body: "Asked for a callback after the board meeting", attachTo: { type: "contact", id: "ct_1" } }),
  handler: (a, { store, clock, actorId }) => {
    if (a.attachTo) target(store, a.attachTo);
    const now = clock.now().toISOString();
    return store.insert("notes", "nt", {
      body: a.body,
      attachedTo: a.attachTo ? [a.attachTo] : [],
      pinned: a.pinned ?? false,
      authorId: actorId ?? "us_1",
      revisions: [],
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getNote = defineAction({
  id: "M07.A02",
  description: "Get one note: its text, author, the records it's on and whether it's pinned.",
  risk: "read",
  input: z.strictObject({ noteId: NoteId }),
  output: Note,
  entities: { consumes: ["note"] },
  example: () => ({ noteId: "nt_1" }),
  handler: ({ noteId }, { store }) => mustGet<Note>(store, "notes", noteId, "note"),
});

const searchNotes = defineAction({
  id: "M07.A03",
  description: "Find notes on a record, by author, pinned, date written or text. Pinned notes come first, then newest. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({
    recordType: z.enum(NOTE_TARGETS).optional(),
    recordId: z.string().optional().describe("the contact, lead, deal, appointment or invoice id"),
    authorId: z.string().optional(),
    pinned: z.boolean().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    query: z.string().optional().describe("words in the note"),
    limit: Limit,
  }),
  output: listOf(Note),
  entities: { produces: "note" },
  typedIds: { recordId: "recordType" },
  example: () => ({ recordType: "contact", recordId: "ct_1" }),
  handler: (a, { store }) => {
    const items = store.find<Note>(
      "notes",
      (n) =>
        (!a.recordType || n.attachedTo.some((t) => t.type === a.recordType)) &&
        (!a.recordId || n.attachedTo.some((t) => t.id === a.recordId)) &&
        (!a.authorId || n.authorId === a.authorId) &&
        (a.pinned === undefined || n.pinned === a.pinned) &&
        inDateRange(n.createdAt, a.from, a.to) &&
        (!a.query || contains(n.body, a.query)),
    );
    items.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.createdAt.localeCompare(x.createdAt));
    return page(items, a.limit);
  },
});

const updateNote = defineAction({
  id: "M07.A04",
  description: "Rewrite a note's text. The old text is kept in its history (M07.A10).",
  risk: "write",
  input: z.strictObject({ noteId: NoteId, body: z.string().min(1) }),
  output: Note,
  entities: { consumes: ["note"] },
  example: () => ({ noteId: "nt_1", body: "Wants a callback on Friday, not Thursday" }),
  handler: ({ noteId, body }, { store, clock, actorId }) => {
    const n = mustGet<Note>(store, "notes", noteId, "note");
    if (n.body === body) throw new ActionError("CONFLICT", "The note already says that");
    const now = clock.now().toISOString();
    return store.update<Note>("notes", n.id, { body, revisions: [...n.revisions, { body: n.body, at: n.updatedAt, by: n.authorId }], authorId: actorId ?? n.authorId, updatedAt: now });
  },
});

const deleteNote = defineAction({
  id: "M07.A05",
  description: "Delete a note for good, with its history. To take it off one record but keep it, use M07.A07 Detach.",
  risk: "destructive",
  input: z.strictObject({ noteId: NoteId }),
  output: Note,
  entities: { consumes: ["note"] },
  example: (f) => ({ noteId: f.note().id }),
  handler: ({ noteId }, { store }) => {
    const n = mustGet<Note>(store, "notes", noteId, "note");
    store.delete("notes", n.id);
    return n;
  },
});

const attachNote = defineAction({
  id: "M07.A06",
  description: "Put an existing note on another record too (a contact, lead, deal, appointment or invoice).",
  risk: "write",
  input: z.strictObject({ noteId: NoteId, record: Target }),
  typedIds: { "record.id": "record.type" },
  output: Note,
  entities: { consumes: ["note"] },
  example: () => ({ noteId: "nt_1", record: { type: "opportunity", id: "op_1" } }),
  // updatedAt is when the text was last written (M07.A10 history reads it), so moving a note between records leaves it.
  handler: ({ noteId, record }, { store }) => {
    const n = mustGet<Note>(store, "notes", noteId, "note");
    target(store, record);
    if (n.attachedTo.some((t) => same(t, record))) throw new ActionError("CONFLICT", `The note is already on ${record.type} ${record.id}`);
    return store.update<Note>("notes", n.id, { attachedTo: [...n.attachedTo, record] });
  },
});

const detachNote = defineAction({
  id: "M07.A07",
  description: "Take a note off one record. The note itself is kept; to remove it entirely, use M07.A05 Delete note.",
  risk: "write",
  input: z.strictObject({ noteId: NoteId, record: Target }),
  typedIds: { "record.id": "record.type" },
  output: Note,
  entities: { consumes: ["note"] },
  example: () => ({ noteId: "nt_1", record: { type: "contact", id: "ct_1" } }),
  handler: ({ noteId, record }, { store }) => {
    const n = mustGet<Note>(store, "notes", noteId, "note");
    if (!n.attachedTo.some((t) => same(t, record))) {
      throw new ActionError("CONFLICT", `The note isn't on ${record.type} ${record.id}; it's on ${n.attachedTo.map((t) => `${t.type} ${t.id}`).join(", ") || "nothing"}`);
    }
    return store.update<Note>("notes", n.id, { attachedTo: n.attachedTo.filter((t) => !same(t, record)) });
  },
});

const pin = (id: string, pinned: boolean, description: string) =>
  defineAction({
    id,
    description,
    risk: "write",
    input: z.strictObject({ noteId: NoteId }),
    output: Note,
    entities: { consumes: ["note"] },
    example: (f) => ({ noteId: f.note({ pinned: !pinned }).id }),
    handler: ({ noteId }, { store }) => {
      const n = mustGet<Note>(store, "notes", noteId, "note");
      if (n.pinned === pinned) throw new ActionError("CONFLICT", `The note is already ${pinned ? "pinned" : "unpinned"}`);
      return store.update<Note>("notes", n.id, { pinned });
    },
  });

const pinNote = pin("M07.A08", true, "Pin a note so it shows first on its records.");
const unpinNote = pin("M07.A09", false, "Unpin a pinned note.");

const history = defineAction({
  id: "M07.A10",
  description: "Show every version of a note's text, oldest first, ending with the current one.",
  risk: "read",
  input: z.strictObject({ noteId: NoteId }),
  output: z.object({ items: z.array(z.object({ version: z.number(), body: z.string(), at: z.string(), by: z.string(), current: z.boolean() })) }),
  entities: { consumes: ["note"] },
  example: () => ({ noteId: "nt_1" }),
  handler: ({ noteId }, { store }) => {
    const n = mustGet<Note>(store, "notes", noteId, "note");
    const all = [...n.revisions.map((r) => ({ ...r, current: false })), { body: n.body, at: n.updatedAt, by: n.authorId, current: true }];
    return { items: all.map((r, i) => ({ version: i + 1, ...r })) };
  },
});

export default {
  actions: [createNote, getNote, searchNotes, updateNote, deleteNote, attachNote, detachNote, pinNote, unpinNote, history],
} satisfies ModuleExports;
