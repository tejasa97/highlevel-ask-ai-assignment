import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { candidates, contains, inDateRange } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import { LEAD_SOURCES, LEAD_STATUSES } from "../../store/seed.js";
import type { User } from "../m48-users/index.js";

export const Lead = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  source: z.enum(LEAD_SOURCES),
  status: z.enum(LEAD_STATUSES),
  score: z.number(),
  ownerId: z.string().nullable(),
  createdAt: z.string(),
});
export type Lead = z.infer<typeof Lead>;

const searchLeads = defineAction({
  id: "M03.A03",
  description:
    "Find leads (prospects, not yet customers) by when they were created, source, status, owner or score. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({
    createdFrom: z.iso.date().optional(),
    createdTo: z.iso.date().optional(),
    source: Lead.shape.source.optional().describe("where the lead came from; Facebook ads → facebook_ads"),
    status: Lead.shape.status.optional(),
    ownerId: z.string().optional(),
    unassigned: z.boolean().optional().describe("true = only leads with no owner"),
    minScore: z.number().optional(),
    query: z.string().optional().describe("part of a name or email"),
  }),
  output: z.object({ items: z.array(Lead), total: z.number() }),
  entities: { produces: "lead" },
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
        (!a.query || contains(l.name, a.query) || contains(l.email, a.query)),
    );
    return { items, total: items.length };
  },
});

const assignLeadOwner = defineAction({
  id: "M03.A05",
  description: "Make a staff user the owner of a lead. For contacts, use M01.A07 Assign contact owner.",
  risk: "write",
  input: z.strictObject({ leadId: z.string(), ownerId: z.string().describe("user id") }),
  output: Lead,
  siblings: ["M01.A07"],
  entities: { consumes: ["lead", "user"] },
  handler: ({ leadId, ownerId }, { store }) => {
    const lead = mustGet<Lead>(store, "leads", leadId, "lead");
    if (lead.status === "converted" || lead.status === "disqualified") {
      throw new ActionError("CONFLICT", `Lead ${lead.name} is ${lead.status}; owners can only change on open leads`);
    }
    const user = mustGet<User>(store, "users", ownerId, "user");
    if (user.status !== "active") throw new ActionError("CONFLICT", `${user.name} is ${user.status} and can't own records`);
    return store.update<Lead>("leads", leadId, { ownerId });
  },
});

export default {
  actions: [searchLeads, assignLeadOwner],
  resolvers: {
    lead: (store, name) => candidates(store.find<Lead>("leads", () => true), name, (l) => l.name, (l) => l.email ?? ""),
  },
} satisfies ModuleExports;
