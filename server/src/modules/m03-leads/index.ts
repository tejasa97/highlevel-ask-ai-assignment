import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, atLeastOne, candidates, contains, fullName, inDateRange, Limit, listOf, Name, page, requireState, sameEmail } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { Opportunity, type Pipeline } from "../m04-opportunities/schema.js";
import { DISQUALIFY_REASONS, LEAD_SOURCES, LEAD_STATUSES, Lead } from "./schema.js";

export { Lead } from "./schema.js";

// Prospects: people who showed interest but aren't customers yet. Qualified leads convert into a contact + opportunity.

const LeadId = z.string().describe("lead id (ld_…)");
const OPEN = ["new", "contacted", "qualified"] as const;

/** A lead that's still being worked: not disqualified or converted. */
function openLead(store: Store, id: string, doing: string): Lead {
  const l = mustGet<Lead>(store, "leads", id, "lead");
  requireState(`Lead ${l.name}`, l.status, OPEN, doing);
  return l;
}

function duplicateOf(store: Store, email: string, exceptId?: string): { kind: string; id: string; name: string } | undefined {
  const lead = store.find<Lead>("leads", (l) => l.id !== exceptId && OPEN.includes(l.status as (typeof OPEN)[number]) && sameEmail(l.email, email))[0];
  if (lead) return { kind: "lead", id: lead.id, name: lead.name };
  const contact = store.find<Contact>("contacts", (c) => c.status === "active" && sameEmail(c.email, email))[0];
  if (contact) return { kind: "contact", id: contact.id, name: contact.name };
  return undefined;
}

const touch = (clock: { now(): Date }) => ({ updatedAt: clock.now().toISOString() });

const createLead = defineAction({
  id: "M03.A01",
  description:
    "Add a new prospect (someone interested who isn't a customer yet). For an existing customer or a person you already deal with, use M01.A01 Create contact.",
  risk: "write",
  input: z.strictObject({
    firstName: Name,
    lastName: Name.optional(),
    email: z.email().optional(),
    phone: z.string().min(5).optional(),
    company: z.string().optional(),
    source: z.enum(LEAD_SOURCES).optional().describe("where they came from (default manual); Facebook ads → facebook_ads"),
    ownerId: z.string().optional().describe("user id"),
    score: z.number().int().min(0).max(100).optional(),
  }),
  output: Lead,
  siblings: ["M01.A01"],
  entities: { produces: "lead" },
  example: () => ({ firstName: "Omar", lastName: "Haddad", email: "omar@haddad.example", source: "website" }),
  handler: (a, { store, clock }) => {
    if (a.email) {
      const dup = duplicateOf(store, a.email);
      if (dup) throw new ActionError("DUPLICATE", `${a.email} already belongs to ${dup.kind} ${dup.name} (${dup.id})`, { existingId: dup.id, kind: dup.kind });
    }
    if (a.ownerId) activeUser(store, a.ownerId, "own leads");
    const now = clock.now().toISOString();
    return store.insert("leads", "ld", {
      firstName: a.firstName,
      lastName: a.lastName ?? null,
      name: fullName(a.firstName, a.lastName),
      email: a.email?.toLowerCase() ?? null,
      phone: a.phone ?? null,
      company: a.company ?? null,
      source: a.source ?? "manual",
      campaignId: null,
      status: "new" as const,
      score: a.score ?? 0,
      ownerId: a.ownerId ?? null,
      tags: [],
      qualification: { budget: null, authority: null, need: null, timeline: null },
      disqualifyReason: null,
      disqualifyNote: null,
      convertedTo: null,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getLead = defineAction({
  id: "M03.A02",
  description: "Get one lead's full details: source, status, score, owner, qualification answers, and what it converted into.",
  risk: "read",
  input: z.strictObject({ leadId: LeadId }),
  output: Lead,
  entities: { consumes: ["lead"] },
  example: () => ({ leadId: "ld_1" }),
  handler: ({ leadId }, { store }) => mustGet<Lead>(store, "leads", leadId, "lead"),
});

const searchLeads = defineAction({
  id: "M03.A03",
  description:
    "Find leads (prospects, not yet customers) by when they were created, source, status, owner or score. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({
    createdFrom: z.iso.date().optional(),
    createdTo: z.iso.date().optional(),
    source: z.enum(LEAD_SOURCES).optional().describe("where the lead came from; Facebook ads → facebook_ads"),
    status: z.enum(LEAD_STATUSES).optional(),
    ownerId: z.string().optional(),
    unassigned: z.boolean().optional().describe("true = only leads with no owner"),
    minScore: z.number().optional(),
    maxScore: z.number().optional(),
    campaignId: z.string().optional(),
    query: z.string().optional().describe("part of a name, email or company"),
    limit: Limit,
  }),
  output: listOf(Lead),
  siblings: ["M01.A03"],
  entities: { produces: "lead" },
  example: () => ({ source: "facebook_ads", unassigned: true }),
  handler: (a, { store }) => {
    const items = store.find<Lead>(
      "leads",
      (l) =>
        inDateRange(l.createdAt, a.createdFrom, a.createdTo) &&
        (!a.source || l.source === a.source) &&
        (!a.status || l.status === a.status) &&
        (!a.ownerId || l.ownerId === a.ownerId) &&
        (a.unassigned === undefined || (l.ownerId === null) === a.unassigned) &&
        (a.minScore === undefined || l.score >= a.minScore) &&
        (a.maxScore === undefined || l.score <= a.maxScore) &&
        (!a.campaignId || l.campaignId === a.campaignId) &&
        (!a.query || [l.name, l.email, l.company].some((f) => contains(f, a.query!))),
    );
    return page(items, a.limit);
  },
});

const updateLead = defineAction({
  id: "M03.A04",
  description: "Change a lead's name, email, phone or company, or mark it contacted. Owner, source, score and qualification have their own actions.",
  risk: "write",
  input: z.strictObject({
    leadId: LeadId,
    firstName: Name.optional(),
    lastName: Name.optional(),
    email: z.email().optional(),
    phone: z.string().min(5).optional(),
    company: z.string().optional(),
    status: z.literal("contacted").optional().describe("set once someone has reached out"),
  }),
  output: Lead,
  entities: { consumes: ["lead"] },
  example: () => ({ leadId: "ld_1", company: "Northwind" }),
  handler: ({ leadId, ...patch }, { store, clock }) => {
    atLeastOne(patch, ["firstName", "lastName", "email", "phone", "company", "status"]);
    const l = openLead(store, leadId, "edit it");
    if (patch.status && l.status !== "new") throw new ActionError("CONFLICT", `Lead ${l.name} is already ${l.status}`);
    if (patch.email) {
      const dup = duplicateOf(store, patch.email, l.id);
      if (dup) throw new ActionError("DUPLICATE", `${patch.email} already belongs to ${dup.kind} ${dup.name} (${dup.id})`, { existingId: dup.id, kind: dup.kind });
    }
    const firstName = patch.firstName ?? l.firstName;
    const lastName = patch.lastName ?? l.lastName;
    return store.update<Lead>("leads", l.id, {
      ...patch,
      ...(patch.email ? { email: patch.email.toLowerCase() } : {}),
      firstName,
      lastName,
      name: fullName(firstName, lastName),
      ...touch(clock),
    });
  },
});

const assignLeadOwner = defineAction({
  id: "M03.A05",
  description: "Make a staff user the owner of a lead. For contacts, use M01.A07 Assign contact owner.",
  risk: "write",
  input: z.strictObject({ leadId: LeadId, ownerId: z.string().describe("user id") }),
  output: Lead,
  siblings: ["M01.A07"],
  entities: { consumes: ["lead", "user"] },
  example: () => ({ leadId: "ld_1", ownerId: "us_4" }),
  handler: ({ leadId, ownerId }, { store, clock }) => {
    const l = openLead(store, leadId, "change its owner");
    activeUser(store, ownerId, "own leads");
    return store.update<Lead>("leads", l.id, { ownerId, ...touch(clock) });
  },
});

const setSource = defineAction({
  id: "M03.A06",
  description: "Correct where a lead came from (facebook_ads, google_ads, website, referral, event, manual), optionally with the campaign that brought them in.",
  risk: "write",
  input: z.strictObject({ leadId: LeadId, source: z.enum(LEAD_SOURCES), campaignId: z.string().optional().describe("campaign id") }),
  output: Lead,
  entities: { consumes: ["lead"] },
  example: () => ({ leadId: "ld_1", source: "referral" }),
  handler: ({ leadId, source, campaignId }, { store, clock }) => {
    const l = mustGet<Lead>(store, "leads", leadId, "lead");
    if (campaignId) mustGet(store, "campaigns", campaignId, "campaign");
    return store.update<Lead>("leads", l.id, { source, ...(campaignId ? { campaignId } : {}), ...touch(clock) });
  },
});

const recordQualification = defineAction({
  id: "M03.A07",
  description:
    "Record a lead's answers to the qualification questions (budget, authority, need, timeline). Only the given answers change. markQualified=true also marks the lead qualified, which needs all four answered.",
  risk: "write",
  input: z.strictObject({
    leadId: LeadId,
    budget: z.string().min(1).optional().describe("what they can spend"),
    authority: z.string().min(1).optional().describe("who decides"),
    need: z.string().min(1).optional().describe("the problem they want solved"),
    timeline: z.string().min(1).optional().describe("when they want to buy"),
    markQualified: z.boolean().optional(),
  }),
  output: Lead,
  entities: { consumes: ["lead"] },
  example: () => ({ leadId: "ld_1", budget: "$5k/yr", need: "CRM for 10 reps" }),
  handler: ({ leadId, markQualified, ...answers }, { store, clock }) => {
    atLeastOne({ ...answers, markQualified }, ["budget", "authority", "need", "timeline", "markQualified"]);
    const l = openLead(store, leadId, "record qualification");
    const qualification = { ...l.qualification, ...answers };
    if (markQualified) {
      const missing = (Object.keys(qualification) as (keyof typeof qualification)[]).filter((k) => !qualification[k]);
      if (missing.length) throw new ActionError("INVALID", `Can't mark ${l.name} qualified without ${missing.join(", ")}`, { missing });
    }
    return store.update<Lead>("leads", l.id, { qualification, ...(markQualified ? { status: "qualified" } : {}), ...touch(clock) });
  },
});

const updateScore = defineAction({
  id: "M03.A08",
  description: "Set a lead's score (0–100) or change it by a delta (e.g. +10 after a demo). Results are kept between 0 and 100.",
  risk: "write",
  input: z.strictObject({
    leadId: LeadId,
    score: z.number().int().min(0).max(100).optional().describe("new absolute score"),
    delta: z.number().int().min(-100).max(100).optional().describe("amount to add (negative to lower)"),
  }),
  output: Lead,
  entities: { consumes: ["lead"] },
  example: () => ({ leadId: "ld_1", delta: 10 }),
  handler: ({ leadId, score, delta }, { store, clock }) => {
    if ((score === undefined) === (delta === undefined)) throw new ActionError("INVALID", "Give exactly one of score or delta");
    const l = openLead(store, leadId, "rescore it");
    const next = Math.max(0, Math.min(100, score ?? l.score + delta!));
    return store.update<Lead>("leads", l.id, { score: next, ...touch(clock) });
  },
});

const disqualify = defineAction({
  id: "M03.A09",
  description: "Disqualify a lead that won't buy, with a reason (no_budget, no_need, bad_timing, unreachable, competitor, spam, other).",
  risk: "destructive",
  input: z.strictObject({
    leadId: LeadId,
    reason: z.enum(DISQUALIFY_REASONS),
    note: z.string().optional().describe("required when reason is other"),
  }),
  output: Lead,
  entities: { consumes: ["lead"] },
  example: (f) => ({ leadId: f.lead().id, reason: "no_budget" }),
  handler: ({ leadId, reason, note }, { store, clock }) => {
    const l = openLead(store, leadId, "disqualify it");
    if (reason === "other" && !note) throw new ActionError("INVALID", "Say why in note when reason is other");
    return store.update<Lead>("leads", l.id, { status: "disqualified", disqualifyReason: reason, disqualifyNote: note ?? null, ...touch(clock) });
  },
});

const convertLead = defineAction({
  id: "M03.A10",
  description:
    "Convert a qualified lead into a customer: links the contact with the same email or creates one, and opens an opportunity (deal) at the first stage of the pipeline. The lead needs an owner, who owns the deal.",
  risk: "write",
  input: z.strictObject({
    leadId: LeadId,
    opportunityName: z.string().min(1).optional().describe("default: '<company or name> deal'"),
    value: z.number().min(0).optional().describe("deal value in USD (default 0)"),
    pipelineId: z.string().optional().describe("default: the first active pipeline"),
    expectedCloseDate: z.iso.date().optional(),
  }),
  output: z.object({ lead: Lead, contactId: z.string(), contactCreated: z.boolean(), opportunity: Opportunity }),
  entities: { consumes: ["lead"], produces: "opportunity" },
  example: (f) => ({ leadId: f.lead({ status: "qualified", ownerId: "us_2" }).id, value: 5000 }),
  handler: (a, { store, clock }) => {
    const l = mustGet<Lead>(store, "leads", a.leadId, "lead");
    if (l.status === "converted") throw new ActionError("CONFLICT", `Lead ${l.name} was already converted (opportunity ${l.convertedTo?.opportunityId})`, { convertedTo: l.convertedTo });
    requireState(`Lead ${l.name}`, l.status, ["qualified"], "convert it");
    if (!l.ownerId) throw new ActionError("CONFLICT", `Lead ${l.name} has no owner; assign one first (M03.A05)`);
    activeUser(store, l.ownerId, "own the new deal");

    const pipeline = a.pipelineId
      ? mustGet<Pipeline>(store, "pipelines", a.pipelineId, "pipeline")
      : store.find<Pipeline>("pipelines", (p) => p.status === "active")[0];
    if (!pipeline) throw new ActionError("CONFLICT", "There's no active pipeline to put the deal in");
    if (pipeline.status !== "active" || pipeline.stages.length === 0) throw new ActionError("CONFLICT", `Pipeline ${pipeline.name} can't take new deals`);

    const now = clock.now().toISOString();
    const existing = l.email ? store.find<Contact>("contacts", (c) => c.status === "active" && sameEmail(c.email, l.email))[0] : undefined;
    const contactId =
      existing?.id ??
      store.insert("contacts", "ct", {
        firstName: l.firstName,
        lastName: l.lastName,
        name: l.name,
        email: l.email,
        phone: l.phone,
        company: l.company,
        companyId: null,
        ownerId: l.ownerId,
        tags: l.tags,
        preferences: { email: true, sms: true, call: true, dnd: false },
        relationships: [],
        status: "active" as const,
        mergedInto: null,
        createdAt: now,
        updatedAt: now,
      }).id;
    const opportunity = store.insert("opportunities", "op", {
      name: a.opportunityName ?? `${l.company ?? l.name} deal`,
      contactId,
      leadId: l.id,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[0]!.id,
      value: a.value ?? 0,
      currency: "USD" as const,
      ownerId: l.ownerId,
      status: "open" as const,
      expectedCloseDate: a.expectedCloseDate ?? null,
      lostReason: null,
      createdAt: now,
      closedAt: null,
    });
    const lead = store.update<Lead>("leads", l.id, { status: "converted", convertedTo: { contactId, opportunityId: opportunity.id }, updatedAt: now });
    return { lead, contactId, contactCreated: !existing, opportunity };
  },
});

export default {
  actions: [createLead, getLead, searchLeads, updateLead, assignLeadOwner, setSource, recordQualification, updateScore, disqualify, convertLead],
  resolvers: {
    lead: (store, name) => candidates(store.find<Lead>("leads", () => true), name, (l) => l.name, (l) => [l.email, l.status].filter(Boolean).join(", ")),
  },
} satisfies ModuleExports;
