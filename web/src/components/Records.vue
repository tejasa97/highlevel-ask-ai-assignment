<script setup>
import { ref } from "vue";

// Records a reply talks about, as cards. Works for any table: fields are laid out by what their values look like,
// with a few well-known keys (status, rating, money, long text) given their own treatment.

const props = defineProps({ shown: { type: Array, required: true }, users: { type: Array, default: () => [] } });

const LIST_MAX = 5;
const expanded = ref(new Set()); // "group:index" of list rows opened into full cards
const showAll = ref(new Set()); // group indexes showing every row

const ID = /^[a-z]{2,4}_\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const HIDDEN = new Set(["id", "firstName", "lastName", "createdAt", "updatedAt", "mergedInto", "revisions"]);
const BADGES = ["status", "priority", "stage", "stageName", "direction", "channel", "kind", "method", "directory", "source", "strategy"];
const MONEY = /^(value|amount|total|subtotal|price|balance|unallocated)$|(Value|Amount|Total|Price|Paid|Due)$/;
const PROSE = new Set(["body", "description", "content", "message", "lastMessagePreview", "summary", "responseDraft", "publishedResponse", "cancelReason", "lostReason", "disqualifyReason", "voidReason", "reason"]);
const PEOPLE = /^(owner|assignee|host|manager|author|createdBy|recordedBy|sender|user)(Id)?$/;
const OK = new Set(["active", "open", "done", "completed", "won", "paid", "succeeded", "delivered", "published", "booked", "confirmed", "qualified", "available", "sent", "received", "fulfilled"]);
const WARN = new Set(["pending", "draft", "new", "contacted", "scheduled", "high", "urgent", "partial", "overdue", "in_progress", "unpaid", "rescheduled"]);
const BAD = new Set(["lost", "failed", "cancelled", "canceled", "void", "voided", "deactivated", "bounced", "closed", "disqualified", "no_show", "refunded", "unsubscribed", "inactive", "archived"]);

const titleKey = (o) => (o.name ? "name" : o.title ? "title" : o.subject ? "subject" : o.number ? "number" : Object.keys(o).find((k) => k.endsWith("Name") && typeof o[k] === "string" && o[k]));
const titleOf = (o, noun) => o[titleKey(o)] ?? cap(noun);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const words = (k) => cap(k.replace(/Id$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase());
const userName = (id) => props.users.find((u) => u.id === id)?.name;
const WEEKDAY = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/;
const empty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
const tone = (v) => (OK.has(v) ? "ok" : WARN.has(v) ? "warn" : BAD.has(v) ? "bad" : "");

function date(v) {
  if (DATE.test(v)) return new Date(`${v}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}
function money(n, currency) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
  catch { return n.toLocaleString(); }
}
/** One plain value as text. */
function plain(k, v, rec) {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return MONEY.test(k) ? money(v, rec.currency) : k === "probability" ? `${v}%` : v.toLocaleString();
  if (typeof v === "string") {
    if (DATE.test(v) || DATETIME.test(v)) return date(v);
    if (ID.test(v)) return userName(v) ?? v;
    return /^[a-z]+(_[a-z]+)+$/.test(v) ? v.replace(/_/g, " ") : v;
  }
  if (v && typeof v === "object" && "open" in v && "close" in v) return `${v.open}–${v.close}`;
  if (v && typeof v === "object") return Object.entries(v).filter(([, x]) => !empty(x)).map(([a, x]) => `${words(a)}: ${plain(a, x, rec)}`).join(", ");
  return String(v);
}

/** How a record lays out: header badges, a rating, prose blocks, a key/value grid, and sub-lists. */
function layout(rec) {
  const tk = titleKey(rec);
  const badges = BADGES.filter((k) => typeof rec[k] === "string" && rec[k]).map((k) => ({ k, v: rec[k].replace(/_/g, " "), tone: tone(rec[k]) }));
  const rating = typeof rec.rating === "number" ? rec.rating : null;
  const prose = [], grid = [], lists = [], chips = [];
  for (const [k, v] of Object.entries(rec)) {
    if (k === tk || HIDDEN.has(k) || BADGES.includes(k) || k === "rating" || k === "currency" || empty(v)) continue;
    if (typeof v === "string" && (PROSE.has(k) || v.length > 90)) prose.push({ k, v });
    else if (PEOPLE.test(k) && typeof v === "string") { if (userName(v)) grid.push({ k: words(k), v: userName(v) }); }
    else if ((k.endsWith("Id") || k.endsWith("Ids")) ) continue;
    else if (typeof v === "string" && ID.test(v)) continue;
    else if (Array.isArray(v) && v.every((x) => typeof x !== "object")) chips.push({ k, v: v.map((x) => (ID.test(x) ? userName(x) ?? x : x)) });
    else if (Array.isArray(v)) lists.push({ k, rows: v.slice(0, 8).map((o) => row(o, rec)), more: v.length - 8 });
    else if (typeof v === "object") {
      // In opening hours a day with no interval is closed, not unknown.
      const closed = (a, x) => x === null && WEEKDAY.test(a);
      const parts = Object.entries(v).filter(([a, x]) => (closed(a, x) || !empty(x)) && !(typeof x === "string" && ID.test(x)) && a !== "type" && a !== "id");
      if (parts.length) grid.push({ k: words(k), sub: parts.map(([a, x]) => ({ k: words(a), v: closed(a, x) ? "Closed" : plain(a, x, rec) })) });
    } else {
      const text = plain(k, v, rec);
      grid.push({ k: words(k), v: text, href: k === "email" || k.endsWith("Email") ? `mailto:${v}` : k === "phone" ? `tel:${v}` : /^https?:\/\//.test(v) ? v : null });
    }
  }
  const created = rec.createdAt ? date(rec.createdAt) : null;
  return { title: rec[tk], badges, rating, prose, grid, lists, chips, created };
}
/** A sub-list row, e.g. an invoice line item or a pipeline stage: its name, then its other plain values. */
function row(o, rec) {
  if (!o || typeof o !== "object") return { title: String(o), rest: "" };
  const tk = titleKey(o) ?? (o.description ? "description" : null);
  const rest = Object.entries(o)
    .filter(([k, x]) => k !== tk && k !== "id" && !k.endsWith("Id") && !empty(x) && typeof x !== "object" && !(typeof x === "string" && ID.test(x)))
    .map(([k, x]) => `${words(k)} ${plain(k, x, rec)}`).join(" · ");
  return { title: tk ? o[tk] : "", rest };
}
/** The few things a collapsed list row shows beside its name. */
function brief(rec) {
  const l = layout(rec);
  const bits = l.grid.filter((g) => g.v && !g.sub).slice(0, 2).map((g) => g.v);
  if (!bits.length && l.prose[0]) bits.push(l.prose[0].v);
  return { ...l, bits };
}

const key = (g, i) => `${g}:${i}`;
function toggle(g, i) {
  const s = new Set(expanded.value);
  s.has(key(g, i)) ? s.delete(key(g, i)) : s.add(key(g, i));
  expanded.value = s;
}
const visible = (group, g) => (showAll.value.has(g) ? group.items : group.items.slice(0, LIST_MAX));
</script>

<template>
  <div class="records" @click.stop>
    <section v-for="(group, g) in shown" :key="g" class="rec-group">
      <!-- A bare noun ("Task") only repeats the card's own corner label. -->
      <div v-if="group.heading !== cap(group.noun) || group.total > group.items.length" class="rec-heading">
        <span>{{ group.heading }}</span>
        <span v-if="group.total > group.items.length" class="muted">showing {{ group.items.length }}</span>
      </div>

      <template v-for="(rec, i) in visible(group, g)" :key="rec.id ?? i">
        <!-- One record, or a list row someone opened: the full card. -->
        <article v-if="group.items.length === 1 || expanded.has(key(g, i))" class="rec-card" :class="{ inlist: group.items.length > 1 }">
          <template v-for="l in [layout(rec)]" :key="0">
            <header class="rec-head" @click="group.items.length > 1 && toggle(g, i)">
              <span class="rec-title">{{ l.title ?? cap(group.noun) }}</span>
              <span v-if="l.rating !== null" class="stars" :aria-label="`${l.rating} out of 5`"><i v-for="n in 5" :key="n" :class="{ on: n <= l.rating }">★</i></span>
              <span v-for="b in l.badges" :key="b.k" class="pill" :class="b.tone" :title="words(b.k)">{{ b.v }}</span>
              <span class="rec-noun">{{ group.noun.replace(/_/g, " ") }}</span>
            </header>
            <blockquote v-for="p in l.prose" :key="p.k" class="prose"><span v-if="p.k !== 'body'" class="prose-label">{{ words(p.k) }}</span>{{ p.v }}</blockquote>
            <dl v-if="l.grid.length" class="kv">
              <template v-for="f in l.grid" :key="f.k">
                <dt>{{ f.k }}</dt>
                <dd v-if="f.sub" class="sub"><span v-for="s in f.sub" :key="s.k"><span class="muted">{{ s.k }}</span> {{ s.v }}</span></dd>
                <dd v-else-if="f.href"><a :href="f.href" target="_blank" rel="noopener">{{ f.v }}</a></dd>
                <dd v-else>{{ f.v }}</dd>
              </template>
            </dl>
            <div v-for="c in l.chips" :key="c.k" class="rec-chips"><span class="muted">{{ words(c.k) }}</span><span v-for="t in c.v" :key="t" class="tagchip">{{ t }}</span></div>
            <div v-for="s in l.lists" :key="s.k" class="sublist">
              <div class="muted">{{ words(s.k) }}</div>
              <div v-for="(r, j) in s.rows" :key="j" class="subrow"><b v-if="r.title">{{ r.title }}</b><div v-if="r.rest" class="muted">{{ r.rest }}</div></div>
              <div v-if="s.more > 0" class="muted">…and {{ s.more }} more</div>
            </div>
            <footer v-if="l.created" class="rec-foot">Created {{ l.created }}</footer>
          </template>
        </article>

        <!-- Several records: a compact row each, opened on click. -->
        <button v-else class="rec-row" @click="toggle(g, i)">
          <template v-for="l in [brief(rec)]" :key="0">
            <span class="rec-main">
              <span class="rec-line">
                <span class="rec-title">{{ l.title ?? cap(group.noun) }}</span>
                <span v-if="l.rating !== null" class="stars small-stars"><i v-for="n in 5" :key="n" :class="{ on: n <= l.rating }">★</i></span>
                <span v-for="b in l.badges.slice(0, 2)" :key="b.k" class="pill" :class="b.tone">{{ b.v }}</span>
              </span>
              <span v-if="l.bits.length" class="rec-bits muted">{{ l.bits.join(" · ") }}</span>
            </span>
            <span class="chev">›</span>
          </template>
        </button>
      </template>

      <button v-if="group.items.length > LIST_MAX && !showAll.has(g)" class="link more" @click="showAll = new Set([...showAll, g])">Show all {{ group.items.length }}</button>
      <div v-if="group.total > group.items.length && (showAll.has(g) || group.items.length <= LIST_MAX)" class="muted small more">…and {{ group.total - group.items.length }} more not shown</div>
    </section>
  </div>
</template>

<style scoped>
.records { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; cursor: default; }
.rec-heading { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
.rec-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg); }
.rec-card.inlist { margin-bottom: 6px; }
.rec-card.inlist .rec-head { cursor: pointer; }
.rec-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.rec-title { font-weight: 600; }
.rec-noun { margin-left: auto; font-size: 11px; color: var(--muted); text-transform: capitalize; }
.pill { font-size: 11px; font-weight: 600; border-radius: 10px; padding: 1px 8px; background: var(--surface-2); color: var(--muted); text-transform: capitalize; white-space: nowrap; }
.pill.ok { background: var(--ok-bg); color: var(--ok); }
.pill.warn { background: var(--warn-bg); color: var(--warn); }
.pill.bad { background: var(--bad-bg); color: var(--bad); }
.stars { letter-spacing: 1px; font-size: 14px; line-height: 1; }
.stars i { font-style: normal; color: var(--border); }
.stars i.on { color: #f5a524; }
.small-stars { font-size: 11px; }
.prose { margin: 8px 0 0; padding: 6px 10px; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: 0 6px 6px 0; white-space: pre-wrap; }
.prose-label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 8px 0 0; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.kv dd.sub { display: flex; flex-wrap: wrap; gap: 2px 12px; }
.kv a { color: var(--accent); text-decoration: none; }
.kv a:hover { text-decoration: underline; }
.rec-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 8px; font-size: 12px; }
.rec-chips .muted { margin-right: 4px; }
.tagchip { background: var(--surface-2); border-radius: 10px; padding: 1px 8px; }
.sublist { margin-top: 8px; font-size: 12px; }
.subrow { padding: 3px 0; border-top: 1px solid var(--border); }
.subrow:first-of-type { border-top: none; }
.rec-foot { margin-top: 8px; font-size: 11px; color: var(--muted); }
.rec-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 7px 10px; margin-bottom: 4px; border-radius: 8px; background: var(--bg); }
.rec-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rec-line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.rec-bits { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { color: var(--muted); }
.more { font-size: 12px; margin-top: 2px; }
</style>
