import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { candidates, contains, Limit, listOf, Name, page } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Campaign } from "../m15-campaigns/schema.js";
import { Tag, TAG_COLORS, TAGGED_TABLES, TAGGED_TYPES } from "./schema.js";

export { Tag } from "./schema.js";

// Labels on contacts and leads ("vip", "newsletter"). Records hold tag names; this module owns the list
// of tags, their colors, and renames and merges that rewrite every tagged record.

const TagId = z.string().describe("tag id (tg_…)");
const lower = (s: string) => s.trim().toLowerCase();

interface Tagged {
  id: string;
  name: string;
  tags: string[];
  status: string;
}

/** Every record of a type that carries a tag (by name, case-insensitive). */
function taggedWith(store: Store, type: (typeof TAGGED_TYPES)[number], name: string): Tagged[] {
  return store.find<Tagged>(TAGGED_TABLES[type], (r) => r.status !== "merged" && r.tags.some((t) => lower(t) === lower(name)));
}

function usage(store: Store, name: string): { contacts: number; leads: number; total: number } {
  const contacts = taggedWith(store, "contact", name).length;
  const leads = taggedWith(store, "lead", name).length;
  return { contacts, leads, total: contacts + leads };
}

/**
 * Replaces tag `from` with `to` on every record (dropping it when `to` is null), without duplicates, and on the
 * audience of every campaign that hasn't launched. Returns how many records changed.
 */
function retag(store: Store, from: string, to: string | null): number {
  for (const c of store.find<Campaign>("campaigns", (c) => (c.status === "draft" || c.status === "scheduled") && !!c.audience.tag && lower(c.audience.tag) === lower(from)))
    store.update("campaigns", c.id, { audience: { ...c.audience, tag: to } });
  let n = 0;
  for (const type of TAGGED_TYPES) {
    for (const r of taggedWith(store, type, from)) {
      const rest = r.tags.filter((t) => lower(t) !== lower(from));
      const tags = to && !rest.some((t) => lower(t) === lower(to)) ? [...rest, to] : rest;
      store.update(TAGGED_TABLES[type], r.id, { tags });
      n++;
    }
  }
  return n;
}

function nameTaken(store: Store, name: string, exceptId?: string): Tag | undefined {
  return store.find<Tag>("tags", (t) => t.id !== exceptId && lower(t.name) === lower(name))[0];
}

const createTag = defineAction({
  id: "M08.A01",
  description: "Add a new tag to the account's tag list, with an optional color and description. To put a tag on a record, use M08.A06 Apply tag.",
  risk: "write",
  input: z.strictObject({ name: Name.max(40), color: z.enum(TAG_COLORS).optional().describe("default gray"), description: z.string().optional() }),
  output: Tag,
  entities: { produces: "tag" },
  example: () => ({ name: "Hot prospect", color: "red" }),
  handler: (a, { store, clock }) => {
    const dup = nameTaken(store, a.name);
    if (dup) throw new ActionError("DUPLICATE", `A tag called "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    return store.insert("tags", "tg", { name: a.name.trim(), color: a.color ?? "gray", description: a.description ?? null, createdAt: clock.now().toISOString() });
  },
});

const listTags = defineAction({
  id: "M08.A02",
  description: "List the account's tags, alphabetically, optionally filtered by part of the name or color.",
  risk: "read",
  input: z.strictObject({ query: z.string().optional(), color: z.enum(TAG_COLORS).optional(), limit: Limit }),
  output: listOf(Tag),
  entities: { produces: "tag" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<Tag>("tags", (t) => (!a.query || contains(t.name, a.query)) && (!a.color || t.color === a.color));
    items.sort((x, y) => x.name.localeCompare(y.name));
    return page(items, a.limit);
  },
});

const renameTag = defineAction({
  id: "M08.A03",
  description: "Rename a tag. Every contact and lead that has it gets the new name.",
  risk: "write",
  input: z.strictObject({ tagId: TagId, name: Name.max(40) }),
  output: Tag.extend({ recordsUpdated: z.number() }),
  entities: { consumes: ["tag"] },
  example: () => ({ tagId: "tg_2", name: "Newsletter subscriber" }),
  handler: ({ tagId, name }, { store }) => {
    const t = mustGet<Tag>(store, "tags", tagId, "tag");
    if (t.name === name.trim()) throw new ActionError("CONFLICT", `The tag is already called "${t.name}"`);
    const dup = nameTaken(store, name, t.id);
    if (dup) throw new ActionError("DUPLICATE", `A tag called "${dup.name}" already exists (${dup.id}); merge into it with M08.A09 instead`, { existingId: dup.id });
    const recordsUpdated = retag(store, t.name, name.trim());
    return { ...store.update<Tag>("tags", t.id, { name: name.trim() }), recordsUpdated };
  },
});

const setColor = defineAction({
  id: "M08.A04",
  description: "Change a tag's color.",
  risk: "write",
  input: z.strictObject({ tagId: TagId, color: z.enum(TAG_COLORS) }),
  output: Tag,
  entities: { consumes: ["tag"] },
  example: () => ({ tagId: "tg_1", color: "purple" }),
  handler: ({ tagId, color }, { store }) => {
    const t = mustGet<Tag>(store, "tags", tagId, "tag");
    if (t.color === color) throw new ActionError("CONFLICT", `"${t.name}" is already ${color}`);
    return store.update<Tag>("tags", t.id, { color });
  },
});

const deleteTag = defineAction({
  id: "M08.A05",
  description: "Delete a tag that no contact or lead uses any more. A tag still in use must be removed from those records (M08.A07) or merged into another tag (M08.A09) first.",
  risk: "destructive",
  input: z.strictObject({ tagId: TagId }),
  output: Tag,
  entities: { consumes: ["tag"] },
  example: (f) => ({ tagId: f.tag().id }),
  handler: ({ tagId }, { store }) => {
    const t = mustGet<Tag>(store, "tags", tagId, "tag");
    const u = usage(store, t.name);
    if (u.total > 0) throw new ActionError("CONFLICT", `"${t.name}" is still on ${u.contacts} contact(s) and ${u.leads} lead(s); remove it from them or merge it into another tag first`, u);
    store.delete("tags", t.id);
    return t;
  },
});

const Record_ = z.strictObject({ tagId: TagId, recordType: z.enum(TAGGED_TYPES), recordId: z.string().describe("contact or lead id") });

function record(store: Store, type: (typeof TAGGED_TYPES)[number], id: string): Tagged {
  const r = mustGet<Tagged>(store, TAGGED_TABLES[type], id, type);
  if (r.status === "merged" || r.status === "archived" || r.status === "converted") throw new ActionError("CONFLICT", `${type} ${r.name} is ${r.status}; its tags can't change`);
  return r;
}

const applyTag = defineAction({
  id: "M08.A06",
  description: "Put a tag on a contact or lead. The tag must exist (create it with M08.A01).",
  risk: "write",
  input: Record_,
  output: z.object({ recordId: z.string(), name: z.string(), tags: z.array(z.string()) }),
  entities: { consumes: ["tag", "contact"] },
  typedIds: { recordId: "recordType" },
  example: () => ({ tagId: "tg_2", recordType: "contact", recordId: "ct_31" }),
  handler: ({ tagId, recordType, recordId }, { store }) => {
    const t = mustGet<Tag>(store, "tags", tagId, "tag");
    const r = record(store, recordType, recordId);
    if (r.tags.some((x) => lower(x) === lower(t.name))) throw new ActionError("CONFLICT", `${r.name} already has "${t.name}"`);
    const tags = [...r.tags, t.name];
    store.update(TAGGED_TABLES[recordType], r.id, { tags });
    return { recordId: r.id, name: r.name, tags };
  },
});

const removeTag = defineAction({
  id: "M08.A07",
  description: "Take a tag off a contact or lead. The tag stays in the tag list.",
  risk: "write",
  input: Record_,
  output: z.object({ recordId: z.string(), name: z.string(), tags: z.array(z.string()) }),
  entities: { consumes: ["tag", "contact"] },
  typedIds: { recordId: "recordType" },
  example: (f) => ({ tagId: "tg_1", recordType: "contact", recordId: f.contact({ tags: ["vip"] }).id }),
  handler: ({ tagId, recordType, recordId }, { store }) => {
    const t = mustGet<Tag>(store, "tags", tagId, "tag");
    const r = record(store, recordType, recordId);
    if (!r.tags.some((x) => lower(x) === lower(t.name))) throw new ActionError("CONFLICT", `${r.name} doesn't have "${t.name}"`);
    const tags = r.tags.filter((x) => lower(x) !== lower(t.name));
    store.update(TAGGED_TABLES[recordType], r.id, { tags });
    return { recordId: r.id, name: r.name, tags };
  },
});

const listTagged = defineAction({
  id: "M08.A08",
  description: "List the contacts and leads that have a tag. For contacts with other filters too, use M01.A03 Search contacts with tag.",
  risk: "read",
  input: z.strictObject({ tagId: TagId, recordType: z.enum(TAGGED_TYPES).optional().describe("default both"), limit: Limit }),
  output: listOf(z.object({ type: z.enum(TAGGED_TYPES), id: z.string(), name: z.string(), contactId: z.string().nullable(), leadId: z.string().nullable() })),
  entities: { consumes: ["tag"], produces: "contact" },
  example: () => ({ tagId: "tg_1" }),
  handler: ({ tagId, recordType, limit }, { store }) => {
    const t = mustGet<Tag>(store, "tags", tagId, "tag");
    const items = TAGGED_TYPES.filter((ty) => !recordType || ty === recordType).flatMap((type) =>
      taggedWith(store, type, t.name).map((r) => ({ type, id: r.id, name: r.name, contactId: type === "contact" ? r.id : null, leadId: type === "lead" ? r.id : null })),
    );
    return page(items, limit);
  },
});

const mergeTags = defineAction({
  id: "M08.A09",
  description: "Merge one tag into another: every contact and lead with the source tag gets the target tag instead, and the source tag is deleted.",
  risk: "destructive",
  input: z.strictObject({ sourceTagId: TagId.describe("the tag to merge away"), targetTagId: TagId.describe("the tag to keep") }),
  output: Tag.extend({ recordsUpdated: z.number(), deleted: Tag }),
  entities: { consumes: ["tag"] },
  example: (f) => ({ sourceTagId: f.tag({ name: "V.I.P." }).id, targetTagId: "tg_1" }),
  handler: ({ sourceTagId, targetTagId }, { store }) => {
    if (sourceTagId === targetTagId) throw new ActionError("INVALID", "Can't merge a tag into itself");
    const src = mustGet<Tag>(store, "tags", sourceTagId, "tag");
    const dst = mustGet<Tag>(store, "tags", targetTagId, "tag");
    const recordsUpdated = retag(store, src.name, dst.name);
    store.delete("tags", src.id);
    return { ...dst, recordsUpdated, deleted: src };
  },
});

const usageCounts = defineAction({
  id: "M08.A10",
  description: "Count how many contacts and leads have each tag, most used first. Shows unused tags too.",
  risk: "read",
  input: z.strictObject({ limit: Limit }),
  output: listOf(z.object({ tagId: z.string(), name: z.string(), contacts: z.number(), leads: z.number(), total: z.number() })),
  entities: { produces: "tag" },
  example: () => ({}),
  handler: ({ limit }, { store }) => {
    const items = store.all<Tag>("tags").map((t) => ({ tagId: t.id, name: t.name, ...usage(store, t.name) }));
    items.sort((x, y) => y.total - x.total || x.name.localeCompare(y.name));
    return page(items, limit);
  },
});

export default {
  actions: [createTag, listTags, renameTag, setColor, deleteTag, applyTag, removeTag, listTagged, mergeTags, usageCounts],
  resolvers: {
    tag: (store, name) => candidates(store.all<Tag>("tags"), name, (t) => t.name, (t) => t.color),
  },
} satisfies ModuleExports;
