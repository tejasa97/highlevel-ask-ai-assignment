import { namedResolver, tableResolver } from "../../registry/lookup.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { Limit, listOf, page, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Opportunity } from "../m04-opportunities/schema.js";
import { Pipeline } from "./schema.js";
import "./fixtures.js";

// Pipeline configuration. Deals (M04) reference a pipeline and a stage; a stage with a deal in it can't be removed.

const PipelineId = z.string().describe("pipeline id (pl_…)");
const StageName = z.string().min(1);
const Probability = z.number().min(0).max(100);

function title(name: string): string {
  const n = name.trim();
  if (!n) throw new ActionError("INVALID", "Give it a name");
  return n;
}

function nameTaken(store: Store, name: string, exceptId?: string): Pipeline | undefined {
  const n = name.trim().toLowerCase();
  return store.find<Pipeline>("pipelines", (p) => p.id !== exceptId && p.name.trim().toLowerCase() === n)[0];
}

function editable(store: Store, id: string, doing: string): Pipeline {
  const p = mustGet<Pipeline>(store, "pipelines", id, "pipeline");
  requireState(`Pipeline ${p.name}`, p.status, ["active"], doing);
  return p;
}

function findStage(p: Pipeline, stageId: string): Pipeline["stages"][number] {
  const s = p.stages.find((x) => x.id === stageId);
  if (!s) throw new ActionError("NOT_FOUND", `Pipeline ${p.name} has no stage ${stageId}`, { id: stageId });
  return s;
}

function stageNameTaken(p: Pipeline, name: string, exceptId?: string): boolean {
  const n = name.toLowerCase();
  return p.stages.some((s) => s.id !== exceptId && s.name.toLowerCase() === n);
}

const createPipeline = defineAction({
  id: "M05.A01",
  description: "Create a sales pipeline and its stages (a name and a win probability each). With no stages, it starts with one stage called New. To open a deal in a pipeline, use M04.A01 Create opportunity.",
  risk: "write",
  input: z.strictObject({
    name: z.string().min(1),
    stages: z.array(z.strictObject({ name: StageName, probability: Probability.optional() })).optional(),
  }),
  output: Pipeline,
  siblings: ["M04.A01"],
  entities: { produces: "pipeline" },
  example: () => ({ name: "Partner Pipeline" }),
  handler: (a, { store, clock }) => {
    const name = title(a.name);
    const dup = nameTaken(store, name);
    if (dup) throw new ActionError("DUPLICATE", `A pipeline named "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    const requested = a.stages ?? [{ name: "New", probability: 10 }];
    if (!requested.length) throw new ActionError("INVALID", "A pipeline needs at least one stage");
    const stages = requested.map((s) => ({ id: store.nextId("_stage", "st"), name: title(s.name), probability: s.probability ?? 0 }));
    const names = stages.map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new ActionError("DUPLICATE", "Stage names in one pipeline have to be different");
    return store.insert("pipelines", "pl", { name, stages, status: "active" as const, createdAt: clock.now().toISOString() });
  },
});

const getPipeline = defineAction({
  id: "M05.A02",
  description: "Get one pipeline's name, status and stages in order, each with its win probability.",
  risk: "read",
  input: z.strictObject({ pipelineId: PipelineId }),
  output: Pipeline,
  entities: { consumes: ["pipeline"] },
  example: (f) => ({ pipelineId: f.pipeline().id }),
  handler: ({ pipelineId }, { store }) => mustGet<Pipeline>(store, "pipelines", pipelineId, "pipeline"),
});

const listPipelines = defineAction({
  id: "M05.A03",
  description: "List pipelines by name, optionally only active or only archived ones. This is the configuration list, not M04.A03 Search opportunities.",
  risk: "read",
  input: z.strictObject({ status: z.enum(["active", "archived"]).optional(), limit: Limit }),
  output: listOf(Pipeline),
  entities: { produces: "pipeline" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<Pipeline>("pipelines", (p) => !a.status || p.status === a.status);
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const renamePipeline = defineAction({
  id: "M05.A04",
  description: "Rename an active pipeline. Deals keep pointing at it. To rename a stage, use M05.A07.",
  risk: "write",
  input: z.strictObject({ pipelineId: PipelineId, name: z.string().min(1) }),
  output: Pipeline,
  entities: { consumes: ["pipeline"] },
  example: (f) => ({ pipelineId: f.pipeline().id, name: "Renamed Pipeline" }),
  handler: ({ pipelineId, name }, { store }) => {
    const p = editable(store, pipelineId, "be renamed");
    const next = title(name);
    if (next.toLowerCase() === p.name.trim().toLowerCase()) throw new ActionError("CONFLICT", `Pipeline ${p.name} is already called that`);
    const dup = nameTaken(store, next, p.id);
    if (dup) throw new ActionError("DUPLICATE", `A pipeline named "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    return store.update<Pipeline>("pipelines", p.id, { name: next });
  },
});

const archivePipeline = defineAction({
  id: "M05.A05",
  description: "Archive a pipeline so its stages can't be edited. Existing deals stay where they are. To close a deal, use M04.A08 Mark won or M04.A09 Mark lost.",
  risk: "destructive",
  input: z.strictObject({ pipelineId: PipelineId }),
  output: Pipeline,
  entities: { consumes: ["pipeline"] },
  example: (f) => ({ pipelineId: f.pipeline().id }),
  handler: ({ pipelineId }, { store }) => {
    const p = editable(store, pipelineId, "be archived");
    return store.update<Pipeline>("pipelines", p.id, { status: "archived" });
  },
});

const addStage = defineAction({
  id: "M05.A06",
  description: "Add a stage at the end of an active pipeline, with a win probability (default 0). To move a deal into a stage, use M04.A05.",
  risk: "write",
  input: z.strictObject({ pipelineId: PipelineId, name: StageName, probability: Probability.optional() }),
  output: Pipeline,
  siblings: ["M04.A05"],
  entities: { consumes: ["pipeline"] },
  example: (f) => ({ pipelineId: f.pipeline().id, name: "Verbal", probability: 60 }),
  handler: (a, { store }) => {
    const p = editable(store, a.pipelineId, "have a stage added");
    const name = title(a.name);
    if (stageNameTaken(p, name)) throw new ActionError("DUPLICATE", `Pipeline ${p.name} already has a stage named ${name}`);
    const stage = { id: store.nextId("_stage", "st"), name, probability: a.probability ?? 0 };
    return store.update<Pipeline>("pipelines", p.id, { stages: [...p.stages, stage] });
  },
});

const renameStage = defineAction({
  id: "M05.A07",
  description: "Rename one stage of an active pipeline. Deals that sit in it are unchanged. This is not M04.A05 Move opportunity to stage.",
  risk: "write",
  input: z.strictObject({ pipelineId: PipelineId, stageId: z.string().describe("stage id"), name: StageName }),
  output: Pipeline,
  siblings: ["M04.A05"],
  entities: { consumes: ["pipeline"] },
  example: (f) => {
    const p = f.pipeline();
    return { pipelineId: p.id, stageId: p.stages[0]!.id, name: "Inbound" };
  },
  handler: (a, { store }) => {
    const p = editable(store, a.pipelineId, "have a stage renamed");
    const s = findStage(p, a.stageId);
    const name = title(a.name);
    if (name.toLowerCase() === s.name.toLowerCase()) throw new ActionError("CONFLICT", `Stage ${s.name} is already called that`);
    if (stageNameTaken(p, name, s.id)) throw new ActionError("DUPLICATE", `Pipeline ${p.name} already has a stage named ${name}`);
    return store.update<Pipeline>("pipelines", p.id, { stages: p.stages.map((x) => (x.id === s.id ? { ...x, name } : x)) });
  },
});

const reorderStages = defineAction({
  id: "M05.A08",
  description: "Put an active pipeline's stages into a new order. Pass every stage id once. Deals stay in the same stage.",
  risk: "write",
  input: z.strictObject({ pipelineId: PipelineId, stageIds: z.array(z.string()).min(1) }),
  output: Pipeline,
  entities: { consumes: ["pipeline"] },
  example: (f) => {
    const p = f.pipeline();
    return { pipelineId: p.id, stageIds: [...p.stages].reverse().map((s) => s.id) };
  },
  handler: (a, { store }) => {
    const p = editable(store, a.pipelineId, "have its stages reordered");
    const byId = new Map(p.stages.map((s) => [s.id, s]));
    if (a.stageIds.length !== p.stages.length || new Set(a.stageIds).size !== p.stages.length || a.stageIds.some((id) => !byId.has(id))) {
      throw new ActionError("INVALID", `stageIds must list each of this pipeline's stages once: ${p.stages.map((s) => s.id).join(", ")}`);
    }
    if (a.stageIds.every((id, i) => p.stages[i]?.id === id)) throw new ActionError("CONFLICT", `Pipeline ${p.name} is already in that order`);
    return store.update<Pipeline>("pipelines", p.id, { stages: a.stageIds.map((id) => byId.get(id)!) });
  },
});

const removeStage = defineAction({
  id: "M05.A09",
  description: "Remove a stage that no deal sits in. If any opportunity is still in it, move those deals first (M04.A05). A pipeline can't lose its last stage.",
  risk: "destructive",
  input: z.strictObject({ pipelineId: PipelineId, stageId: z.string().describe("stage id") }),
  output: Pipeline,
  siblings: ["M04.A05"],
  entities: { consumes: ["pipeline", "opportunity"] },
  example: (f) => {
    const p = f.pipeline();
    return { pipelineId: p.id, stageId: p.stages[p.stages.length - 1]!.id };
  },
  handler: (a, { store }) => {
    const p = editable(store, a.pipelineId, "have a stage removed");
    const s = findStage(p, a.stageId);
    if (p.stages.length === 1) throw new ActionError("CONFLICT", `Pipeline ${p.name} has only one stage; add another (M05.A06) before removing ${s.name}`);
    const sitting = store.find<Opportunity>("opportunities", (o) => o.pipelineId === p.id && o.stageId === s.id);
    if (sitting.length) {
      throw new ActionError("CONFLICT", `${sitting.length} deal(s) still sit in ${s.name}; move them first (M04.A05)`, { opportunityIds: sitting.map((o) => o.id) });
    }
    return store.update<Pipeline>("pipelines", p.id, { stages: p.stages.filter((x) => x.id !== s.id) });
  },
});

const setProbability = defineAction({
  id: "M05.A10",
  description: "Set the win probability (0–100) of one stage. This configures the stage; it does not move a deal (that's M04.A05).",
  risk: "write",
  input: z.strictObject({ pipelineId: PipelineId, stageId: z.string().describe("stage id"), probability: Probability }),
  output: Pipeline,
  siblings: ["M04.A05"],
  entities: { consumes: ["pipeline"] },
  example: (f) => {
    const p = f.pipeline();
    return { pipelineId: p.id, stageId: p.stages[0]!.id, probability: 20 };
  },
  handler: (a, { store }) => {
    const p = editable(store, a.pipelineId, "have a probability changed");
    const s = findStage(p, a.stageId);
    if (s.probability === a.probability) throw new ActionError("CONFLICT", `Stage ${s.name} is already ${a.probability}%`);
    return store.update<Pipeline>("pipelines", p.id, { stages: p.stages.map((x) => (x.id === s.id ? { ...x, probability: a.probability } : x)) });
  },
});

export default {
  resolvers: {
    pipeline: tableResolver("pipelines"),
    stage: namedResolver({
      records: (store) => store.all<Pipeline>("pipelines").flatMap((p) => p.stages.map((s) => ({ ...s, pipelineId: p.id, pipeline: p.name }))),
      name: (s) => s.name, detail: (s) => s.pipeline,
      qualifiers: { pipelineId: (s) => s.pipelineId, pipeline: (s) => s.pipeline },
    }),
  },
  actions: [createPipeline, getPipeline, listPipelines, renamePipeline, archivePipeline, addStage, renameStage, reorderStages, removeStage, setProbability],
} satisfies ModuleExports;
