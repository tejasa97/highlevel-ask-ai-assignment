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

    <h3>1 · Planner</h3>
    <div v-for="(p, i) in turn.planner" :key="i" class="card">
      <div class="card-head">
        <span class="tag">{{ p.request.label }}</span>
        <span v-if="p.reply" class="mono">{{ p.reply.model }}</span>
        <span v-if="p.reply" class="muted small">{{ (p.reply.latencyMs / 1000).toFixed(1) }} s · {{ tokens(p.reply.usage) }} · ${{ p.reply.usage.costUsd.toFixed(4) }}</span>
        <span v-else class="live">waiting for model…</span>
      </div>
      <details class="sub"><summary>Prompt sent ({{ p.request.user.length.toLocaleString() }} chars, {{ p.request.actions.length }} action cards)</summary><pre class="prompt">{{ p.request.user }}</pre></details>
      <details class="sub"><summary>System prompt</summary><pre class="prompt">{{ p.request.system }}</pre></details>
      <Json v-if="p.reply" :value="p.reply.json" label="reply" :open="p.reply.json?.type !== 'plan'" />
    </div>

    <template v-if="turn.compileErrors.length">
      <h3>2 · Validation</h3>
      <div v-for="(errs, i) in turn.compileErrors" :key="i" class="card bad">
        <div class="card-head"><span class="tag bad">rejected</span><span class="small">{{ i === 0 ? "sent back to the planner for one repair" : "still invalid" }}</span></div>
        <ul><li v-for="e in errs" :key="e" class="mono small">{{ e }}</li></ul>
      </div>
    </template>

    <template v-if="turn.plan">
      <h3>{{ turn.compileErrors.length ? 3 : 2 }} · Plan <span class="muted small mono">#{{ turn.plan.hash }}</span></h3>
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
      <h3>{{ turn.compileErrors.length ? 4 : 3 }} · Tool calls <span class="muted small">(every handler run, in order)</span></h3>
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
