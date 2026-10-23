import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, atLeastOne, candidates, contains, fullName, inDateRange, Limit, listOf, Name, page, requireState, sameEmail } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Lead } from "../m03-leads/schema.js";
import type { Opportunity } from "../m04-opportunities/schema.js";
import type { Task } from "../m06-tasks/schema.js";
import { Contact, INVERSE, Preferences, RELATIONSHIPS } from "./schema.js";

export { Contact } from "./schema.js";

// People the account does business with. Prospects not yet qualified live in M03 Leads.

const ContactId = z.string().describe("contact id (ct_…)");

/** An active contact; archived and merged ones are read-only. */
function editable(store: Store, id: string, doing: string): Contact {
  const c = mustGet<Contact>(store, "contacts", id, "contact");
  if (c.status === "merged") throw new ActionError("CONFLICT", `${c.name} was merged into ${c.mergedInto}; use that contact instead`, { mergedInto: c.mergedInto });
  requireState(c.name, c.status, ["active"], doing);
  return c;
}

function emailOwner(store: Store, email: string, exceptId?: string): Contact | undefined {
  return store.find<Contact>("contacts", (c) => c.id !== exceptId && c.status !== "merged" && sameEmail(c.email, email))[0];
}

const createContact = defineAction({
  id: "M01.A01",
  description: "Add a person to contacts (an existing customer or person you deal with). For a new prospect, use M03.A01 Create lead.",
  risk: "write",
  input: z.strictObject({
    firstName: Name,
    lastName: Name.optional(),
    email: z.email().optional(),
    phone: z.string().min(5).optional(),
    company: z.string().optional(),
    ownerId: z.string().optional().describe("user id"),
    tags: z.array(z.string().min(1)).optional(),
  }),
  output: Contact,
  siblings: ["M03.A01"],
  entities: { produces: "contact" },
  example: () => ({ firstName: "Grace", lastName: "Hopper", email: "grace@navy.example" }),
  handler: (a, { store, clock }) => {
    if (a.email) {
      const dup = emailOwner(store, a.email);
      if (dup) throw new ActionError("DUPLICATE", `A contact with ${a.email} already exists: ${dup.name} (${dup.id}, ${dup.status})`, { existingId: dup.id });
    }
    if (a.ownerId) activeUser(store, a.ownerId, "own contacts");
    const now = clock.now().toISOString();
    return store.insert("contacts", "ct", {
      firstName: a.firstName,
      lastName: a.lastName ?? null,
      name: fullName(a.firstName, a.lastName),
      email: a.email?.toLowerCase() ?? null,
      phone: a.phone ?? null,
      company: a.company ?? null,
      companyId: null,
      ownerId: a.ownerId ?? null,
      tags: [...new Set(a.tags ?? [])],
      preferences: { email: true, sms: true, call: true, dnd: false },
      relationships: [],
      status: "active" as const,
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getContact = defineAction({
  id: "M01.A02",
  description: "Get one contact's full profile: details, owner, tags, communication preferences and relationships.",
  risk: "read",
  input: z.strictObject({ contactId: ContactId }),
  output: Contact,
  entities: { consumes: ["contact"] },
  example: () => ({ contactId: "ct_1" }),
  handler: ({ contactId }, { store }) => mustGet<Contact>(store, "contacts", contactId, "contact"),
});

const searchContacts = defineAction({
  id: "M01.A03",
  description:
    "Find contacts by name, email, phone, company, owner, tag or creation date. Leads are separate: use M03.A03 Search leads for prospects. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("part of a name, email, phone or company"),
    ownerId: z.string().optional(),
    unowned: z.boolean().optional().describe("true = only contacts with no owner"),
    tag: z.string().optional(),
    status: z.enum(["active", "archived"]).optional().describe("default active"),
    createdFrom: z.iso.date().optional(),
    createdTo: z.iso.date().optional(),
    limit: Limit,
  }),
  output: listOf(Contact),
  siblings: ["M03.A03"],
  entities: { produces: "contact" },
  example: () => ({ query: "sarah" }),
  handler: (a, { store }) => {
    const items = store.find<Contact>(
      "contacts",
      (c) =>
        c.status === (a.status ?? "active") &&
        (!a.ownerId || c.ownerId === a.ownerId) &&
        (a.unowned === undefined || (c.ownerId === null) === a.unowned) &&
        (!a.tag || c.tags.some((t) => t.toLowerCase() === a.tag!.toLowerCase())) &&
        inDateRange(c.createdAt, a.createdFrom, a.createdTo) &&
        (!a.query || [c.name, c.email, c.phone, c.company].some((f) => contains(f, a.query!))),
    );
    return page(items, a.limit);
  },
});

const updateContact = defineAction({
  id: "M01.A04",
  description: "Change a contact's name, email, phone or company. Owner, preferences and relationships have their own actions.",
  risk: "write",
  input: z.strictObject({
    contactId: ContactId,
    firstName: Name.optional(),
    lastName: Name.optional(),
    email: z.email().optional(),
    phone: z.string().min(5).optional(),
    company: z.string().optional(),
  }),
  output: Contact,
  entities: { consumes: ["contact"] },
  example: () => ({ contactId: "ct_1", company: "Acme Inc" }),
  handler: ({ contactId, ...patch }, { store, clock }) => {
    atLeastOne(patch, ["firstName", "lastName", "email", "phone", "company"]);
    const c = editable(store, contactId, "edit it");
    if (patch.email) {
      const dup = emailOwner(store, patch.email, c.id);
      if (dup) throw new ActionError("DUPLICATE", `${patch.email} already belongs to ${dup.name} (${dup.id}); merge them with M01.A06 instead`, { existingId: dup.id });
    }
    const firstName = patch.firstName ?? c.firstName;
    const lastName = patch.lastName ?? c.lastName;
    return store.update<Contact>("contacts", c.id, {
      ...patch,
      ...(patch.email ? { email: patch.email.toLowerCase() } : {}),
      // Typing a different company name in means they no longer belong to the linked company record (M02).
      ...(patch.company !== undefined && patch.company !== c.company ? { companyId: null } : {}),
      firstName,
      lastName,
      name: fullName(firstName, lastName),
      updatedAt: clock.now().toISOString(),
    });
  },
});

const archiveContact = defineAction({
  id: "M01.A05",
  description: "Archive a contact: hidden from searches and read-only, but kept with its history. Open tasks about them are left as they are.",
  risk: "destructive",
  input: z.strictObject({ contactId: ContactId }),
  output: Contact,
  entities: { consumes: ["contact"] },
  example: (f) => ({ contactId: f.contact().id }),
  handler: ({ contactId }, { store, clock }) => {
    const c = editable(store, contactId, "archive it");
    return store.update<Contact>("contacts", c.id, { status: "archived", updatedAt: clock.now().toISOString() });
  },
});

const mergeContacts = defineAction({
  id: "M01.A06",
  description:
    "Merge a duplicate contact into the one to keep. The kept contact gets the duplicate's tags, relationships and any details it was missing; tasks, deals and converted leads move over; the duplicate is marked merged.",
  risk: "destructive",
  input: z.strictObject({
    keepId: ContactId.describe("the contact that stays"),
    duplicateId: ContactId.describe("the contact that goes away"),
  }),
  output: z.object({
    contact: Contact,
    moved: z.object({ tasks: z.number(), opportunities: z.number(), leads: z.number() }),
    filled: z.array(z.string()).describe("fields copied from the duplicate because the kept contact had none"),
  }),
  entities: { consumes: ["contact"] },
  example: (f) => ({ keepId: f.contact({ phone: "+15550109999" }).id, duplicateId: f.contact({ phone: "+15550109999" }).id }),
  handler: ({ keepId, duplicateId }, { store, clock }) => {
    if (keepId === duplicateId) throw new ActionError("INVALID", "keepId and duplicateId are the same contact");
    const keep = editable(store, keepId, "merge into it");
    const dup = editable(store, duplicateId, "merge it");

    const filled: string[] = [];
    const patch: Partial<Contact> = {};
    for (const f of ["lastName", "email", "phone", "company", "ownerId"] as const) {
      if (keep[f] === null && dup[f] !== null) {
        patch[f] = dup[f];
        filled.push(f);
      }
    }
    if (patch.lastName) patch.name = fullName(keep.firstName, patch.lastName);
    if (patch.company) patch.companyId = dup.companyId; // the company record travels with its name
    patch.tags = [...new Set([...keep.tags, ...dup.tags])];
    const rels = new Map(keep.relationships.map((r) => [`${r.contactId}:${r.type}`, r]));
    for (const r of dup.relationships) if (r.contactId !== keepId) rels.set(`${r.contactId}:${r.type}`, r);
    patch.relationships = [...rels.values()];
    // Opting out on either record wins: never message someone who said no.
    patch.preferences = {
      email: keep.preferences.email && dup.preferences.email,
      sms: keep.preferences.sms && dup.preferences.sms,
      call: keep.preferences.call && dup.preferences.call,
      dnd: keep.preferences.dnd || dup.preferences.dnd,
    };
    const now = clock.now().toISOString();
    const contact = store.update<Contact>("contacts", keepId, { ...patch, updatedAt: now });

    // Re-point everything that referenced the duplicate.
    const tasks = store.find<Task>("tasks", (t) => t.relatedTo?.type === "contact" && t.relatedTo.id === duplicateId);
    for (const t of tasks) store.update("tasks", t.id, { relatedTo: { type: "contact", id: keepId } });
    const opps = store.find<Opportunity>("opportunities", (o) => o.contactId === duplicateId);
    for (const o of opps) store.update("opportunities", o.id, { contactId: keepId });
    const leads = store.find<Lead>("leads", (l) => l.convertedTo?.contactId === duplicateId);
    for (const l of leads) store.update("leads", l.id, { convertedTo: { ...l.convertedTo!, contactId: keepId } });
    for (const other of store.find<Contact>("contacts", (c) => c.relationships.some((r) => r.contactId === duplicateId))) {
      const relationships = other.relationships.map((r) => (r.contactId === duplicateId ? { ...r, contactId: keepId } : r)).filter((r) => r.contactId !== other.id);
      store.update("contacts", other.id, { relationships: dedupe(relationships) });
    }
    store.update("contacts", duplicateId, { status: "merged", mergedInto: keepId, email: null, updatedAt: now });
    return { contact: store.get<Contact>("contacts", keepId) ?? contact, moved: { tasks: tasks.length, opportunities: opps.length, leads: leads.length }, filled };
  },
});

function dedupe(rels: Contact["relationships"]): Contact["relationships"] {
  return [...new Map(rels.map((r) => [`${r.contactId}:${r.type}`, r])).values()];
}

const assignContactOwner = defineAction({
  id: "M01.A07",
  description: "Make a staff user the owner of a contact. For leads, use M03.A05 Assign lead owner.",
  risk: "write",
  input: z.strictObject({ contactId: ContactId, ownerId: z.string().describe("user id") }),
  output: Contact,
  siblings: ["M03.A05"],
  entities: { consumes: ["contact", "user"] },
  example: () => ({ contactId: "ct_1", ownerId: "us_4" }),
  handler: ({ contactId, ownerId }, { store, clock }) => {
    const c = editable(store, contactId, "change its owner");
    activeUser(store, ownerId, "own contacts");
    return store.update<Contact>("contacts", c.id, { ownerId, updatedAt: clock.now().toISOString() });
  },
});

const setPreferences = defineAction({
  id: "M01.A08",
  description:
    "Set how a contact may be reached: email, sms, call (true = allowed) and dnd (do not disturb: blocks every channel). Only the given channels change.",
  risk: "write",
  input: z.strictObject({ contactId: ContactId, ...Preferences.partial().shape }),
  output: Contact,
  entities: { consumes: ["contact"] },
  example: () => ({ contactId: "ct_1", sms: false }),
  handler: ({ contactId, ...prefs }, { store, clock }) => {
    atLeastOne(prefs, ["email", "sms", "call", "dnd"]);
    const c = editable(store, contactId, "change its preferences");
    return store.update<Contact>("contacts", c.id, { preferences: { ...c.preferences, ...prefs }, updatedAt: clock.now().toISOString() });
  },
});

const addRelationship = defineAction({
  id: "M01.A09",
  description:
    "Link two contacts, e.g. spouse, colleague, manager (contactId is relatedId's manager), referred_by. The other contact gets the matching link back.",
  risk: "write",
  input: z.strictObject({
    contactId: ContactId,
    relatedId: ContactId.describe("the other contact"),
    type: z.enum(RELATIONSHIPS).describe("what relatedId is to contactId"),
  }),
  output: Contact,
  entities: { consumes: ["contact"] },
  example: () => ({ contactId: "ct_1", relatedId: "ct_2", type: "colleague" }),
  handler: ({ contactId, relatedId, type }, { store, clock }) => {
    if (contactId === relatedId) throw new ActionError("INVALID", "A contact can't be related to itself");
    const a = editable(store, contactId, "add relationships");
    const b = editable(store, relatedId, "add relationships");
    if (a.relationships.some((r) => r.contactId === relatedId && r.type === type)) {
      throw new ActionError("CONFLICT", `${b.name} is already ${a.name}'s ${type}`);
    }
    const now = clock.now().toISOString();
    store.update("contacts", b.id, { relationships: dedupe([...b.relationships, { contactId, type: INVERSE[type] }]), updatedAt: now });
    return store.update<Contact>("contacts", a.id, { relationships: [...a.relationships, { contactId: relatedId, type }], updatedAt: now });
  },
});

const TimelineEntry = z.object({ at: z.string(), kind: z.string(), summary: z.string(), ref: z.string().nullable() });

const timeline = defineAction({
  id: "M01.A10",
  description: "Show everything that happened with a contact, newest first: changes, tasks, deals and the lead they came from. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({ contactId: ContactId, from: z.iso.date().optional(), to: z.iso.date().optional(), limit: Limit }),
  output: listOf(TimelineEntry),
  entities: { consumes: ["contact"] },
  example: () => ({ contactId: "ct_1" }),
  handler: ({ contactId, from, to, limit }, { store }) => {
    const c = mustGet<Contact>(store, "contacts", contactId, "contact");
    const items: z.input<typeof TimelineEntry>[] = [{ at: c.createdAt, kind: "created", summary: `Contact ${c.name} created`, ref: c.id }];
    for (const e of store.audit({ ref: contactId })) items.push({ at: e.at, kind: e.action, summary: e.summary, ref: null });
    for (const t of store.find<Task>("tasks", (t) => t.relatedTo?.id === contactId)) {
      items.push({ at: t.createdAt, kind: "task", summary: `Task "${t.title}" (${t.status})`, ref: t.id });
    }
    for (const o of store.find<Opportunity>("opportunities", (o) => o.contactId === contactId)) {
      items.push({ at: o.createdAt, kind: "opportunity", summary: `Deal "${o.name}" $${o.value} (${o.status})`, ref: o.id });
    }
    for (const l of store.find<Lead>("leads", (l) => l.convertedTo?.contactId === contactId)) {
      items.push({ at: l.createdAt, kind: "lead", summary: `Came in as lead ${l.name} from ${l.source}`, ref: l.id });
    }
    const seen = new Set<string>();
    const out = items
      .filter((i) => inDateRange(i.at, from, to))
      .filter((i) => {
        const k = `${i.at}|${i.summary}`;
        return seen.has(k) ? false : (seen.add(k), true);
      })
      .sort((x, y) => y.at.localeCompare(x.at));
    return page(out, limit);
  },
});

export default {
  actions: [createContact, getContact, searchContacts, updateContact, archiveContact, mergeContacts, assignContactOwner, setPreferences, addRelationship, timeline],
  resolvers: {
    contact: (store, name) =>
      candidates(store.all<Contact>("contacts"), name, (c) => c.name, (c) => [c.email, c.phone, c.company].filter(Boolean).join(", "), (c) => (c.status === "active" ? undefined : c.status)),
  },
} satisfies ModuleExports;
