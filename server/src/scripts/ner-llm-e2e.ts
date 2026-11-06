// E2E probe against a running Ask server: POST each utterance to /api/ask, read the SSE stream, write one result per
// case. Usage: tsx src/scripts/ner-llm-e2e.ts out.json "label=utterance" ... (ASK_URL defaults to http://127.0.0.1:8787)
import { writeFileSync } from "node:fs";

const base = process.env.ASK_URL || "http://127.0.0.1:8787";
const [out, ...cases] = process.argv.slice(2);
if (!out || !cases.length) throw new Error('usage: ner-llm-e2e.ts out.json "label=utterance" ...');

const results: Record<string, unknown>[] = [];
for (const c of cases) {
  const i = c.indexOf("=");
  const [label, utterance]: [string, string] = i > 0 ? [c.slice(0, i), c.slice(i + 1)] : [`case${results.length + 1}`, c];
  const t = performance.now();
  const res = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: utterance }) });
  const events: { event: string; data: any }[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (event) events.push({ event, data: data ? JSON.parse(data) : null });
  }
  const of = (k: string) => events.filter((e) => e.event === k).map((e) => e.data);
  const reply = of("reply").at(-1) ?? null;
  // The model that actually answered, from the planner replies; the tier only when no call came back.
  const models = [...new Set([...of("planner.reply"), ...of("planner.debug")].map((d) => d.model).filter(Boolean))];
  results.push({
    label,
    utterance,
    http: res.status,
    seconds: Math.round((performance.now() - t) / 10) / 100,
    event_kinds: events.map((e) => e.event),
    reply,
    mentions: of("retrieval")[0]?.mentions ?? [],
    has_planner_request: of("planner.request").length > 0,
    planner_model_hint: models.join(",") || of("planner.request")[0]?.tier || null,
    planner_calls: of("planner.reply").length,
    planner_debug: of("planner.debug"),
    plan: of("plan").at(-1) ?? null,
    errors: [...of("compile.errors"), ...of("error")],
    text_snip: reply?.text?.slice(0, 200) ?? null,
  });
}
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${out}: ${results.map((r) => `${r.label} ${r.http} ${r.seconds}s planner_calls=${r.planner_calls} model=${r.planner_model_hint}`).join("; ")}`);
