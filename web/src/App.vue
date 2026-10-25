<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { getJson, post, stream } from "./api.js";
import Changes from "./components/Changes.vue";
import DataBrowser from "./components/DataBrowser.vue";
import ApprovalPreview from "./components/ApprovalPreview.vue";
import Records from "./components/Records.vue";
import StepList from "./components/StepList.vue";
import Trace from "./components/Trace.vue";

const EXAMPLES = [
  { group: "Bulk work", items: [
    "Assign last week's Facebook leads round-robin to available members of the Sales team, and create a follow-up task for each",
    "Deactivate Dan and give his open work to Raj",
  ] },
  { group: "People & tasks", items: [
    "Create a task for Tom to call Sarah Johnson tomorrow",
    "Who on the Sales team has overdue tasks?",
  ] },
  { group: "Records", items: [
    "Merge the two Sarah Johnson contacts",
    "Convert lead ld_1 into a deal worth $5,000",
  ] },
  { group: "Reviews, listings & support", items: [
    "Show Elodie Mercer's reviews",
    "Show Maple Dental's listing",
    "Reply to the Portal export fails ticket saying we are investigating, then create a follow-up task",
  ] },
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
const inputEl = ref(null);
const debugEl = ref(null);
const metaError = ref(null);

const turn = computed(() => (selected.value === null ? null : turns[selected.value]));
// What the running turn is doing right now, for the typing bubble.
const phase = computed(() => {
  const t = turns.at(-1);
  if (!t) return "Thinking";
  if (t.plan) return "Running the plan";
  if (t.compileErrors.length) return "Repairing the plan";
  if (t.planner.length) return "Planning";
  if (t.retrieval.length) return "Picking actions";
  return "Reading your request";
});
const replyMeta = (m) => {
  const t = turns[m.turn];
  if (!t || t.live) return "";
  const n = t.calls.length, c = t.changes.length;
  return [`${(t.ms / 1000).toFixed(1)} s`, `${n} tool call${n === 1 ? "" : "s"}`, c ? `${c} row${c === 1 ? "" : "s"} changed` : null].filter(Boolean).join(" · ");
};
function openTurn(i, to = "trace") {
  selected.value = i;
  tab.value = to;
  // Below 900px the panel sits under the chat, so bring it into view.
  if (matchMedia("(max-width: 900px)").matches) nextTick(() => debugEl.value?.scrollIntoView({ behavior: "smooth" }));
}

// The composer grows with its text up to a few lines.
watch(input, () => nextTick(() => {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}));
function onGlobalKey(e) {
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    inputEl.value?.focus();
  }
}
onMounted(() => window.addEventListener("keydown", onGlobalKey));
onUnmounted(() => window.removeEventListener("keydown", onGlobalKey));
// Action ids look like M45.A06; the part before the dot is the module.
const moduleCount = computed(() => new Set((meta.value?.actions ?? []).map((a) => a.id.split(".")[0])).size);
// Only the newest reply's options still answer the question the server is waiting on.
const lastAssistant = computed(() => messages.findLastIndex((m) => m.role !== "user"));
const changedIds = computed(() => new Set((turn.value?.changes ?? []).map((c) => c.id)));

async function loadMeta() {
  try {
    meta.value = await getJson("/api/meta");
    metaError.value = null;
  } catch (err) {
    metaError.value = err.message;
  }
}
onMounted(loadMeta);
// The chat on screen starts empty, so the server's chat has to as well: a reload would otherwise leave it waiting
// on a question, or an approval, that nobody can see.
onMounted(async () => {
  try {
    await post("/api/conversation/new");
  } catch {
    // The meta banner already says the API is down.
  }
});

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
    case "reply": {
      const pending = d.status === "awaiting_confirmation" ? t.pending : null;
      const options = d.options?.length ? d.options : undefined;
      // The planner's questions and the executor's read the same to a person.
      const asked = d.status === "clarify" || d.status === "needs_clarification";
      messages.push({
        role: "assistant", status: asked ? "clarify" : d.status, options, turn: turns.indexOf(t), records: d.records ?? [], pending,
        // What the record cards, the approval preview or the option chips say again in full is shown there instead.
        text: d.text.split("\n").filter((l) => !(d.records ?? []).some((r) => r.replaces === l) && !(pending && /^Can(not)? proceed for \d+:/.test(l)) && !(options && /^Alternatives: /.test(l))).join("\n")
          .replace(options && asked ? `: ${options.join(", ")}` : "\0", ""),
        // The planner timed out or its provider failed: the same message may well work a moment later.
        retry: d.infra ? t.request : null,
      });
      scrollChat();
      break;
    }
    case "error":
      t.error = d.message;
      messages.push({ role: "error", text: d.message, turn: turns.indexOf(t), retry: t.request });
      scrollChat();
      break;
    case "done": t.ms += d.ms; t.live = false; break;
  }
}

async function run(path, body, t) {
  busy.value = true;
  t.live = true;
  t.request = { path, body };
  try {
    await stream(path, { ...body, tier: tier.value, actorId: actorId.value }, (name, d) => onEvent(t, name, d));
  } catch (err) {
    onEvent(t, "error", { message: err.message });
  } finally {
    busy.value = false;
    t.live = false;
    dataVersion.value++;
    loadMeta();
    nextTick(() => inputEl.value?.focus());
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

// Send a failed request again: a new turn for a message, the same turn for an approval.
async function retry(m) {
  if (busy.value) return;
  m.retried = true;
  const { path, body } = m.retry;
  if (path === "/api/ask") await send(body.message);
  else await run(path, body, turns[m.turn]);
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
    <div class="brand"><span class="logo">✦</span>Ask AI <span class="badge">v1 · dev</span></div>
    <div class="controls">
      <span class="muted small clock" v-if="meta" title="The seed's fixed clock">now {{ meta.now.slice(0, 16).replace("T", " ") }} UTC</span>
      <label class="small">As
        <select v-model="actorId">
          <option v-for="u in meta?.users ?? []" :key="u.id" :value="u.id" :disabled="u.status === 'deactivated'">{{ u.name }} ({{ u.roles.join(", ") }})</option>
        </select>
      </label>
      <div class="segmented small" role="radiogroup" aria-label="Model tier">
        <button v-for="o in ['strong', 'fast']" :key="o" type="button" role="radio" :aria-checked="tier === o" :class="{ on: tier === o }" @click="tier = o">{{ o }}</button>
      </div>
      <button class="ghost small" @click="reset" :disabled="busy">↺ Reset data</button>
    </div>
  </header>

  <div v-if="metaError" class="banner" role="alert">
    Can't reach the API server ({{ metaError }}). Start it with <span class="mono">npm run serve</span> in server/, then
    <button class="link" @click="loadMeta">try again</button>.
  </div>

  <main class="layout">
    <section class="chat">
      <div class="messages" ref="chatEl" role="log" aria-live="polite" aria-label="Conversation">
        <div v-if="!messages.length" class="welcome">
          <div class="hero">
            <div class="hero-logo">✦</div>
            <h1>What should we get done?</h1>
            <p class="muted">Ask in plain words. The planner picks actions, the code runs them, and the panel on the right shows the plan, every tool call and every row it changed.</p>
            <p class="muted small">{{ meta?.actions.length ?? "…" }} actions live across {{ meta ? moduleCount : "…" }} modules</p>
          </div>
          <div v-for="g in EXAMPLES" :key="g.group" class="example-group">
            <div class="example-head">{{ g.group }}</div>
            <button v-for="e in g.items" :key="e" class="example" @click="send(e)" :disabled="busy">
              <span>{{ e }}</span><span class="go">→</span>
            </button>
          </div>
        </div>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="[m.role, { picked: m.turn === selected }]" @click="selected = m.turn">
          <div v-if="m.role !== 'user'" class="avatar" :class="m.role">{{ m.role === "error" ? "!" : "✦" }}</div>
          <div class="bubble">
            <div v-if="m.status && m.role === 'assistant'" class="status" :class="m.status">{{ m.status === "clarify" ? "needs your answer" : m.status.replace(/_/g, " ") }}</div>
            <div v-if="m.text" class="text">{{ m.text }}</div>
            <Records v-if="m.records?.length" :shown="m.records" :users="meta?.users ?? []" />
            <div v-if="m.pending" class="pending">
              <ApprovalPreview :pending="m.pending" :turn="turns[m.turn]" :users="meta?.users ?? []" />
              <div v-if="!m.answered" class="row">
                <button class="primary" @click.stop="answer(m, true)" :disabled="busy">{{ m.pending.blockedCount ? 'Approve eligible only' : 'Approve' }}</button>
                <button class="ghost" @click.stop="answer(m, false)" :disabled="busy">Cancel</button>
              </div>
              <div v-else class="muted small">{{ m.answered }}</div>
            </div>
            <StepList v-if="m.role === 'assistant' && !m.pending && turns[m.turn]?.plan?.steps.length > 1" :turn="turns[m.turn]" />
            <div v-if="m.options?.length" class="chips">
              <button v-for="o in m.options" :key="o" class="chip" @click.stop="send(o)" :disabled="busy || i !== lastAssistant">{{ o }}</button>
            </div>
            <div v-if="m.options?.length && m.status === 'clarify' && i === lastAssistant" class="muted small">Pick one, or type your own answer.</div>
            <div v-if="m.retry && !m.retried && i === lastAssistant" class="row">
              <button class="primary small" @click.stop="retry(m)" :disabled="busy">↻ Retry</button>
            </div>
            <div v-if="m.role === 'assistant' && replyMeta(m)" class="reply-meta">
              <span>{{ replyMeta(m) }}</span>
              <button class="link" @click.stop="openTurn(m.turn)">Trace</button>
              <button v-if="turns[m.turn]?.changes.length" class="link" @click.stop="openTurn(m.turn, 'changes')">Changes</button>
            </div>
          </div>
        </div>
        <div v-if="busy" class="msg assistant">
          <div class="avatar assistant spinning">✦</div>
          <div class="bubble thinking">
            <div class="thinking-line"><span>{{ phase }}</span><span class="dots"><i></i><i></i><i></i></span></div>
            <StepList v-if="turns.at(-1)?.plan" :turn="turns.at(-1)" />
          </div>
        </div>
      </div>
      <form class="composer" @submit.prevent="send()">
        <div class="composer-box">
          <textarea ref="inputEl" v-model="input" @keydown="onKey" rows="1" placeholder="Ask for something…" :disabled="busy" autofocus></textarea>
          <button class="primary send" :disabled="busy || !input.trim()" aria-label="Send">↑</button>
        </div>
        <div class="hint muted">Enter to send · Shift+Enter for a new line · / to focus</div>
      </form>
    </section>

    <section class="debug" ref="debugEl">
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
          <div v-else class="panel-empty"><div class="panel-empty-icon">⌁</div><b>No trace yet</b><span class="muted">Send a message to see retrieval, the planner's reply, the plan and every tool call.</span></div>
        </template>
        <template v-else-if="tab === 'changes'">
          <Changes v-if="turn" :turn="turn" />
          <div v-else class="panel-empty"><div class="panel-empty-icon">±</div><b>No changes yet</b><span class="muted">Every row a turn inserts, updates or deletes shows up here as a diff.</span></div>
        </template>
        <DataBrowser v-else :tables="meta?.tables ?? []" :version="dataVersion" :changed="changedIds" />
      </div>
    </section>
  </main>
</template>
