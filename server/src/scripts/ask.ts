// End-to-end, one message: seed a fresh store, plan, validate (one repair round), execute, confirm, summarize.
// Run: npm run ask -- "assign last week's facebook leads to the free sales reps" [--yes] [--fast] [--debug] [--dev]
// --dev uses the dev database (data/dev.sqlite, made by `npm run db:reset`), so changes persist between runs.
// --debug also prints the retrieval shortlist and the raw planner replies.
import { createInterface } from "node:readline/promises";
import type { CompiledPlan } from "../core/compile.js";
import { execute, type RunResult } from "../core/execute.js";
import { summarize } from "../core/summarize.js";
import { makePlanner } from "../planner/index.js";
import { planTurn } from "../planner/turn.js";
import { loadRegistry } from "../registry/registry.js";
import { buildCards } from "../retrieval/cards.js";
import { Retriever } from "../retrieval/retrieve.js";
import { devStore } from "../store/dev.js";
import { world } from "../store/world.js";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const message = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ");
if (!message) {
  console.error('usage: npm run ask -- "<message>" [--yes] [--fast] [--debug] [--dev]');
  process.exit(2);
}
const debug = flags.has("--debug");

const registry = await loadRegistry();
const { store, clock } = flags.has("--dev") ? devStore() : world();
const planner = makePlanner();
const tier = flags.has("--fast") ? "fast" : "strong";
const timings: string[] = [];

const outcome = await planTurn({ message, tier }, { registry, retriever: new Retriever(buildCards(registry)), planner, clock }, (e) => {
  if (e.type === "planner.reply") timings.push(`${e.data.label} ${e.data.latencyMs} ms (${e.data.model}, in ${e.data.usage.input}, out ${e.data.usage.output})`);
  if (e.type === "compile.errors") console.log(`\nplan rejected:\n  ${e.data.errors.join("\n  ")}`);
  if (!debug) return;
  if (e.type === "planner.reply") console.log(`\n${e.data.label} reply:`, JSON.stringify(e.data.json));
  if (e.type === "retrieval") {
    const r = e.data;
    console.log(`\n${r.label}: ${r.picks.length} cards (${r.promptChars.sent} of ${r.promptChars.allImplemented} chars)${r.noMatch ? " · no match" : ""}`);
    for (const p of r.picks) console.log(`  ${p.available ? " " : "×"} ${p.id} ${p.name.padEnd(34)} ${p.why}${p.via ? ` ← ${p.via}` : ""}${p.score ? ` ${p.score}` : ""}`);
  }
});
if (outcome.kind === "reply") {
  console.log(`\n[${outcome.status}] ${outcome.text}`);
  if (outcome.options?.length) console.log(`options: ${outcome.options.join(" | ")}`);
  done(outcome.status === "failed" ? 1 : 0);
}
const plan: CompiledPlan = outcome.plan;
printPlan(plan);

const executionId = `ex_${plan.hash}_${Date.now().toString(36)}`;
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

function done(code = 0): never {
  console.log(`\n${timings.join(" · ")}`);
  process.exit(code);
}
