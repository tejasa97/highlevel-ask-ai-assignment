<script setup>
import { computed } from "vue";
import { describeStep } from "../steps.js";

// Each step of a turn's plan with where it stands: live while the plan runs, and left in the reply as its outcome.
const props = defineProps({ turn: { type: Object, required: true } });

const MARK = { done: "✓", partial: "◐", failed: "✕", skipped: "–", running: "…", awaiting_confirmation: "?", needs_clarification: "?" };
const NOTE = { partial: "partly done", failed: "failed", skipped: "skipped", awaiting_confirmation: "waiting for your OK", needs_clarification: "needs your answer" };
const rows = computed(() =>
  (props.turn.plan?.steps ?? []).map((s) => {
    const st = props.turn.steps[s.id];
    const status = st?.status ?? "pending";
    return { id: s.id, label: describeStep(s) ?? s.id, status, mark: MARK[status] ?? "·", note: status === "failed" ? st.error?.message ?? NOTE.failed : NOTE[status] };
  }),
);
</script>

<template>
  <ol class="steplist" aria-label="Steps">
    <li v-for="r in rows" :key="r.id" :class="r.status">
      <span class="mark" aria-hidden="true">{{ r.mark }}</span>
      <span>{{ r.label }}<span v-if="r.note" class="note"> — {{ r.note }}</span></span>
    </li>
  </ol>
</template>
