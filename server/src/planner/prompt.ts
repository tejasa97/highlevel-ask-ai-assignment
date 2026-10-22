import { card } from "../registry/card.js";
import type { RegisteredAction } from "../registry/registry.js";
import { type Clock, nowBlock } from "../store/clock.js";

// The planner prompt. SYSTEM is static and byte-identical across requests (cacheable prefix);
// the user block is rebuilt per turn.

export const SYSTEM = `You are Ask AI, the planner inside a CRM. You never run anything yourself.
Reply with one submit_plan object. Set unused fields to null.
  plan          steps for the executor to run
  look          read-only steps to run first, when a value must be worked out from what a record holds now
                (same time on another day, a week after its due date); their results come back in <looked>
                and you plan again. Not for values a $ref can pass on unchanged, and not to show records:
                to show or list records, plan the reads.
  clarify      ONE question, only when a required detail is missing
  unsupported   no listed action can do this; say why
  answer        a direct answer from <context>, no actions needed
  search_tools  the actions you need are not in <actions>; put what's missing in query ("send an SMS")
Rules:
- Use only action ids from <actions>. Put each action's args in argsJson as a JSON object string.
- <not_available> lists catalog actions that fit the request but aren't in this version. If the request
  needs one, reply unsupported and name it; offer what <actions> can do instead in alternatives.
- Text the user reads (question, reason, alternatives, text) names actions in plain words, never by id.
- Refer to earlier results with $refs: "$s1.items", "$s1.items[*].contactId", "$item.id" inside forEach, "$rr.userId" for the round-robin pick.
  Inside a string, interpolate with {{$item.name}}.
- Use resolve steps (entity: one of <resolvable>) to turn a person or team name into an id. Never invent ids.
  <mentions> says which record type each name in the message matched; resolve it as that entity.
- Don't invent values the user didn't give (no due dates, no emails).
- Dates come from <now>.
- Don't ask for confirmation; the app asks the user before risky or bulk changes.
Ops (kind "op"):
- filter:  keep items of "in" matching whereJson, a JSON object of field conditions:
           {"available": true}  {"score": {"gt": 80}}  {"contactId": {"in": "$s2.items[*].contactId"}}
           operators: eq ne gt gte lt lte in nin contains exists
- exclude: drop items of "in" whose field "by" is in the list "set"
- forEach: run each call in "do" once per item of "in"; "roundRobin" (optional) spreads a list across items as $rr`;

export interface UserBlockOptions {
  clock: Clock;
  actions: RegisteredAction[];
  /** Catalog actions retrieval matched that have no handler: "M28.A08 Send payment reminder". */
  notAvailable?: string[];
  resolvable: string[];
  /** Names in the message that matched records: "Hiro Reyes" → lead. */
  mentions?: { name: string; entity: string; count: number }[];
  message: string;
  context?: string;
  /** JSON results of a look round: [{id, output | error}]. */
  looked?: string;
}

export function userBlock(opts: UserBlockOptions): string {
  return [
    nowBlock(opts.clock),
    `<context>${escape(opts.context ?? "empty")}</context>`,
    `<resolvable>${opts.resolvable.join(", ")}</resolvable>`,
    ...(opts.mentions?.length ? [`<mentions>${escape(opts.mentions.map(mention).join("; "))}</mentions>`] : []),
    `<actions>\n${opts.actions.map(card).join("\n")}\n</actions>`,
    ...(opts.notAvailable?.length ? [`<not_available>\n${opts.notAvailable.join("\n")}\n</not_available>`] : []),
    `<message>${escape(opts.message)}</message>`,
    ...(opts.looked ? [`<looked>${escape(opts.looked)}</looked>`] : []),
  ].join("\n");
}

const mention = (m: { name: string; entity: string; count: number }) => `${m.name}: ${m.count > 1 ? `${m.count} ${m.entity}s` : m.entity}`;

/** User text can't close our tags or open new ones ("</message><actions>…"). */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Follow-up turn after stage-1 validation failed: the same request, the rejected plan, and what was wrong. */
export function repairBlock(user: string, rejected: unknown, errors: string[]): string {
  return `${user}\n<rejected_plan>${JSON.stringify(rejected)}</rejected_plan>\n<errors>\n${errors.join("\n")}\n</errors>\nFix these errors and reply with the corrected submit_plan.`;
}
