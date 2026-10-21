// End-to-end, one message: seed a fresh store, plan, validate (one repair round), execute, confirm, summarize.
// Run: npm run ask -- "assign last week's facebook leads to the free sales reps" [--yes] [--fast] [--debug]
// Every action in the registry is sent as a card for now; retrieval comes later.
import { createInterface } from "node:readline/promises";
import { compile, type CompiledPlan } from "../core/compile.js";
import { execute, type RunResult } from "../core/execute.js";
import { summarize } from "../core/summarize.js";
import { makePlanner } from "../planner/index.js";
import { repairBlock, SYSTEM, userBlock } from "../planner/prompt.js";
import { SUBMIT_PLAN_SCHEMA, SubmitPlan } from "../planner/submit-plan.js";
import type { PlanResult } from "../planner/types.js";
import { loadRegistry } from "../registry/registry.js";
import { frozenClock } from "../store/clock.js";
import { Store } from "../store/db.js";
import { seed } from "../store/seed.js";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const message = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ");
if (!message) {
  console.error('usage: npm run ask -- "<message>" [--yes] [--fast] [--debug]');
  process.exit(2);
}
const debug = flags.has("--debug");

const registry = await loadRegistry();
const clock = frozenClock();
const store = new Store();
seed(store, clock);
const planner = makePlanner();
const tier = flags.has("--fast") ? "fast" : "strong";
const timings: string[] = [];

const user = userBlock({ clock, actions: registry.list(), resolvable: registry.resolverEntities(), message });
let reply = await ask(user, "plan");
let parsed = SubmitPlan.safeParse(reply.json);
if (!parsed.success) fail(`reply doesn't match submit_plan: ${parsed.error.message}`);

if (parsed.data.type !== "plan") {
  const d = parsed.data;
  console.log(`\n[${d.type}] ${d.question ?? d.reason ?? d.text ?? d.query ?? ""}`);
  if (d.options?.length) console.log(`options: ${d.options.join(" | ")}`);
  if (d.alternatives?.length) console.log(`alternatives: ${d.alternatives.join(" | ")}`);
  done();
}

let compiled = compile(parsed.data, registry);
if (!compiled.ok) {
  console.log(`\nplan rejected, repairing:\n  ${compiled.errors.join("\n  ")}`);
  reply = await ask(repairBlock(user, reply.json, compiled.errors), "repair");
  parsed = SubmitPlan.safeParse(reply.json);
  if (!parsed.success || parsed.data.type !== "plan") fail("repair didn't return a plan");
  compiled = compile(parsed.data, registry);
  if (!compiled.ok) fail(`still invalid after repair:\n  ${compiled.errors.join("\n  ")}`);
}
const plan: CompiledPlan = compiled.plan;
printPlan(plan);

const executionId = `ex_${plan.hash}`;
let t = performance.now();
let run: RunResult = await execute(plan, registry, { store, clock }, { executionId, onEvent: debug ? (e) => console.log("  ·", JSON.stringify(e)) : undefined });
timings.push(`execute ${Math.round(performance.now() - t)} ms`);

while (run.status === "awaiting_confirmation") {
  console.log(`\n${summarize(plan, run, registry)}`);
  for (const p of run.pending!.preview) console.log(`  - ${p.name}${p.label ? ` [${p.label}]` : ""} ${JSON.stringify(p.args)}`);
  if (run.pending!.count * 2 > run.pending!.preview.length && run.pending!.preview.length >= 10) console.log("  …");
  if (!(await confirm())) {
    console.log("Cancelled. Nothing was changed by that step.");
    done();
  }
  t = performance.now();
  run = await execute(plan, registry, { store, clock }, { executionId, approvals: [run.pending!] });
  timings.push(`resume ${Math.round(performance.now() - t)} ms`);
}

console.log(`\n[${run.status}]\n${summarize(plan, run, registry)}`);
if (debug) console.log(JSON.stringify(run.steps, null, 1));
done();

async function ask(text: string, label: string): Promise<PlanResult> {
  const r = await planner.plan({ tier, system: SYSTEM, user: text, schema: SUBMIT_PLAN_SCHEMA });
  timings.push(`${label} ${Math.round(r.latencyMs)} ms (${r.model}, in ${r.usage.input}, out ${r.usage.output})`);
  if (debug) console.log(`\n${label} reply:`, JSON.stringify(r.json));
  return r;
}

async function confirm(): Promise<boolean> {
  if (flags.has("--yes")) {
    console.log("--yes: approved");
    return true;
  }
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question("Go ahead? [y/N] ");
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

function printPlan(p: CompiledPlan): void {
  console.log("\nplan:");
  for (const s of p.steps) {
    const body =
      s.kind === "action" ? `${s.call.action.id} ${s.call.action.name} ${JSON.stringify(s.call.args)}`
      : s.kind === "resolve" ? `resolve ${s.entity} "${s.name}"`
      : s.kind === "filter" ? `filter ${s.in} ${JSON.stringify(s.where)}`
      : s.kind === "exclude" ? `exclude ${s.in} by ${s.by} in ${s.set}`
      : `forEach ${s.in}${s.roundRobin ? ` roundRobin ${s.roundRobin}` : ""}: ${s.calls.map((c) => `${c.action.id} ${JSON.stringify(c.args)}`).join(" ; ")}`;
    console.log(`  ${s.id}  ${body}`);
  }
}

function fail(msg: string): never {
  console.error(`\n${msg}`);
  done(1);
}

function done(code = 0): never {
  console.log(`\n${timings.join(" · ")}`);
  process.exit(code);
}
