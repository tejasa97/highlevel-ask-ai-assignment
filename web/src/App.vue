<script setup>
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { getJson, post, stream } from "./api.js";
import Changes from "./components/Changes.vue";
import DataBrowser from "./components/DataBrowser.vue";
import Json from "./components/Json.vue";
import Trace from "./components/Trace.vue";

const EXAMPLES = [
  "Assign last week's Facebook leads round-robin to available members of the Sales team, and create a follow-up task for each",
  "Create a task for Tom to call Sarah Johnson tomorrow",
  "Merge the two Sarah Johnson contacts",
  "Who on the Sales team has overdue tasks?",
  "Deactivate Dan and give his open work to Raj",
  "Convert lead ld_1 into a deal worth $5,000",
  "Show Elodie Mercer's reviews",
  "Show Maple Dental's listing",
  "Reply to the Portal export fails ticket saying we are investigating, then create a follow-up task",
];

const meta = ref(null);
const messages = reactive([]);
const turns = reactive([]);
const selected = ref(null); // index into turns
const input = ref("");
const busy = ref(false);
const tier = ref("strong");
const actorId = ref("us_1");
const tab = ref("trace");
const dataVersion = ref(0);
const chatEl = ref(null);

const turn = computed(() => (selected.value === null ? null : turns[selected.value]));
const changedIds = computed(() => new Set((turn.value?.changes ?? []).map((c) => c.id)));

async function loadMeta() {
  meta.value = await getJson("/api/meta");
}
onMounted(loadMeta);

function scrollChat() {
  nextTick(() => chatEl.value?.scrollTo({ top: chatEl.value.scrollHeight, behavior: "smooth" }));
}

function newTurn(message) {
  const t = reactive({
    id: null, message, retrieval: [], planner: [], compileErrors: [], plan: null, steps: {}, calls: [], runs: [], changes: [], audit: [],
    pending: null, error: null, ms: 0, live: true,
  });
  turns.push(t);
  selected.value = turns.length - 1;
  return t;
}

function onEvent(t, name, d) {
  const phase = t.runs.length;
  switch (name) {
    case "turn": t.id = d.turnId; break;
    case "retrieval": t.retrieval.push(d); break;
    case "planner.request": t.planner.push({ request: d, reply: null }); break;
    case "planner.reply": t.planner.at(-1).reply = d; break;
    case "compile.errors": t.compileErrors.push(d.errors); break;
    case "plan": t.plan = d; break;
    case "exec": {
      const s = (t.steps[d.stepId ?? d.pending?.stepId ?? d.clarification?.stepId] ??= {});
      if (d.type === "step.started") s.status = "running";
      else if (d.type === "step.done") s.status = d.status;
      else if (d.type === "step.failed") Object.assign(s, { status: "failed", error: d.error });
      else if (d.type === "confirm.required") s.status = "awaiting_confirmation";
      else if (d.type === "clarify.required") s.status = "needs_clarification";
      break;
    }
    case "call": t.calls.push({ ...d, phase }); break;
    case "run":
      t.runs.push(d);
      for (const s of d.steps) Object.assign((t.steps[s.id] ??= {}), { status: s.status, output: s.output, items: s.items, error: s.error });
      break;
    case "diff":
      t.changes.push(...d.changes.map((c) => ({ ...c, phase })));
      t.audit.push(...d.audit);
      break;
    case "confirm": t.pending = d.pending; break;
    case "reply":
      messages.push({
        role: "assistant", text: d.text, status: d.status, options: d.options, turn: turns.indexOf(t),
        pending: d.status === "awaiting_confirmation" ? t.pending : null,
      });
      scrollChat();
      break;
    case "error":
      t.error = d.message;
      messages.push({ role: "error", text: d.message, turn: turns.indexOf(t) });
      scrollChat();
      break;
    case "done": t.ms += d.ms; t.live = false; break;
  }
}

async function run(path, body, t) {
  busy.value = true;
  t.live = true;
  try {
    await stream(path, { ...body, tier: tier.value, actorId: actorId.value }, (name, d) => onEvent(t, name, d));
  } catch (err) {
    onEvent(t, "error", { message: err.message });
  } finally {
    busy.value = false;
    t.live = false;
    dataVersion.value++;
    loadMeta();
  }
}

async function send(text = input.value) {
  const message = text.trim();
  if (!message || busy.value) return;
  input.value = "";
  const t = newTurn(message);
  messages.push({ role: "user", text: message, turn: turns.indexOf(t) });
  scrollChat();
  await run("/api/ask", { message }, t);
}

async function answer(msg, approve) {
  if (busy.value) return;
  msg.answered = approve ? "approved" : "cancelled";
  const t = turns[msg.turn];
  selected.value = msg.turn;
  await run("/api/confirm", { turnId: t.id, approve }, t);
}

async function reset() {
  if (busy.value || !confirm("Reset the dev database to the seed? Chat history is cleared too.")) return;
  await post("/api/reset");
  messages.splice(0);
  turns.splice(0);
  selected.value = null;
  dataVersion.value++;
  await loadMeta();
}

function onKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

const tabs = computed(() => [
  { id: "trace", label: "Trace", count: turn.value ? turn.value.calls.length : null },
  { id: "changes", label: "Changes", count: turn.value ? turn.value.changes.length : null },
  { id: "data", label: "Data" },
]);
</script>

<template>
  <header class="top">
    <div class="brand">Ask AI <span class="muted">v1 · dev</span></div>
    <div class="controls">
      <span class="muted small" v-if="meta">now {{ meta.now.slice(0, 16).replace("T", " ") }} UTC</span>
      <label class="small">As
        <select v-model="actorId">
          <option v-for="u in meta?.users ?? []" :key="u.id" :value="u.id" :disabled="u.status === 'deactivated'">{{ u.name }} ({{ u.roles.join(", ") }})</option>
        </select>
      </label>
      <label class="small">Model tier
        <select v-model="tier"><option value="strong">strong</option><option value="fast">fast</option></select>
      </label>
      <button class="ghost" @click="reset" :disabled="busy">Reset data</button>
    </div>
  </header>

  <main class="layout">
    <section class="chat">
      <div class="messages" ref="chatEl">
        <div v-if="!messages.length" class="empty">
          <p>Ask for something in plain words. The planner picks actions; the code runs them. The panel on the right shows the plan, every tool call and every row it changed.</p>
          <p class="muted small">{{ meta?.actions.length ?? "…" }} actions live across 18 modules, including reviews, business listings and support tickets.</p>
          <div class="chips">
            <button v-for="e in EXAMPLES" :key="e" class="chip" @click="send(e)" :disabled="busy">{{ e }}</button>
          </div>
        </div>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="[m.role, { picked: m.turn === selected }]" @click="selected = m.turn">
          <div class="bubble">
            <div v-if="m.status && m.role === 'assistant'" class="status" :class="m.status">{{ m.status.replace(/_/g, " ") }}</div>
            <div class="text">{{ m.text }}</div>
            <div v-if="m.pending" class="pending">
              <div class="pending-list">
                <div v-if="m.pending.blockedCount" class="pending-row">
                  <b>Cannot proceed for {{ m.pending.blockedCount }}:</b>
                  <div v-for="(b, j) in m.pending.blocked" :key="j">{{ b.label }} — {{ b.error.message }}</div>
                  <div v-if="m.pending.blockedCount > (m.pending.blocked?.length ?? 0)" class="muted small">Additional blocked targets omitted.</div>
                  <div>Approve only the eligible actions below.</div>
                </div>
                <div v-for="(p, j) in m.pending.preview" :key="j" class="pending-row">
                  <span class="mono">{{ p.action }}</span> {{ p.name }}<span v-if="p.label"> · <b>{{ p.label }}</b></span>
                  <Json :value="p.args" />
                  <Json v-if="p.target" :value="p.target" />
                </div>
                <div v-if="m.pending.count > m.pending.preview.length" class="muted small">…and {{ m.pending.count - m.pending.preview.length }} more</div>
              </div>
              <div v-if="!m.answered" class="row">
                <button class="primary" @click.stop="answer(m, true)" :disabled="busy">{{ m.pending.blockedCount ? 'Approve eligible only' : 'Approve' }}</button>
                <button class="ghost" @click.stop="answer(m, false)" :disabled="busy">Cancel</button>
              </div>
              <div v-else class="muted small">{{ m.answered }}</div>
            </div>
            <div v-if="m.options?.length" class="chips">
              <button v-for="o in m.options" :key="o" class="chip" @click.stop="send(o)" :disabled="busy">{{ o }}</button>
            </div>
          </div>
        </div>
        <div v-if="busy" class="msg assistant"><div class="bubble thinking">{{ turn?.plan ? "Running…" : "Planning…" }}</div></div>
      </div>
      <form class="composer" @submit.prevent="send()">
        <textarea v-model="input" @keydown="onKey" rows="2" placeholder="e.g. Reassign Lucia's overdue tasks to Tom" :disabled="busy"></textarea>
        <button class="primary" :disabled="busy || !input.trim()">Send</button>
      </form>
    </section>

    <section class="debug">
      <nav class="tabs">
        <button v-for="t in tabs" :key="t.id" :class="{ on: tab === t.id }" @click="tab = t.id">
          {{ t.label }}<span v-if="t.count !== null && t.count !== undefined" class="count">{{ t.count }}</span>
        </button>
        <span class="spacer"></span>
        <label v-if="turns.length" class="small">Turn
          <select v-model="selected">
            <option v-for="(t, i) in turns" :key="i" :value="i">{{ i + 1 }}. {{ t.message.slice(0, 50) }}</option>
          </select>
        </label>
      </nav>
      <div class="panel">
        <template v-if="tab === 'trace'">
          <Trace v-if="turn" :turn="turn" />
          <p v-else class="empty muted">Send a message to see its trace.</p>
        </template>
        <template v-else-if="tab === 'changes'">
          <Changes v-if="turn" :turn="turn" />
          <p v-else class="empty muted">Send a message to see what it changed.</p>
        </template>
        <DataBrowser v-else :tables="meta?.tables ?? []" :version="dataVersion" :changed="changedIds" />
      </div>
    </section>
  </main>
</template>
