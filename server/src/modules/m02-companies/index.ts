import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, atLeastOne, contains, Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { Company } from "./schema.js";
import "./fixtures.js";

// Business accounts. Which contacts belong to one is contacts.companyId; contacts.company keeps the name in step.

const CompanyId = z.string().describe("company id (co_…)");
const ContactId = z.string().describe("contact id (ct_…)");
const Address = z.strictObject({
  line1: z.string().min(1),
  city: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().min(1),
});

const CompanyView = Company.extend({ contactCount: z.number() });

function normDomain(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (!d || /\s/.test(d)) throw new ActionError("INVALID", `Domain "${raw}" should look like acme.example, with no scheme or path`);
  return d;
}

function domainTaken(store: Store, domain: string | null, exceptId?: string): Company | undefined {
  if (!domain) return undefined;
  return store.find<Company>("companies", (c) => c.id !== exceptId && c.status !== "merged" && c.domain === domain)[0];
}

/** Merged companies point at the survivor. Archived ones are kept for history and can't be edited. */
function live(c: Company, doing: string): void {
  if (c.status === "merged") throw new ActionError("CONFLICT", `${c.name} was merged into ${c.mergedInto}; use that company instead`, { mergedInto: c.mergedInto });
  requireState(c.name, c.status, ["active"], doing);
}

function liveContact(c: Contact, doing: string): void {
  if (c.status === "merged") throw new ActionError("CONFLICT", `${c.name} was merged into ${c.mergedInto}; use that contact instead`, { mergedInto: c.mergedInto });
  requireState(c.name, c.status, ["active"], doing);
}

function view(store: Store, c: Company): Company & { contactCount: number } {
  return { ...c, contactCount: store.find<Contact>("contacts", (x) => x.companyId === c.id).length };
}

const createCompany = defineAction({
  id: "M02.A01",
  description: "Add a business account (name, domain, industry, size). A domain can belong to only one company. To add a person, use M01.A01 Create contact.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    domain: z.string().min(1).optional().describe("website domain; a scheme or path is stripped"),
    industry: z.string().optional(),
    size: z.enum(["1-10", "11-50", "51-200", "201-1000", "1000+"]).optional(),
    phone: z.string().optional(),
    address: Address.optional(),
  }),
  output: Company,
  siblings: ["M01.A01"],
  entities: { produces: "company" },
  example: () => ({ name: "Initech", domain: "initech.example" }),
  handler: (a, { store, clock }) => {
    const domain = a.domain ? normDomain(a.domain) : null;
    const dup = domainTaken(store, domain);
    if (dup) throw new ActionError("DUPLICATE", `${dup.name} already uses the domain ${domain} (${dup.id}); link contacts to that company or merge`, { existingId: dup.id });
    const now = clock.now().toISOString();
    return store.insert("companies", "co", {
      name: a.name.trim(),
      domain,
      industry: a.industry ?? null,
      size: a.size ?? null,
      phone: a.phone ?? null,
      address: a.address ?? null,
      accountManagerId: null,
      status: "active" as const,
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getCompany = defineAction({
  id: "M02.A02",
  description: "Get one company: its profile, account manager, status and how many contacts are linked to it.",
  risk: "read",
  input: z.strictObject({ companyId: CompanyId }),
  output: CompanyView,
  entities: { consumes: ["company"] },
  example: (f) => ({ companyId: f.company().id }),
  handler: ({ companyId }, { store }) => view(store, mustGet<Company>(store, "companies", companyId, "company")),
});

const searchCompanies = defineAction({
  id: "M02.A03",
  description: "Find companies by name, domain, industry, size, account manager or status. People are a different search: use M01.A03 Search contacts. Sorted by name. The total counts every match.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("part of a name, domain or industry"),
    status: z.enum(["active", "archived", "merged"]).optional(),
    industry: z.string().optional(),
    size: z.enum(["1-10", "11-50", "51-200", "201-1000", "1000+"]).optional(),
    accountManagerId: z.string().optional(),
    limit: Limit,
  }),
  output: listOf(Company),
  siblings: ["M01.A03"],
  entities: { produces: "company" },
  example: (f) => {
    f.company({ name: "Initech Search", domain: "initech-search.example" });
    return { query: "Initech Search" };
  },
  handler: (a, { store }) => {
    const items = store.find<Company>(
      "companies",
      (c) =>
        (!a.status || c.status === a.status) &&
        (!a.industry || c.industry === a.industry) &&
        (!a.size || c.size === a.size) &&
        (!a.accountManagerId || c.accountManagerId === a.accountManagerId) &&
        (!a.query || [c.name, c.domain, c.industry].some((v) => contains(v, a.query!))),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateCompany = defineAction({
  id: "M02.A04",
  description: "Change a company's name, domain, industry, size, phone or address. Renaming also updates the company name stored on its linked contacts. To edit a person, use M01.A04.",
  risk: "write",
  input: z.strictObject({
    companyId: CompanyId,
    name: z.string().min(1).optional(),
    domain: z.string().min(1).nullable().optional().describe("null clears it"),
    industry: z.string().nullable().optional(),
    size: z.enum(["1-10", "11-50", "51-200", "201-1000", "1000+"]).nullable().optional(),
    phone: z.string().nullable().optional(),
    address: Address.nullable().optional(),
  }),
  output: Company,
  siblings: ["M01.A04"],
  entities: { consumes: ["company"] },
  example: (f) => ({ companyId: f.company().id, industry: "Software" }),
  handler: (a, { store, clock }) => {
    const co = mustGet<Company>(store, "companies", a.companyId, "company");
    live(co, "be updated");
    atLeastOne(a, ["name", "domain", "industry", "size", "phone", "address"]);
    const domain = a.domain === undefined ? co.domain : a.domain === null ? null : normDomain(a.domain);
    const dup = domainTaken(store, domain, co.id);
    if (dup) throw new ActionError("DUPLICATE", `${dup.name} already uses the domain ${domain} (${dup.id})`, { existingId: dup.id });
    const next = {
      name: a.name?.trim() ?? co.name,
      domain,
      industry: a.industry === undefined ? co.industry : a.industry,
      size: a.size === undefined ? co.size : a.size,
      phone: a.phone === undefined ? co.phone : a.phone,
      address: a.address === undefined ? co.address : a.address,
    };
    if (JSON.stringify(next) === JSON.stringify({ name: co.name, domain: co.domain, industry: co.industry, size: co.size, phone: co.phone, address: co.address })) {
      throw new ActionError("CONFLICT", `${co.name} already has those details`);
    }
    const now = clock.now().toISOString();
    if (next.name !== co.name) {
      for (const c of store.find<Contact>("contacts", (x) => x.companyId === co.id)) store.update("contacts", c.id, { company: next.name, updatedAt: now });
    }
    return store.update<Company>("companies", co.id, { ...next, updatedAt: now });
  },
});

const archiveCompany = defineAction({
  id: "M02.A05",
  description: "Archive a company so it can't be edited or take new contacts. Linked contacts keep the link. To retire a person, use M01.A05 Archive contact.",
  risk: "destructive",
  input: z.strictObject({ companyId: CompanyId }),
  output: Company,
  siblings: ["M01.A05"],
  entities: { consumes: ["company"] },
  example: (f) => ({ companyId: f.company().id }),
  handler: ({ companyId }, { store, clock }) => {
    const co = mustGet<Company>(store, "companies", companyId, "company");
    live(co, "be archived");
    return store.update<Company>("companies", co.id, { status: "archived", updatedAt: clock.now().toISOString() });
  },
});

const Linked = z.object({ company: Company, contact: z.object({ id: z.string(), name: z.string(), companyId: z.string().nullable(), company: z.string().nullable() }) });

const linkContact = defineAction({
  id: "M02.A06",
  description: "Attach an active contact to an active company. Sets both contacts.companyId and contacts.company (the company's name). Unlink first to move them.",
  risk: "write",
  input: z.strictObject({ companyId: CompanyId, contactId: ContactId }),
  output: Linked,
  entities: { consumes: ["company", "contact"] },
  example: (f) => ({ companyId: f.company().id, contactId: f.contact().id }),
  handler: ({ companyId, contactId }, { store, clock }) => {
    const co = mustGet<Company>(store, "companies", companyId, "company");
    const c = mustGet<Contact>(store, "contacts", contactId, "contact");
    live(co, "have contacts linked");
    liveContact(c, "be linked to a company");
    if (c.companyId === co.id) throw new ActionError("CONFLICT", `${c.name} is already linked to ${co.name}`);
    if (c.companyId) throw new ActionError("CONFLICT", `${c.name} is linked to ${c.companyId}; unlink them first (M02.A07)`, { companyId: c.companyId });
    const contact = store.update<Contact>("contacts", c.id, { companyId: co.id, company: co.name, updatedAt: clock.now().toISOString() });
    return { company: co, contact: { id: contact.id, name: contact.name, companyId: contact.companyId, company: contact.company } };
  },
});

const unlinkContact = defineAction({
  id: "M02.A07",
  description: "Take a contact off a company. Clears contacts.companyId and leaves contacts.company (the name) as it was. To remove the company itself, use M02.A05 Archive company.",
  risk: "write",
  input: z.strictObject({ companyId: CompanyId, contactId: ContactId }),
  output: Linked,
  entities: { consumes: ["company", "contact"] },
  example: (f) => {
    const co = f.company();
    return { companyId: co.id, contactId: f.contact({ companyId: co.id, company: co.name }).id };
  },
  handler: ({ companyId, contactId }, { store, clock }) => {
    const co = mustGet<Company>(store, "companies", companyId, "company");
    const c = mustGet<Contact>(store, "contacts", contactId, "contact");
    if (c.status === "merged") throw new ActionError("CONFLICT", `${c.name} was merged into ${c.mergedInto}; use that contact instead`, { mergedInto: c.mergedInto });
    if (c.companyId !== co.id) throw new ActionError("CONFLICT", `${c.name} isn't linked to ${co.name}; they're linked to ${c.companyId ?? "no company"}. Link them with M02.A06`);
    const contact = store.update<Contact>("contacts", c.id, { companyId: null, updatedAt: clock.now().toISOString() });
    return { company: co, contact: { id: contact.id, name: contact.name, companyId: contact.companyId, company: contact.company } };
  },
});

const assignManager = defineAction({
  id: "M02.A08",
  description: "Set the user who owns the relationship with a company. For a person's owner, use M01.A07 Assign contact owner.",
  risk: "write",
  input: z.strictObject({ companyId: CompanyId, accountManagerId: z.string().describe("user id (us_…)") }),
  output: Company,
  siblings: ["M01.A07"],
  entities: { consumes: ["company", "user"] },
  example: (f) => ({ companyId: f.company().id, accountManagerId: f.user().id }),
  handler: ({ companyId, accountManagerId }, { store, clock }) => {
    const co = mustGet<Company>(store, "companies", companyId, "company");
    live(co, "be assigned a manager");
    const u = activeUser(store, accountManagerId, "manage this account");
    if (co.accountManagerId === u.id) throw new ActionError("CONFLICT", `${u.name} already manages ${co.name}`);
    return store.update<Company>("companies", co.id, { accountManagerId: u.id, updatedAt: clock.now().toISOString() });
  },
});

const mergeCompanies = defineAction({
  id: "M02.A09",
  description: "Merge a duplicate company into the one you keep. The duplicate becomes merged, and its contacts move over (companyId and company name). To merge two people, use M01.A06.",
  risk: "destructive",
  input: z.strictObject({ companyId: CompanyId.describe("the company to keep"), duplicateId: z.string().describe("the company to merge away (co_…)") }),
  output: z.object({ company: Company, merged: Company, contactsMoved: z.number() }),
  siblings: ["M01.A06"],
  entities: { consumes: ["company", "contact"] },
  example: (f) => ({ companyId: f.company({ name: "Keep Co" }).id, duplicateId: f.company({ name: "Dup Co" }).id }),
  handler: ({ companyId, duplicateId }, { store, clock }) => {
    if (companyId === duplicateId) throw new ActionError("CONFLICT", "Pick two different companies; a company can't be merged into itself");
    const keep = mustGet<Company>(store, "companies", companyId, "company");
    const dup = mustGet<Company>(store, "companies", duplicateId, "company");
    live(keep, "be the company that's kept");
    live(dup, "be merged");
    const now = clock.now().toISOString();
    const moving = store.find<Contact>("contacts", (c) => c.companyId === dup.id);
    for (const c of moving) store.update("contacts", c.id, { companyId: keep.id, company: keep.name, updatedAt: now });
    const merged = store.update<Company>("companies", dup.id, { status: "merged", mergedInto: keep.id, updatedAt: now });
    return { company: store.get<Company>("companies", keep.id)!, merged, contactsMoved: moving.length };
  },
});

const listContacts = defineAction({
  id: "M02.A10",
  description: "List the contacts linked to a company (contacts.companyId), by name. This is not M01.A03 Search contacts, which looks people up by their own fields.",
  risk: "read",
  input: z.strictObject({ companyId: CompanyId, limit: Limit }),
  output: listOf(z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), status: z.string(), company: z.string().nullable() })),
  siblings: ["M01.A03"],
  entities: { consumes: ["company", "contact"] },
  example: (f) => {
    const co = f.company();
    f.contact({ companyId: co.id, company: co.name });
    return { companyId: co.id };
  },
  handler: ({ companyId, limit }, { store }) => {
    mustGet<Company>(store, "companies", companyId, "company");
    const items = store
      .find<Contact>("contacts", (c) => c.companyId === companyId)
      .map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, status: c.status, company: c.company }));
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, limit);
  },
});

export default {
  actions: [createCompany, getCompany, searchCompanies, updateCompany, archiveCompany, linkContact, unlinkContact, assignManager, mergeCompanies, listContacts],
} satisfies ModuleExports;
