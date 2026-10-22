import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, candidates, contains, Limit, listOf, notPast, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import { localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import { Opportunity, Pipeline } from "./schema.js";

export { Opportunity, Pipeline } from "./schema.js";

// Deals moving through a pipeline's stages until they're won or lost. M03 Convert lead also opens deals.

const OpportunityId = z.string().describe("opportunity id (op_…)");

function openDeal(store: Store, id: string, doing: string): Opportunity {
  const o = mustGet<Opportunity>(store, "opportunities", id, "opportunity");
  requireState(`Deal "${o.name}"`, o.status, ["open"], doing);
  return o;
}

/** A pipeline stage by id or by name (case-insensitive). */
function findStage(p: Pipeline, stage: string): Pipeline["stages"][number] {
  const s = p.stages.find((s) => s.id === stage) ?? p.stages.find((s) => s.name.toLowerCase() === stage.trim().toLowerCase());
  if (!s) throw new ActionError("NOT_FOUND", `Pipeline ${p.name} has no stage "${stage}"; its stages are ${p.stages.map((s) => s.name).join(", ")}`, { stages: p.stages });
  return s;
}

const Detail = Opportunity.extend({
  pipelineName: z.string(),
  stageName: z.string(),
  probability: z.number().describe("chance of winning at this stage, %"),
  weightedValue: z.number().describe("value × probability"),
  contactName: z.string().nullable(),
});

function detail(store: Store, o: Opportunity): z.input<typeof Detail> {
  const p = store.get<Pipeline>("pipelines", o.pipelineId);
  const s = p?.stages.find((s) => s.id === o.stageId);
  const probability = o.status === "won" ? 100 : o.status === "lost" ? 0 : (s?.probability ?? 0);
  return {
    ...o,
    pipelineName: p?.name ?? "(deleted pipeline)",
    stageName: s?.name ?? "(unknown stage)",
    probability,
    weightedValue: Math.round((o.value * probability) / 100),
    contactName: store.get<Contact>("contacts", o.contactId)?.name ?? null,
  };
}

const createOpportunity = defineAction({
  id: "M04.A01",
  description:
    "Open a new deal for a contact in a pipeline, with its value in USD. Starts at the pipeline's first stage unless a stage is given. To turn a qualified lead into a deal, use M03.A10 Convert lead.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    contactId: z.string().describe("contact id (ct_…)"),
    value: z.number().min(0).optional().describe("USD, default 0"),
    pipelineId: z.string().optional().describe("default: the first active pipeline"),
    stage: z.string().optional().describe("stage id or name; default: the first stage"),
    ownerId: z.string().optional().describe("user id"),
    expectedCloseDate: z.iso.date().optional(),
  }),
  output: Opportunity,
  siblings: ["M03.A10"],
  entities: { produces: "opportunity", consumes: ["contact"] },
  example: () => ({ name: "Brightside - Agency plan", contactId: "ct_31", value: 9600, ownerId: "us_2" }),
  handler: (a, { store, clock }) => {
    const c = mustGet<Contact>(store, "contacts", a.contactId, "contact");
    requireState(c.name, c.status, ["active"], "get new deals");
    const pipeline = a.pipelineId
      ? mustGet<Pipeline>(store, "pipelines", a.pipelineId, "pipeline")
      : store.find<Pipeline>("pipelines", (p) => p.status === "active")[0];
    if (!pipeline) throw new ActionError("CONFLICT", "There's no active pipeline to put the deal in");
    requireState(`Pipeline ${pipeline.name}`, pipeline.status, ["active"], "take new deals");
    const stage = a.stage ? findStage(pipeline, a.stage) : pipeline.stages[0];
    if (!stage) throw new ActionError("CONFLICT", `Pipeline ${pipeline.name} has no stages`);
    if (a.ownerId) activeUser(store, a.ownerId, "own deals");
    if (a.expectedCloseDate) notPast(a.expectedCloseDate, localDate(clock.now()), "Expected close date");
    const dup = store.find<Opportunity>("opportunities", (o) => o.status === "open" && o.contactId === c.id && o.name.toLowerCase() === a.name.trim().toLowerCase())[0];
    if (dup) throw new ActionError("DUPLICATE", `${c.name} already has an open deal called "${dup.name}" (${dup.id})`, { existingId: dup.id });
    return store.insert("opportunities", "op", {
      name: a.name.trim(),
      contactId: c.id,
      leadId: null,
      pipelineId: pipeline.id,
      stageId: stage.id,
      value: a.value ?? 0,
      currency: "USD" as const,
      ownerId: a.ownerId ?? null,
      status: "open" as const,
      expectedCloseDate: a.expectedCloseDate ?? null,
      lostReason: null,
      createdAt: clock.now().toISOString(),
      closedAt: null,
    });
  },
});

const getOpportunity = defineAction({
  id: "M04.A02",
  description: "Get one deal's details: contact, owner, value, pipeline stage and its win probability, expected close date and status.",
  risk: "read",
  input: z.strictObject({ opportunityId: OpportunityId }),
  output: Detail,
  entities: { consumes: ["opportunity"] },
  example: () => ({ opportunityId: "op_1" }),
  handler: ({ opportunityId }, { store }) => detail(store, mustGet<Opportunity>(store, "opportunities", opportunityId, "opportunity")),
});

const searchOpportunities = defineAction({
  id: "M04.A03",
  description:
    "Find deals by contact, owner, stage, value range, expected close date range or name. Without status, returns open deals. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({
    contactId: z.string().optional(),
    ownerId: z.string().optional(),
    unassigned: z.boolean().optional().describe("true = only deals with no owner"),
    status: z.enum(["open", "won", "lost"]).optional().describe("default open"),
    pipelineId: z.string().optional(),
    stage: z.string().optional().describe("stage id or name"),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    closeFrom: z.iso.date().optional().describe("expected close date from"),
    closeTo: z.iso.date().optional(),
    query: z.string().optional().describe("part of the deal name"),
    limit: Limit,
  }),
  output: listOf(Detail),
  entities: { produces: "opportunity" },
  example: () => ({ ownerId: "us_2", minValue: 1000 }),
  handler: (a, { store }) => {
    const stageOk = (o: Opportunity) => {
      if (!a.stage) return true;
      const s = store.get<Pipeline>("pipelines", o.pipelineId)?.stages.find((s) => s.id === o.stageId);
      return !!s && (s.id === a.stage || s.name.toLowerCase() === a.stage.trim().toLowerCase());
    };
    const items = store.find<Opportunity>(
      "opportunities",
      (o) =>
        o.status === (a.status ?? "open") &&
        (!a.contactId || o.contactId === a.contactId) &&
        (!a.ownerId || o.ownerId === a.ownerId) &&
        (a.unassigned === undefined || (o.ownerId === null) === a.unassigned) &&
        (!a.pipelineId || o.pipelineId === a.pipelineId) &&
        stageOk(o) &&
        (a.minValue === undefined || o.value >= a.minValue) &&
        (a.maxValue === undefined || o.value <= a.maxValue) &&
        (!a.closeFrom || (o.expectedCloseDate !== null && o.expectedCloseDate >= a.closeFrom)) &&
        (!a.closeTo || (o.expectedCloseDate !== null && o.expectedCloseDate <= a.closeTo)) &&
        (!a.query || contains(o.name, a.query)),
    );
    items.sort((x, y) => y.value - x.value);
    return page(items.map((o) => detail(store, o)), a.limit);
  },
});

const updateValue = defineAction({
  id: "M04.A04",
  description: "Change an open deal's value (USD).",
  risk: "write",
  input: z.strictObject({ opportunityId: OpportunityId, value: z.number().min(0) }),
  output: Opportunity,
  entities: { consumes: ["opportunity"] },
  example: () => ({ opportunityId: "op_1", value: 15000 }),
  handler: ({ opportunityId, value }, { store }) => {
    const o = openDeal(store, opportunityId, "change its value");
    if (o.value === value) throw new ActionError("CONFLICT", `Deal "${o.name}" is already worth $${value}`);
    return store.update<Opportunity>("opportunities", o.id, { value });
  },
});

const moveStage = defineAction({
  id: "M04.A05",
  description:
    "Move an open deal to another stage of its pipeline (e.g. Qualified, Proposal, Negotiation). To close it, use M04.A08 Mark won or M04.A09 Mark lost instead.",
  risk: "write",
  input: z.strictObject({ opportunityId: OpportunityId, stage: z.string().min(1).describe("stage id or name") }),
  output: Detail,
  entities: { consumes: ["opportunity"] },
  example: () => ({ opportunityId: "op_1", stage: "Negotiation" }),
  handler: ({ opportunityId, stage }, { store }) => {
    const o = openDeal(store, opportunityId, "move it");
    const p = mustGet<Pipeline>(store, "pipelines", o.pipelineId, "pipeline");
    const s = findStage(p, stage);
    if (s.id === o.stageId) throw new ActionError("CONFLICT", `Deal "${o.name}" is already in ${s.name}`);
    return detail(store, store.update<Opportunity>("opportunities", o.id, { stageId: s.id }));
  },
});

const assignOwner = defineAction({
  id: "M04.A06",
  description: "Make a staff user the owner of an open deal. For contacts use M01.A07, for leads M03.A05.",
  risk: "write",
  input: z.strictObject({ opportunityId: OpportunityId, ownerId: z.string().describe("user id") }),
  output: Opportunity,
  siblings: ["M01.A07", "M03.A05"],
  entities: { consumes: ["opportunity", "user"] },
  example: () => ({ opportunityId: "op_1", ownerId: "us_5" }),
  handler: ({ opportunityId, ownerId }, { store }) => {
    const o = openDeal(store, opportunityId, "change its owner");
    const u = activeUser(store, ownerId, "own deals");
    if (o.ownerId === ownerId) throw new ActionError("CONFLICT", `${u.name} already owns "${o.name}"`);
    return store.update<Opportunity>("opportunities", o.id, { ownerId });
  },
});

const setCloseDate = defineAction({
  id: "M04.A07",
  description: "Set when an open deal is expected to close. The date can't be in the past.",
  risk: "write",
  input: z.strictObject({ opportunityId: OpportunityId, expectedCloseDate: z.iso.date() }),
  output: Opportunity,
  entities: { consumes: ["opportunity"] },
  example: () => ({ opportunityId: "op_1", expectedCloseDate: "2026-11-30" }),
  handler: ({ opportunityId, expectedCloseDate }, { store, clock }) => {
    const o = openDeal(store, opportunityId, "change its close date");
    notPast(expectedCloseDate, localDate(clock.now()), "Expected close date");
    return store.update<Opportunity>("opportunities", o.id, { expectedCloseDate });
  },
});

const markWon = defineAction({
  id: "M04.A08",
  description: "Close an open deal as won.",
  risk: "write",
  input: z.strictObject({ opportunityId: OpportunityId, value: z.number().min(0).optional().describe("final value, if it changed") }),
  output: Opportunity,
  entities: { consumes: ["opportunity"] },
  example: () => ({ opportunityId: "op_1" }),
  handler: ({ opportunityId, value }, { store, clock }) => {
    const o = openDeal(store, opportunityId, "mark it won");
    return store.update<Opportunity>("opportunities", o.id, { status: "won", closedAt: clock.now().toISOString(), ...(value !== undefined ? { value } : {}) });
  },
});

const markLost = defineAction({
  id: "M04.A09",
  description: "Close an open deal as lost, with the reason (e.g. went with a competitor, no budget). It can be reopened later with M04.A10.",
  risk: "write",
  input: z.strictObject({ opportunityId: OpportunityId, reason: z.string().min(1) }),
  output: Opportunity,
  entities: { consumes: ["opportunity"] },
  example: () => ({ opportunityId: "op_1", reason: "Chose a competitor" }),
  handler: ({ opportunityId, reason }, { store, clock }) => {
    const o = openDeal(store, opportunityId, "mark it lost");
    return store.update<Opportunity>("opportunities", o.id, { status: "lost", lostReason: reason, closedAt: clock.now().toISOString() });
  },
});

const reopen = defineAction({
  id: "M04.A10",
  description: "Reopen a won or lost deal so it's back in the pipeline at the stage it closed in.",
  risk: "write",
  input: z.strictObject({ opportunityId: OpportunityId }),
  output: Opportunity,
  entities: { consumes: ["opportunity"] },
  example: (f) => ({ opportunityId: f.opportunity({ status: "lost", lostReason: "No budget", closedAt: f.at(-3) }).id }),
  handler: ({ opportunityId }, { store }) => {
    const o = mustGet<Opportunity>(store, "opportunities", opportunityId, "opportunity");
    requireState(`Deal "${o.name}"`, o.status, ["won", "lost"], "reopen it");
    return store.update<Opportunity>("opportunities", o.id, { status: "open", lostReason: null, closedAt: null });
  },
});

export default {
  actions: [createOpportunity, getOpportunity, searchOpportunities, updateValue, moveStage, assignOwner, setCloseDate, markWon, markLost, reopen],
  resolvers: {
    opportunity: (store, name) =>
      candidates(
        store.all<Opportunity>("opportunities"),
        name,
        (o) => o.name,
        (o) => `$${o.value}, ${store.get<Contact>("contacts", o.contactId)?.name ?? o.contactId}`,
        (o) => (o.status === "open" ? undefined : o.status),
      ),
  },
} satisfies ModuleExports;
