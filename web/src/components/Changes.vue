<script setup>
import { computed } from "vue";
import Json from "./Json.vue";

const props = defineProps({ turn: { type: Object, required: true } });

const groups = computed(() => {
  const by = new Map();
  for (const c of props.turn.changes) {
    if (!by.has(c.table)) by.set(c.table, []);
    by.get(c.table).push(c);
  }
  return [...by.entries()];
});
const counts = computed(() => {
  const n = { insert: 0, update: 0, delete: 0 };
  for (const c of props.turn.changes) n[c.op]++;
  return n;
});
const show = (v) => (v === undefined ? "—" : JSON.stringify(v));
const title = (c) => {
  const d = c.after ?? c.before;
  return d?.name ?? d?.title ?? d?.subject ?? "";
};
</script>

<template>
  <div class="changes">
    <div class="summary-bar">
      <span class="op insert">+{{ counts.insert }} inserted</span>
      <span class="op update">~{{ counts.update }} updated</span>
      <span class="op delete">−{{ counts.delete }} deleted</span>
      <span v-if="turn.live" class="live">live</span>
    </div>
    <p v-if="!turn.changes.length" class="empty muted">{{ turn.live ? "Running…" : "This turn didn't change any data." }}</p>

    <div v-for="[table, list] in groups" :key="table">
      <h3>{{ table }} <span class="muted small">{{ list.length }}</span></h3>
      <div v-for="c in list" :key="c.id + c.op + c.phase" class="card change" :class="c.op">
        <div class="card-head">
          <span class="op" :class="c.op">{{ c.op }}</span>
          <span class="mono">{{ c.id }}</span>
          <span>{{ title(c) }}</span>
          <span v-if="c.phase" class="muted small">after approval</span>
        </div>
        <table v-if="c.op === 'update'" class="fields">
          <tr v-for="f in c.fields" :key="f">
            <td class="mono">{{ f }}</td>
            <td class="before mono">{{ show(c.before[f]) }}</td>
            <td class="arrow">→</td>
            <td class="after mono">{{ show(c.after[f]) }}</td>
          </tr>
        </table>
        <Json v-else :value="c.after ?? c.before" label="row" />
      </div>
    </div>

    <template v-if="turn.audit.length">
      <h3>Audit entries written</h3>
      <div v-for="a in turn.audit" :key="a.seq" class="card small">
        <span class="mono">{{ a.action }}</span> {{ a.summary }} <span class="muted">by {{ a.actor }} · refs {{ a.refs.join(", ") }}</span>
      </div>
    </template>
  </div>
</template>
