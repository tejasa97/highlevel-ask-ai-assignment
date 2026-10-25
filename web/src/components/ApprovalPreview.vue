<script setup>
import { computed } from "vue";
import Json from "./Json.vue";

// What an approval will do, laid out for a person to check: who it goes to, what it says, and what runs after.
const props = defineProps({ pending: { type: Object, required: true }, turn: Object, users: { type: Array, default: () => [] } });

const ID = /^[a-z]{2,4}_\d+$/;
const BODY = ["body", "message", "text", "content", "html", "note"];
const TO = ["to", "email", "phone", "recipient"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const words = (k) => cap(k.replace(/Id$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase());
const userName = (id) => props.users.find((u) => u.id === id)?.name;
const show = (v) => {
  if (typeof v === "string") return ID.test(v) ? userName(v) ?? v : v;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v && typeof v === "object" && "type" in v && "id" in v) return `${v.type} ${v.id}`;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

const items = computed(() =>
  props.pending.preview.map((p) => {
    const args = p.args ?? {};
    const toKey = TO.find((k) => typeof args[k] === "string");
    const bodyKey = BODY.find((k) => typeof args[k] === "string");
    const to = p.target?.to ?? (toKey ? args[toKey] : null);
    const fields = Object.entries(args)
      .filter(([k, v]) => k !== toKey && k !== bodyKey && k !== "subject" && v !== null && v !== undefined && v !== "")
      .map(([k, v]) => ({ k: words(k), v: show(v) }));
    return { ...p, to, subject: args.subject ?? null, body: bodyKey ? args[bodyKey] : null, fields };
  }),
);

// Steps the approval lets run: everything in the plan not run yet, besides the step being approved.
const DONE = new Set(["done", "failed", "skipped"]);
const later = computed(() => {
  const plan = props.turn?.plan;
  if (!plan) return [];
  const calls = (cs) => cs.map((c) => `${c.name}${c.args?.title || c.args?.name ? `: ${c.args.title ?? c.args.name}` : ""}`).join(" + ");
  return plan.steps
    .filter((s) => !(props.pending.covers ?? [props.pending.stepId]).includes(s.id) && !DONE.has(props.turn.steps[s.id]?.status))
    .map((s) =>
      s.kind === "action" ? calls(s.calls)
      : s.kind === "forEach" ? `For each: ${calls(s.calls)}`
      : s.kind === "resolve" ? `Find ${s.entity} "${s.name}"`
      : null,
    )
    .filter(Boolean);
});
</script>

<template>
  <div class="approval">
    <div v-if="pending.changed" class="approval-note">The records changed since the last preview. Check them again.</div>
    <div v-if="pending.blockedCount" class="approval-section">
      <div class="approval-head bad">Will be skipped · {{ pending.blockedCount }}</div>
      <div v-for="(b, j) in pending.blocked" :key="j" class="approval-blocked"><b>{{ b.label }}</b> <span class="muted">— {{ b.error.message }}</span></div>
      <div v-if="pending.blockedCount > (pending.blocked?.length ?? 0)" class="muted small">…and {{ pending.blockedCount - pending.blocked.length }} more</div>
    </div>
    <div class="approval-section">
      <div class="approval-head">{{ pending.blockedCount ? "Will run" : "Needs your OK" }} · {{ pending.count }} <span class="muted">— {{ pending.reason }}</span></div>
      <div v-for="(p, j) in items" :key="j" class="approval-item">
        <div class="approval-title"><b>{{ p.name }}</b><span v-if="p.label"> · {{ p.label }}</span> <span class="mono muted">{{ p.action }}</span></div>
        <dl class="approval-fields">
          <template v-if="p.to"><dt>To</dt><dd>{{ p.to }}</dd></template>
          <template v-if="p.subject"><dt>Subject</dt><dd>{{ p.subject }}</dd></template>
          <template v-for="f in p.fields" :key="f.k"><dt>{{ f.k }}</dt><dd>{{ f.v }}</dd></template>
        </dl>
        <blockquote v-if="p.body" class="approval-body">{{ p.body }}</blockquote>
        <Json :value="{ args: p.args, ...(p.target ? { target: p.target } : {}) }" label="raw" />
      </div>
      <div v-if="pending.count > pending.preview.length" class="muted small">…and {{ pending.count - pending.preview.length }} more like these</div>
    </div>
    <div v-if="later.length" class="approval-section">
      <div class="approval-head">Then runs</div>
      <ol class="approval-later"><li v-for="(l, j) in later" :key="j">{{ l }}</li></ol>
    </div>
  </div>
</template>
