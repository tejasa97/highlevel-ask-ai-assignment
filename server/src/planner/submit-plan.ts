import { z } from "zod";

// The planner's reply. One static wire schema for every request, so it stays cacheable.
// - Root is an object; every field is required and unused ones are null (strict-mode rules).
// - Action args differ per action, so they travel as a JSON string (`argsJson`) and are
//   checked against the action's own Zod schema after the reply.
// - No recursion and no $defs: forEach.do is a flat list of action calls.

const nullable = (t: string) => ({ type: [t, "null"] });
const strings = { type: ["array", "null"], items: { type: "string" } };

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
      required: ["id", "kind", "entity", "name"],
      properties: {
        id: { type: "string" },
        kind: { enum: ["resolve"] },
        entity: { type: "string", description: "contact | lead | user | team | ..." },
        name: { type: "string" },
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
        in: { type: "string", description: "$ref to a list" },
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
  required: ["type", "steps", "question", "options", "reason", "alternatives", "query", "text"],
  properties: {
    type: { enum: ["plan", "look", "clarify", "unsupported", "answer", "search_tools"] },
    steps: { type: ["array", "null"], items: step },
    question: nullable("string"),
    options: strings,
    reason: nullable("string"),
    alternatives: strings,
    query: nullable("string"),
    text: nullable("string"),
  },
} as const;

// Canonical type: what the rest of the app sees after parsing.
const ActionCall = z.object({ action: z.string(), argsJson: z.string() });
const Step = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("action"), ...ActionCall.shape }),
  z.object({ id: z.string(), kind: z.literal("resolve"), entity: z.string(), name: z.string() }),
  z.object({
    id: z.string(),
    kind: z.literal("op"),
    op: z.enum(["filter", "exclude", "forEach"]),
    in: z.string(),
    whereJson: z.string().nullable(),
    by: z.string().nullable(),
    set: z.string().nullable(),
    roundRobin: z.string().nullable(),
    do: z.array(ActionCall).nullable(),
  }),
]);

export const SubmitPlan = z.object({
  type: z.enum(["plan", "look", "clarify", "unsupported", "answer", "search_tools"]),
  steps: z.array(Step).nullable(),
  question: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  reason: z.string().nullable(),
  alternatives: z.array(z.string()).nullable(),
  query: z.string().nullable(),
  text: z.string().nullable(),
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
