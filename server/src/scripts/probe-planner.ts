// Day-2 probe: does the planner reliably emit the submit_plan format?
// Sends a few requests with the registry's action cards and checks each reply
// parses, passes Zod, and has valid argsJson. Run: npm run probe:planner [-- fast|strong]
// Plans through PLANNER (default claude-cli, dev only, uses the Claude subscription).
import { makePlanner } from "../planner/index.js";
import { formatCost } from "../planner/usage.js";
import { SYSTEM, userBlock } from "../planner/prompt.js";
import { badArgs, SUBMIT_PLAN_SCHEMA, SubmitPlan } from "../planner/submit-plan.js";
import type { PlannerError, Tier } from "../planner/types.js";
import { loadRegistry } from "../registry/registry.js";
import { frozenClock } from "../store/clock.js";

const MESSAGES = [
  "put Jo Park in my contacts, jo.park@acme.io",
  "find leads from facebook created last week, give them to whoever on the Sales team is free, and make a follow-up task for each",
  "send Jo a birthday card in the mail",
  "create a task",
];

const tier = (process.argv[2] as Tier) ?? "strong";
const planner = makePlanner();
const registry = await loadRegistry();
const clock = frozenClock();

let ok = 0;
for (const message of MESSAGES) {
  const user = userBlock({ clock, actions: registry.list(), resolvable: registry.resolverEntities(), message });
  try {
    const r = await planner.plan({ tier, system: SYSTEM, user, schema: SUBMIT_PLAN_SCHEMA });
    const parsed = SubmitPlan.safeParse(r.json);
    const bad = parsed.success ? badArgs(parsed.data) : [];
    const pass = parsed.success && bad.length === 0;
    if (pass) ok++;
    console.log(`\n> ${message}`);
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${r.model}  ${Math.round(r.latencyMs)} ms  in ${r.usage.input} (cached ${r.usage.cachedRead})  out ${r.usage.output} + think ${r.usage.thinking}  ${formatCost(r.usage.costUsd, r.usage.billing)}`);
    if (!parsed.success) console.log("  zod:", parsed.error.issues.slice(0, 3));
    if (bad.length) console.log("  bad JSON in:", bad);
    console.log(JSON.stringify(compact(r.json), null, 1).replace(/^/gm, "  "));
  } catch (err) {
    const e = err as PlannerError;
    console.log(`\n> ${message}\n  ERROR ${e.kind ?? ""}: ${e.message}`);
    if (e.text) console.log("  text:", e.text.slice(0, 300));
  }
}
console.log(`\n${ok}/${MESSAGES.length} valid`);
if (ok !== MESSAGES.length) process.exitCode = 1;

// Drop nulls so the printout stays readable.
function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, compact(x)]));
  return v;
}
