<script setup>
import { computed, ref, watch } from "vue";
import { getJson } from "../api.js";
import Json from "./Json.vue";

const props = defineProps({ tables: Array, version: Number, changed: Object });

const table = ref("leads");
const rows = ref([]);
const filter = ref("");
const onlyChanged = ref(false);
const open = ref(null);
const audit = ref([]);

async function load() {
  if (table.value === "_audit") {
    audit.value = await getJson("/api/audit");
    return;
  }
  rows.value = await getJson(`/api/tables/${table.value}`);
}
watch([table, () => props.version], load, { immediate: true });

const columns = computed(() => {
  const keys = new Set();
  for (const r of rows.value.slice(0, 50)) Object.keys(r).forEach((k) => keys.add(k));
  return [...keys].filter((k) => !["firstName", "lastName"].includes(k));
});
const visible = computed(() => {
  const q = filter.value.toLowerCase();
  return rows.value.filter((r) => (!onlyChanged.value || props.changed.has(r.id)) && (!q || JSON.stringify(r).toLowerCase().includes(q)));
});
const cell = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }
  return String(v);
};
</script>

<template>
  <div class="data">
    <div class="data-bar">
      <select v-model="table">
        <option v-for="t in tables" :key="t.name" :value="t.name">{{ t.name }} ({{ t.count }})</option>
        <option value="_audit">audit log</option>
      </select>
      <template v-if="table !== '_audit'">
        <input v-model="filter" placeholder="Filter rows…" />
        <label class="small"><input type="checkbox" v-model="onlyChanged" /> only rows changed in this turn</label>
        <span class="muted small">{{ visible.length }} rows</span>
      </template>
    </div>

    <div v-if="table === '_audit'" class="table-wrap">
      <table class="grid">
        <thead><tr><th>seq</th><th>at</th><th>actor</th><th>action</th><th>summary</th><th>refs</th></tr></thead>
        <tbody>
          <tr v-for="a in audit" :key="a.seq"><td>{{ a.seq }}</td><td class="mono">{{ a.at.slice(0, 16) }}</td><td>{{ a.actor }}</td><td class="mono">{{ a.action }}</td><td>{{ a.summary }}</td><td class="mono small">{{ a.refs.join(", ") }}</td></tr>
          <tr v-if="!audit.length"><td colspan="6" class="muted">No writes yet.</td></tr>
        </tbody>
      </table>
    </div>

    <div v-else class="table-wrap">
      <table class="grid">
        <thead><tr><th v-for="c in columns" :key="c">{{ c }}</th></tr></thead>
        <tbody>
          <template v-for="r in visible" :key="r.id">
            <tr :class="{ changed: changed.has(r.id), open: open === r.id }" @click="open = open === r.id ? null : r.id">
              <td v-for="c in columns" :key="c" :class="{ mono: c === 'id' || c.endsWith('Id') }">{{ cell(r[c]) }}</td>
            </tr>
            <tr v-if="open === r.id" class="detail"><td :colspan="columns.length"><Json :value="r" open /></td></tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
