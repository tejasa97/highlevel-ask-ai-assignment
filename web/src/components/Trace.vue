<script setup>
import { computed } from "vue";
import Json from "./Json.vue";

const props = defineProps({ turn: { type: Object, required: true } });

const tokens = (u) => `${u.input.toLocaleString()} in (${u.cachedRead.toLocaleString()} cached) · ${u.output.toLocaleString()} out`;
const callsFor = (step) => {
  const ids = new Set((step.calls ?? []).map((c) => c.action));
  return props.turn.calls.filter((c) => ids.has(c.action));
};
const totals = computed(() => {
  const r = props.turn.planner.map((p) => p.reply).filter(Boolean);
  return {
    llmMs: r.reduce((a, x) => a + x.latencyMs, 0),
    cost: r.reduce((a, x) => a + x.usage.costUsd, 0),
    execMs: props.turn.runs.reduce((a, x) => a + x.ms, 0),
  };
});
// Section numbers follow what this turn actually has.
const sections = computed(() =>
  [
    props.turn.retrieval.length && "retrieval",
    "planner",
    props.turn.compileErrors.length && "validation",
    props.turn.plan && "plan",
    props.turn.calls.length && "calls",
  ].filter(Boolean),
);
const num = (name) => sections.value.indexOf(name) + 1;
const matched = (m) => Object.entries(m ?? {}).map(([field, terms]) => `${field}: ${terms.join(" ")}`).join(" · ");
const share = (c) => `${Math.round((100 * c.sent) / c.allImplemented)}%`;
const stepLine = (s) =>
  s.kind === "resolve" ? `${s.entity} "${s.name}"`
  : s.kind === "filter" ? `${s.in} where ${JSON.stringify(s.where)}`
  : s.kind === "exclude" ? `${s.in} by ${s.by} not in ${s.set}`
  : s.kind === "forEach" ? `each of ${s.in}${s.roundRobin ? `, round-robin over ${s.roundRobin}` : ""}`
  : "";
</script>

<template>
  <div class="trace">
    <div class="summary-bar">
      <span><b>{{ turn.planner.length }}</b> LLM call{{ turn.planner.length === 1 ? "" : "s" }} · {{ (totals.llmMs / 1000).toFixed(1) }} s · ${{ totals.cost.toFixed(4) }}</span>
      <span><b>{{ turn.calls.length }}</b> tool calls · exec {{ totals.execMs }} ms</span>
      <span><b>{{ turn.changes.length }}</b> rows changed</span>
      <span v-if="turn.live" class="live">live</span>
    </div>

    <template v-if="turn.retrieval.length">
      <h3>{{ num("retrieval") }} · Retrieval <span class="muted small">(BM25 over all 500 catalog actions, no model)</span></h3>
      <div v-for="(r, i) in turn.retrieval" :key="i" class="card">
        <div class="card-head">
          <span class="tag">{{ r.label }}</span>
          <span class="small"><b>{{ r.picks.filter((p) => p.available).length }}</b> cards sent · {{ r.picks.filter((p) => !p.available).length }} not in v1</span>
          <span class="muted small">cards {{ r.promptChars.sent.toLocaleString() }} of {{ r.promptChars.allImplemented.toLocaleString() }} chars ({{ share(r.promptChars) }}) · top score {{ r.topScore }} · {{ r.ms }} ms<template v-if="r.embedMs !== undefined"> + embedding {{ r.embedMs }} ms</template></span>
          <span v-if="r.noMatch" class="tag bad">no match</span>
        </div>
        <div class="small terms">
          <span class="muted">terms</span> <span v-for="t in r.terms" :key="t" class="chip mono">{{ t }}</span>
        </div>
        <div v-if="r.mentions?.length" class="small terms">
          <span class="muted">names</span> <span v-for="m in r.mentions" :key="m.name + m.entity" class="chip">{{ m.name }} → {{ m.entity }}<template v-if="m.count > 1"> ×{{ m.count }}</template></span>
        </div>
        <div v-if="r.clauses.length > 1" class="small terms">
          <span class="muted">clauses</span> <span v-for="c in r.clauses" :key="c" class="chip">{{ c }}</span>
        </div>
        <table class="picks small">
          <thead><tr><th>#</th><th>action</th><th>why</th><th>score</th><th>matched</th></tr></thead>
          <tbody>
            <tr v-for="p in r.picks" :key="p.id" :class="{ unavailable: !p.available }">
              <td class="muted">{{ p.rank ?? "" }}</td>
              <td><span class="mono">{{ p.id }}</span> {{ p.name }} <span class="muted">· {{ p.module }}</span> <span v-if="!p.available" class="tag">not in v1</span></td>
              <td>{{ p.why }}<span v-if="p.via" class="muted"> ← {{ p.via }}</span></td>
              <td class="mono">{{ p.score ?? "" }}</td>
              <td class="muted">{{ p.why === "dense" ? "similar meaning (embeddings)" : matched(p.matched) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <h3>{{ num("planner") }} · Planner</h3>
    <div v-for="(p, i) in turn.planner" :key="i" class="card">
      <div class="card-head">
        <span class="tag">{{ p.request.label }}</span>
        <span v-if="p.reply" class="mono">{{ p.reply.model }}</span>
        <span v-if="p.reply" class="muted small">{{ (p.reply.latencyMs / 1000).toFixed(1) }} s · {{ tokens(p.reply.usage) }} · ${{ p.reply.usage.costUsd.toFixed(4) }}</span>
        <span v-else-if="turn.live" class="live">waiting for model…</span>
        <span v-else class="muted small">no reply</span>
      </div>
      <details class="sub"><summary>Prompt sent ({{ p.request.user.length.toLocaleString() }} chars, {{ p.request.actions.length }} action cards)</summary><pre class="prompt">{{ p.request.user }}</pre></details>
      <details class="sub"><summary>System prompt</summary><pre class="prompt">{{ p.request.system }}</pre></details>
      <Json v-if="p.reply" :value="p.reply.json" label="reply" :open="p.reply.json?.type !== 'plan'" />
    </div>

    <template v-if="turn.compileErrors.length">
      <h3>{{ num("validation") }} · Validation</h3>
      <div v-for="(errs, i) in turn.compileErrors" :key="i" class="card bad">
        <div class="card-head"><span class="tag bad">rejected</span><span class="small">{{ i === 0 ? "sent back to the planner for one repair" : "still invalid" }}</span></div>
        <ul><li v-for="e in errs" :key="e" class="mono small">{{ e }}</li></ul>
      </div>
    </template>

    <template v-if="turn.plan">
      <h3>{{ num("plan") }} · Plan <span class="muted small mono">#{{ turn.plan.hash }}</span></h3>
      <div v-for="s in turn.plan.steps" :key="s.id" class="card step" :class="turn.steps[s.id]?.status">
        <div class="card-head">
          <span class="mono step-id">{{ s.id }}</span>
          <span class="tag">{{ s.kind }}</span>
          <span class="small">{{ stepLine(s) }}</span>
          <span v-if="s.deps.length" class="muted small">after {{ s.deps.join(", ") }}</span>
          <span class="spacer"></span>
          <span class="status" :class="turn.steps[s.id]?.status ?? 'pending'">{{ (turn.steps[s.id]?.status ?? "not run").replace(/_/g, " ") }}</span>
        </div>
        <div v-for="(c, j) in s.calls ?? []" :key="j" class="call-def">
          <span class="mono">{{ c.action }}</span> {{ c.name }} <span class="risk" :class="c.risk">{{ c.risk }}</span>
          <Json :value="c.args" label="args" />
        </div>
        <div v-if="turn.steps[s.id]?.error" class="err small">{{ turn.steps[s.id].error.code }}: {{ turn.steps[s.id].error.message }}</div>
        <Json v-if="turn.steps[s.id]?.output !== undefined" :value="turn.steps[s.id].output" label="output" />
        <div v-if="turn.steps[s.id]?.items" class="items">
          <div v-for="it in turn.steps[s.id].items" :key="it.key" class="item small" :class="it.status">
            <span class="dot"></span>{{ it.label ?? it.key }}
            <span v-if="it.replayed" class="muted">· replayed {{ it.replayed }}</span>
            <span v-if="it.error" class="err">· {{ it.error.code }}: {{ it.error.message }}</span>
          </div>
        </div>
      </div>
    </template>

    <template v-if="turn.calls.length">
      <h3>{{ num("calls") }} · Tool calls <span class="muted small">(every handler run, in order)</span></h3>
      <div v-for="(c, i) in turn.calls" :key="i" class="card call" :class="{ bad: c.error }">
        <div class="card-head">
          <span class="muted small">#{{ i + 1 }}<template v-if="c.phase"> · after approval</template></span>
          <span class="mono">{{ c.action }}</span> <span>{{ c.name }}</span>
          <span class="risk" :class="c.risk">{{ c.risk }}</span>
          <span class="spacer"></span>
          <span class="muted small">{{ c.ms }} ms</span>
        </div>
        <Json :value="c.args" label="args" />
        <div v-if="c.error" class="err small">{{ c.error.code }}: {{ c.error.message }}</div>
        <Json v-else :value="c.result" label="result" />
      </div>
    </template>

    <p v-if="turn.error" class="card bad err">{{ turn.error }}</p>
  </div>
</template>

<style scoped>
.terms { margin: 4px 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.chip { padding: 1px 6px; border-radius: 4px; background: var(--chip, rgba(127, 127, 127, 0.14)); }
.picks { width: 100%; border-collapse: collapse; margin-top: 6px; }
.picks th { text-align: left; font-weight: 500; opacity: 0.6; padding: 3px 6px; }
.picks td { padding: 3px 6px; border-top: 1px solid rgba(127, 127, 127, 0.15); vertical-align: top; }
.picks tr.unavailable td { opacity: 0.55; }
</style>
