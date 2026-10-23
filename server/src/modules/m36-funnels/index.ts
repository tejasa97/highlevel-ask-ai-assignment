import { tableResolver } from "../../registry/lookup.js";
import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, Limit, listOf, noChange, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { LandingPage } from "../m37-landing-pages/schema.js";
import { Funnel, type FunnelStep } from "./schema.js";

export { Funnel } from "./schema.js";

// A funnel is an ordered set of steps. A step may show a landing page, and that page has to be published before the link or the publish.

const FunnelId = z.string().describe("funnel id (fn_…)");
const Text = z.string().trim().min(1);
const GoalType = z.enum(["form_submit", "purchase", "booking"]);

function load(store: Store, id: string): Funnel {
  return mustGet<Funnel>(store, "funnels", id, "funnel");
}

function nameTaken(store: Store, name: string): boolean {
  const key = name.trim().toLowerCase();
  return store.find<Funnel>("funnels", (f) => f.name.trim().toLowerCase() === key).length > 0;
}

function stepOf(funnel: Funnel, stepId: string): FunnelStep {
  const step = funnel.steps.find((s) => s.id === stepId);
  if (!step) throw new ActionError("CONFLICT", `Step ${stepId} is not on this funnel; add it with M36.A04 first`);
  return step;
}

function publishedPage(store: Store, landingPageId: string): LandingPage {
  const page = mustGet<LandingPage>(store, "landing_pages", landingPageId, "landing page");
  if (page.status !== "published") {
    throw new ActionError("CONFLICT", `Landing page "${page.title}" is ${page.status}; publish it before linking (M37.A09)`);
  }
  return page;
}

function rate(visits: number, advanced: number): number {
  if (visits === 0) return 0;
  return Math.round((advanced / visits) * 10000) / 10000;
}

const createFunnel = defineAction({
  id: "M36.A01",
  description:
    "Create a draft funnel with a unique name and no steps yet. Add steps with M36.A04, link a published landing page with M36.A07, then publish with M36.A09.",
  risk: "write",
  input: z.strictObject({ name: Text }),
  output: Funnel,
  entities: { produces: "funnel" },
  example: () => ({ name: "Spring launch" }),
  handler: ({ name }, { store, clock }) => {
    const next = name.trim();
    if (nameTaken(store, next)) throw new ActionError("DUPLICATE", `A funnel named "${next}" already exists`);
    const at = clock.now().toISOString();
    return store.insert("funnels", "fn", {
      name: next,
      steps: [],
      goal: null,
      status: "draft" as const,
      createdAt: at,
      updatedAt: at,
      publishedAt: null,
    });
  },
});

const getFunnel = defineAction({
  id: "M36.A02",
  description:
    "Get one funnel's steps, the landing page on each step, the conversion goal and the status. Visit and conversion numbers are M36.A10, not this.",
  risk: "read",
  input: z.strictObject({ funnelId: FunnelId }),
  output: Funnel,
  entities: { consumes: ["funnel"] },
  example: (f) => ({ funnelId: f.funnel().id }),
  handler: ({ funnelId }, { store }) => load(store, funnelId),
});

const listFunnels = defineAction({
  id: "M36.A03",
  description:
    "List funnels by status or by words in the name, sorted by name then id. To read one funnel's steps, use M36.A02 Get funnel definition.",
  risk: "read",
  input: z.strictObject({ status: z.enum(["draft", "published"]).optional(), query: z.string().optional(), limit: Limit }),
  output: listOf(Funnel),
  entities: { produces: "funnel" },
  example: () => ({}),
  handler: (a, { store }) => {
    const query = a.query?.trim();
    const items = store.find<Funnel>("funnels", (f) => (!a.status || f.status === a.status) && (!query || contains(f.name, query)));
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const addStep = defineAction({
  id: "M36.A04",
  description:
    "Append a step to a funnel. Visit counts start at zero and are reported by M36.A10. A landing page linked here must already be published; M36.A07 can link one later.",
  risk: "write",
  input: z.strictObject({
    funnelId: FunnelId,
    name: Text,
    landingPageId: z.string().optional().describe("published landing page id (lp_…)"),
  }),
  output: Funnel,
  entities: { consumes: ["funnel"] },
  example: (f) => ({ funnelId: f.funnel().id, name: "Offer" }),
  handler: (a, { store, clock }) => {
    const funnel = load(store, a.funnelId);
    if (a.landingPageId) publishedPage(store, a.landingPageId);
    const step: FunnelStep = {
      id: store.nextId("_nested", "st"),
      name: a.name.trim(),
      landingPageId: a.landingPageId ?? null,
      visits: 0,
      advanced: 0,
    };
    return store.update<Funnel>("funnels", funnel.id, { steps: [...funnel.steps, step], updatedAt: clock.now().toISOString() });
  },
});

const reorderSteps = defineAction({
  id: "M36.A05",
  description:
    "Put a funnel's steps in a new journey order. Pass every step id exactly once. This does not add or remove steps; those are M36.A04 and M36.A06.",
  risk: "write",
  input: z.strictObject({ funnelId: FunnelId, stepIds: z.array(z.string()).describe("every step id, in the new order") }),
  output: Funnel,
  entities: { consumes: ["funnel"] },
  example: (f) => {
    const first = `st_${f.seq()}`;
    const second = `st_${f.seq()}`;
    const funnel = f.funnel({
      steps: [
        { id: first, name: "Start", landingPageId: null, visits: 0, advanced: 0 },
        { id: second, name: "Finish", landingPageId: null, visits: 0, advanced: 0 },
      ],
    });
    return { funnelId: funnel.id, stepIds: [second, first] };
  },
  handler: ({ funnelId, stepIds }, { store, clock }) => {
    const funnel = load(store, funnelId);
    if (stepIds.length !== funnel.steps.length || new Set(stepIds).size !== stepIds.length) {
      throw new ActionError("INVALID", "Give every step id exactly once");
    }
    const byId = new Map(funnel.steps.map((s) => [s.id, s]));
    const steps: FunnelStep[] = [];
    for (const id of stepIds) {
      const step = byId.get(id);
      if (!step) throw new ActionError("INVALID", `Step ${id} is not on this funnel`);
      steps.push(step);
    }
    if (steps.every((s, i) => s.id === funnel.steps[i]?.id)) noChange();
    return store.update<Funnel>("funnels", funnel.id, { steps, updatedAt: clock.now().toISOString() });
  },
});

const removeStep = defineAction({
  id: "M36.A06",
  description:
    "Remove one step from a funnel. A published funnel must keep at least one step. If the step is the conversion goal, set a different goal with M36.A08 first.",
  risk: "destructive",
  input: z.strictObject({ funnelId: FunnelId, stepId: z.string().describe("step id on this funnel") }),
  output: Funnel,
  entities: { consumes: ["funnel"] },
  example: (f) => {
    const drop = `st_${f.seq()}`;
    const keep = `st_${f.seq()}`;
    const funnel = f.funnel({
      steps: [
        { id: drop, name: "Start", landingPageId: null, visits: 0, advanced: 0 },
        { id: keep, name: "Finish", landingPageId: null, visits: 0, advanced: 0 },
      ],
    });
    return { funnelId: funnel.id, stepId: drop };
  },
  handler: ({ funnelId, stepId }, { store, clock }) => {
    const funnel = load(store, funnelId);
    const step = stepOf(funnel, stepId);
    if (funnel.goal?.stepId === step.id) {
      throw new ActionError("CONFLICT", `Step "${step.name}" is the conversion goal; set a different goal with M36.A08 first`);
    }
    if (funnel.status === "published" && funnel.steps.length === 1) {
      throw new ActionError("CONFLICT", "A published funnel needs at least one step");
    }
    return store.update<Funnel>("funnels", funnel.id, {
      steps: funnel.steps.filter((s) => s.id !== step.id),
      updatedAt: clock.now().toISOString(),
    });
  },
});

const linkPage = defineAction({
  id: "M36.A07",
  description:
    "Point a funnel step at a landing page. The page must exist and already be published; an unpublished page is refused here, not only when the funnel is published (M36.A09 / M37.A09).",
  risk: "write",
  input: z.strictObject({
    funnelId: FunnelId,
    stepId: z.string().describe("step id on this funnel"),
    landingPageId: z.string().describe("published landing page id (lp_…)"),
  }),
  output: Funnel,
  siblings: ["M37.A09"],
  entities: { consumes: ["funnel", "landing_page"] },
  example: (f) => {
    const stepId = `st_${f.seq()}`;
    const funnel = f.funnel({ steps: [{ id: stepId, name: "Offer", landingPageId: null, visits: 0, advanced: 0 }] });
    const page = f.landingPage({ status: "published", publishedAt: f.now() });
    return { funnelId: funnel.id, stepId, landingPageId: page.id };
  },
  handler: ({ funnelId, stepId, landingPageId }, { store, clock }) => {
    const funnel = load(store, funnelId);
    const step = stepOf(funnel, stepId);
    const page = publishedPage(store, landingPageId);
    if (step.landingPageId === page.id) noChange();
    const steps = funnel.steps.map((s) => (s.id === step.id ? { ...s, landingPageId: page.id } : s));
    return store.update<Funnel>("funnels", funnel.id, { steps, updatedAt: clock.now().toISOString() });
  },
});

const setGoal = defineAction({
  id: "M36.A08",
  description:
    "Set the funnel's conversion goal to one of its steps and a type (form submit, purchase or booking). The step must already be on the funnel. This does not publish the funnel (M36.A09).",
  risk: "write",
  input: z.strictObject({ funnelId: FunnelId, type: GoalType, stepId: z.string().describe("step id that counts as the conversion") }),
  output: Funnel,
  entities: { consumes: ["funnel"] },
  example: (f) => {
    const stepId = `st_${f.seq()}`;
    const funnel = f.funnel({ steps: [{ id: stepId, name: "Checkout", landingPageId: null, visits: 0, advanced: 0 }] });
    return { funnelId: funnel.id, type: "purchase", stepId };
  },
  handler: ({ funnelId, type, stepId }, { store, clock }) => {
    const funnel = load(store, funnelId);
    const step = stepOf(funnel, stepId);
    if (funnel.goal?.type === type && funnel.goal.stepId === step.id) noChange();
    return store.update<Funnel>("funnels", funnel.id, { goal: { type, stepId: step.id }, updatedAt: clock.now().toISOString() });
  },
});

const publishFunnel = defineAction({
  id: "M36.A09",
  description:
    "Publish a draft funnel. It needs at least one step, and every step that has a landing page must point at a published page (M37.A09). A failing step is named in the error.",
  risk: "external",
  input: z.strictObject({ funnelId: FunnelId }),
  output: Funnel,
  siblings: ["M37.A09"],
  entities: { consumes: ["funnel", "landing_page"] },
  example: (f) => {
    const stepId = `st_${f.seq()}`;
    const funnel = f.funnel({ steps: [{ id: stepId, name: "Start", landingPageId: null, visits: 0, advanced: 0 }] });
    return { funnelId: funnel.id };
  },
  handler: ({ funnelId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "messaging.send"); // public-facing, like M35.A09; see WAVE1-ASSUMPTIONS.md
    const funnel = load(store, funnelId);
    requireState(`Funnel "${funnel.name}"`, funnel.status, ["draft"], "be published");
    if (funnel.steps.length === 0) throw new ActionError("CONFLICT", "Add at least one step before publishing this funnel");
    const problems: string[] = [];
    for (const step of funnel.steps) {
      if (!step.landingPageId) continue;
      const page = store.get<LandingPage>("landing_pages", step.landingPageId);
      if (!page) problems.push(`Step "${step.name}" points at missing landing page ${step.landingPageId}`);
      else if (page.status !== "published") problems.push(`Step "${step.name}" links to unpublished landing page "${page.title}"`);
    }
    if (problems.length > 0) throw new ActionError("CONFLICT", `${problems.join("; ")}. Publish the landing page first`);
    const at = clock.now().toISOString();
    return store.update<Funnel>("funnels", funnel.id, { status: "published", publishedAt: at, updatedAt: at });
  },
});

const Metrics = z.object({
  funnelId: z.string(),
  name: z.string(),
  status: z.enum(["draft", "published"]),
  steps: z.array(z.object({ id: z.string(), name: z.string(), visits: z.number(), advanced: z.number(), rate: z.number() })),
  conversionRate: z.number().describe("last step's advanced divided by the first step's visits"),
  goal: Funnel.shape.goal,
});

const metrics = defineAction({
  id: "M36.A10",
  description:
    "Read each step's visits, how many advanced, and that rate, plus overall conversion from the first step's visits to the last step's advanced. Sorted in journey order. This does not change the funnel.",
  risk: "read",
  input: z.strictObject({ funnelId: FunnelId }),
  output: Metrics,
  entities: { consumes: ["funnel"] },
  example: (f) => {
    const stepId = `st_${f.seq()}`;
    const funnel = f.funnel({ steps: [{ id: stepId, name: "Start", landingPageId: null, visits: 10, advanced: 4 }] });
    return { funnelId: funnel.id };
  },
  handler: ({ funnelId }, { store }) => {
    const funnel = load(store, funnelId);
    const first = funnel.steps[0];
    const last = funnel.steps[funnel.steps.length - 1];
    return {
      funnelId: funnel.id,
      name: funnel.name,
      status: funnel.status,
      steps: funnel.steps.map((s) => ({ id: s.id, name: s.name, visits: s.visits, advanced: s.advanced, rate: rate(s.visits, s.advanced) })),
      conversionRate: first && last ? rate(first.visits, last.advanced) : 0,
      goal: funnel.goal,
    };
  },
});

export default {
  resolvers: {
    funnel: tableResolver("funnels"),
  },
  actions: [createFunnel, getFunnel, listFunnels, addStep, reorderSteps, removeStep, linkPage, setGoal, publishFunnel, metrics],
} satisfies ModuleExports;
