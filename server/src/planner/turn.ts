import { compile, type CompiledPlan } from "../core/compile.js";
import { card } from "../registry/card.js";
import type { RegisteredAction, Registry } from "../registry/registry.js";
import type { Retrieval, Retriever } from "../retrieval/retrieve.js";
import type { Clock } from "../store/clock.js";
import { repairBlock, SYSTEM, userBlock } from "./prompt.js";
import { SUBMIT_PLAN_SCHEMA, SubmitPlan } from "./submit-plan.js";
import type { PlanResult, Planner, Tier } from "./types.js";

// The planning half of a turn, shared by the dev server and the CLI:
//   retrieve a shortlist → prompt → plan, with at most one search_tools round (a second retrieval for what the
//   planner says is missing) and at most one repair round (compile errors fed back), in either order
//   → a compiled plan or a reply. At most three planner calls. The plan may only use actions the planner was shown.

export interface TurnDeps {
  registry: Registry;
  retriever: Retriever;
  planner: Planner;
  clock: Clock;
}

export interface TurnInput {
  message: string;
  tier: Tier;
  /** Recent conversation, for the <context> block. */
  context?: string;
  /** The previous turn's actions and the record types they returned, so a follow-up keeps its tools. */
  carry?: Carry;
  /** Set when the last reply was a question: the message it asked about, so retrieval sees both. */
  answering?: string;
}

export interface Carry {
  prev: string[];
  entities: string[];
}

export type TurnEvent =
  | { type: "retrieval"; data: RetrievalTrace }
  | { type: "planner.request"; data: { label: string; tier: Tier; system: string; user: string; actions: string[] } }
  | { type: "planner.reply"; data: { label: string; model: string; latencyMs: number; usage: PlanResult["usage"]; json: unknown } }
  | { type: "compile.errors"; data: { errors: string[] } };

export type TurnOutcome =
  | { kind: "plan"; plan: CompiledPlan; carry: Carry }
  | { kind: "reply"; status: "clarify" | "unsupported" | "answer" | "failed"; text: string; options?: string[] };

export interface RetrievalTrace {
  label: string;
  query: string;
  clauses: string[];
  terms: string[];
  noMatch: boolean;
  topScore: number;
  ms: number;
  picks: (Retrieval["picks"][number] & { name: string; module: string; available: boolean })[];
  /** Characters of action cards in the prompt: what was sent vs. every implemented action. */
  promptChars: { sent: number; allImplemented: number };
}

export async function planTurn(input: TurnInput, deps: TurnDeps, emit: (e: TurnEvent) => void = () => {}): Promise<TurnOutcome> {
  const { registry, retriever, planner, clock } = deps;
  const resolvable = registry.resolverEntities();
  const allChars = registry.list().map(card).join("\n").length;

  const offered: RegisteredAction[] = [];
  const notAvailable: string[] = [];
  const seen = new Set<string>();
  const shortlist = (label: string, message: string, context?: Carry) => {
    const r = retriever.retrieve({ message, context, resolvable, exclude: [...seen] });
    for (const p of r.picks) {
      seen.add(p.id);
      const impl = registry.get(p.id);
      if (impl) offered.push(impl);
      else if (p.why === "bm25") notAvailable.push(`${p.id} ${retriever.card(p.id)!.name}`);
    }
    emit({
      type: "retrieval",
      data: {
        label,
        query: r.query,
        clauses: r.clauses,
        terms: r.terms,
        noMatch: r.noMatch,
        topScore: r.topScore,
        ms: r.ms,
        picks: r.picks.map((p) => {
          const c = retriever.card(p.id)!;
          return { ...p, name: c.name, module: c.module, available: c.available };
        }),
        promptChars: { sent: offered.map(card).join("\n").length, allImplemented: allChars },
      },
    });
  };
  const prompt = () => userBlock({ clock, actions: offered, notAvailable, resolvable, message: input.message, context: input.context });
  const call = async (user: string, label: string) => {
    emit({ type: "planner.request", data: { label, tier: input.tier, system: SYSTEM, user, actions: offered.map((a) => a.id) } });
    const r = await planner.plan({ tier: input.tier, system: SYSTEM, user, schema: SUBMIT_PLAN_SCHEMA });
    emit({ type: "planner.reply", data: { label, model: r.model, latencyMs: Math.round(r.latencyMs), usage: r.usage, json: r.json } });
    return r;
  };

  shortlist("retrieve", input.answering ? `${input.answering}\n${input.message}` : input.message, input.carry);
  let user = prompt();
  let reply = await call(user, "plan");
  let searched = false;
  let repaired = false;
  // Each reply is one of: search_tools (retrieve once more, re-plan), a plan (compile; repair once if invalid),
  // or a reply for the user. The repair prompt may itself say "reply search_tools" or "reply unsupported".
  for (;;) {
    const parsed = SubmitPlan.safeParse(reply.json);
    if (!parsed.success) return failed(`The planner's reply didn't match submit_plan: ${parsed.error.message}`);
    const d = parsed.data;

    if (d.type === "search_tools") {
      if (searched) return { kind: "reply", status: "unsupported", text: `I couldn't find an action for that${d.query ? ` (${d.query})` : ""}.` };
      searched = true;
      // Retrieve again on the planner's own description of what's missing; the new cards join the old ones.
      shortlist("search_tools", d.query || input.message);
      user = prompt();
      reply = await call(user, "plan after search_tools");
      continue;
    }

    if (d.type !== "plan") {
      const text = [d.question ?? d.reason ?? d.text ?? "", d.alternatives?.length ? `Alternatives: ${d.alternatives.join("; ")}` : ""].filter(Boolean).join("\n");
      return { kind: "reply", status: d.type, text, options: d.options ?? undefined };
    }

    const compiled = compile(d, registry, new Set(offered.map((a) => a.id)));
    if (compiled.ok) return { kind: "plan", plan: compiled.plan, carry: carryOf(compiled.plan, registry) };
    emit({ type: "compile.errors", data: { errors: compiled.errors } });
    if (repaired) return failed(`The plan was still invalid after one repair:\n${compiled.errors.join("\n")}`);
    repaired = true;
    reply = await call(repairBlock(user, reply.json, compiled.errors), "repair");
  }
}

/** What a follow-up turn inherits: the actions this plan used and the record types they return. */
export function carryOf(plan: CompiledPlan, registry: Registry): Carry {
  const prev = [
    ...new Set(plan.steps.flatMap((s) => (s.kind === "action" ? [s.call.action.id] : s.kind === "forEach" ? s.calls.map((c) => c.action.id) : []))),
  ];
  const entities = [...new Set(prev.map((id) => registry.get(id)?.entities?.produces).filter((e): e is string => !!e))];
  return { prev, entities };
}

const failed = (text: string): TurnOutcome => ({ kind: "reply", status: "failed", text });
