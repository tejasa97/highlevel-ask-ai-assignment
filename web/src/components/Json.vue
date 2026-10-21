<script setup>
import { computed } from "vue";

const props = defineProps({ value: { required: true }, label: String, open: Boolean });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = computed(() =>
  esc(JSON.stringify(props.value, null, 2) ?? "undefined").replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g,
    (m, str, colon, lit, num) =>
      str ? (colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`)
      : lit ? `<span class="j-lit">${lit}</span>`
      : `<span class="j-num">${num}</span>`,
  ),
);
const inline = computed(() => {
  const s = JSON.stringify(props.value);
  return s && s.length > 90 ? s.slice(0, 90) + "…" : s;
});
</script>

<template>
  <details class="json" :open="open">
    <summary><span v-if="label" class="json-label">{{ label }}</span><code class="json-inline">{{ inline }}</code></summary>
    <pre v-html="html"></pre>
  </details>
</template>
