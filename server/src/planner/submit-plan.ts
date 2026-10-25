import { z } from "zod";

// The planner's reply. One static wire schema for every request, so it stays cacheable.
// - Root is an object; every field is required and unused ones are null (strict-mode rules).
// - Action args differ per action, so they travel as a JSON string (`argsJson`) and are
//   checked against the action's own Zod schema after the reply.
// - No recursion and no $defs: forEach.do is a flat list of action calls.

const nullable = (t: string) => ({ type: [t, "null"] });
const strings = { type: ["array", "null"], items: { type: "string" } };

const outcome = {
  type: "object", additionalProperties: false,
  required: ["effect", "actions", "destination"],
  properties: {
    effect: { enum: ["read", "change"] },
    actions: { type: "array", items: { type: "string" }, description: "Catalog IDs of the final requested operations, not prerequisite reads. Empty only while searching for the final action." },
    destination: { ...nullable("string"), description: "Explicit delivery surface ID from delivery_surfaces; preserve an unsupported platform's name instead of substituting a supported surface. Null when not a delivery request." },
  },
};
const lookup = {
  type: ["object", "null"], additionalProperties: false,
  required: ["entity", "name", "whereJson"],
  properties: { entity: { type: "string" }, name: { type: "string" }, whereJson: nullable("string") },
};
const missing = {
  type: ["object", "null"], additionalProperties: false,
  required: ["action", "argument", "argsJson"],
  properties: {
    action: { type: "string", description: "Offered action whose input is missing or ambiguous" },
    argument: { type: "string", description: "Concrete input path, e.g. title, teamId, answers[0].fieldId" },
    argsJson: { type: "string", description: "Known arguments as a JSON object. Preserve given names as $lookup values, including the ambiguous argument." },
  },
};

const actionCall = {
  type: "object",
  additionalProperties: false,
  required: ["action", "argsJson"],
  properties: {
    action: { type: "string", description: "Catalog id, e.g. M01.A01" },
    argsJson: { type: "string", description: "JSON object of args; values may be $refs" },
  },
};

const step = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "action", "argsJson"],
      properties: { id: { type: "string" }, kind: { enum: ["action"] }, ...actionCall.properties },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "entity", "name", "whereJson"],
      properties: {
        id: { type: "string" },
        kind: { enum: ["resolve"] },
        entity: { type: "string", description: "contact | lead | user | team | ..." },
        name: { type: "string" },
        whereJson: { ...nullable("string"), description: "Exact lookup qualifiers as a JSON object, e.g. {\"company\":\"Brightside\"}; null if none" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "op", "in", "whereJson", "by", "set", "roundRobin", "do"],
      properties: {
        id: { type: "string" },
        kind: { enum: ["op"] },
        op: { enum: ["filter", "exclude", "forEach"] },
        in: {
          description: "$ref to a list; forEach also takes a JSON array of strings",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        whereJson: nullable("string"),
        by: nullable("string"),
        set: nullable("string"),
        roundRobin: nullable("string"),
        do: { type: ["array", "null"], items: actionCall },
      },
    },
  ],
};

export const SUBMIT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "steps", "question", "options", "reason", "alternatives", "query", "text", "outcome", "clarification", "lookup", "missing"],
  properties: {
    type: { enum: ["plan", "look", "clarify", "unsupported", "answer", "search_tools"] },
    steps: { type: ["array", "null"], items: step },
    question: nullable("string"),
    options: strings,
    reason: nullable("string"),
    alternatives: strings,
    query: nullable("string"),
    text: nullable("string"),
    outcome,
    clarification: { enum: ["identity", "content", "choice", null] },
    lookup,
    missing,
  },
} as const;

// Canonical type: what the rest of the app sees after parsing.
const ActionCall = z.object({ action: z.string(), argsJson: z.string() });
const Step = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("action"), ...ActionCall.shape }),
  z.object({ id: z.string(), kind: z.literal("resolve"), entity: z.string(), name: z.string(), whereJson: z.string().nullable().optional() }),
  z.object({
    id: z.string(),
    kind: z.literal("op"),
    op: z.enum(["filter", "exclude", "forEach"]),
    in: z.union([z.string(), z.array(z.string())]),
    whereJson: z.string().nullable().default(null),
    by: z.string().nullable().default(null),
    set: z.string().nullable().default(null),
    roundRobin: z.string().nullable().default(null),
    do: z.array(ActionCall).nullable().default(null),
  }),
]);

// Root fields unused by a reply kind normalize just like unused op fields. This parser tolerance does
// not change SUBMIT_PLAN_SCHEMA: strict providers still receive every required nullable field.
export const SubmitPlan = z.object({
  type: z.enum(["plan", "look", "clarify", "unsupported", "answer", "search_tools"]),
  steps: z.array(Step).nullable().default(null),
  question: z.string().nullable().default(null),
  options: z.array(z.string()).nullable().default(null),
  reason: z.string().nullable().default(null),
  alternatives: z.array(z.string()).nullable().default(null),
  query: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  // Optional at the internal boundary for existing saved replies; every new provider call requires these on wire.
  outcome: z.object({ effect: z.enum(["read", "change"]), actions: z.array(z.string()), destination: z.string().nullable() }).nullable().optional(),
  clarification: z.enum(["identity", "content", "choice"]).nullable().optional(),
  lookup: z.object({ entity: z.string(), name: z.string(), whereJson: z.string().nullable() }).nullable().optional(),
  missing: z.object({ action: z.string(), argument: z.string(), argsJson: z.string() }).nullable().optional(),
});
export type SubmitPlan = z.infer<typeof SubmitPlan>;
export type Step = z.infer<typeof Step>;

/** Parses every argsJson/whereJson string; returns the ones that aren't JSON objects. */
export function badArgs(plan: SubmitPlan): { path: string; value: string }[] {
  const bad: { path: string; value: string }[] = [];
  const check = (path: string, s: string | null) => {
    if (s === null) return;
    try {
      const v = JSON.parse(s);
      if (typeof v !== "object" || v === null || Array.isArray(v)) bad.push({ path, value: s });
    } catch {
      bad.push({ path, value: s });
    }
  };
  for (const s of plan.steps ?? []) {
    if (s.kind === "action") check(`${s.id}.argsJson`, s.argsJson);
    if (s.kind === "op") {
      check(`${s.id}.whereJson`, s.whereJson);
      s.do?.forEach((c, i) => check(`${s.id}.do[${i}].argsJson`, c.argsJson));
    }
  }
  return bad;
}
