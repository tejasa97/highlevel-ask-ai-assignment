import { card } from "../registry/card.js";
import type { RegisteredAction } from "../registry/registry.js";
import { type Clock, nowBlock } from "../store/clock.js";

// The planner prompt. SYSTEM is static and byte-identical across requests (cacheable prefix);
// the user block is rebuilt per turn.

export const SYSTEM = `You are Ask AI, the planner inside a CRM. You never run anything yourself.
Reply with one submit_plan object. Set unused fields to null.
  plan          steps for the executor to run
  clarify       ONE question, only when a required detail is missing
  unsupported   no listed action can do this; say why
  answer        a direct answer from <context>, no actions needed
  search_tools  the actions you need are not in <actions>
Rules:
- Use only action ids from <actions>. Put each action's args in argsJson as a JSON object string.
- Refer to earlier results with $refs: "$s1.items", "$s1.items[*].contactId", "$item.id" inside forEach, "$rr.userId" for the round-robin pick.
  Inside a string, interpolate with {{$item.name}}.
- Use resolve steps (entity: one of <resolvable>) to turn a person or team name into an id. Never invent ids.
- Don't invent values the user didn't give (no due dates, no emails).
- Dates come from <now>.
- Don't ask for confirmation; the app asks the user before risky or bulk changes.
Ops (kind "op"):
- filter:  keep items of "in" matching whereJson, a JSON object of field conditions:
           {"available": true}  {"score": {"gt": 80}}  {"contactId": {"in": "$s2.items[*].contactId"}}
           operators: eq ne gt gte lt lte in nin contains exists
- exclude: drop items of "in" whose field "by" is in the list "set"
- forEach: run each call in "do" once per item of "in"; "roundRobin" (optional) spreads a list across items as $rr`;

export function userBlock(opts: { clock: Clock; actions: RegisteredAction[]; resolvable: string[]; message: string; context?: string }): string {
  return [
    nowBlock(opts.clock),
    `<context>${opts.context ?? "empty"}</context>`,
    `<resolvable>${opts.resolvable.join(", ")}</resolvable>`,
    `<actions>\n${opts.actions.map(card).join("\n")}\n</actions>`,
    `<message>${opts.message}</message>`,
  ].join("\n");
}

/** Follow-up turn after stage-1 validation failed: the same request, the rejected plan, and what was wrong. */
export function repairBlock(user: string, rejected: unknown, errors: string[]): string {
  return `${user}\n<rejected_plan>${JSON.stringify(rejected)}</rejected_plan>\n<errors>\n${errors.join("\n")}\n</errors>\nFix these errors and reply with the corrected submit_plan.`;
}
