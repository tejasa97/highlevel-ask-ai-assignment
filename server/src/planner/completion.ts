import type { CompiledPlan } from "../core/compile.js";
import type { RegisteredAction } from "../registry/registry.js";
import { loadCardMeta } from "../retrieval/cards.js";

// Canonical write verbs plus the indirect verb heads used by non-experts. Noun-only synonyms are not
// intent evidence. This is a repair heuristic, never a permission or execution decision.
const INDIRECT = ["chase", "cover", "take", "help", "pick", "loop", "hand"];
const READ_HEADS = new Set(["list", "show", "find", "search", "read", "get", "count", "summarize", "tell"]);
const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];

/**
 * `catalog` (the registry; else just `offered`) teaches which words open commands: a word that heads at least
 * IMPERATIVE_MIN synonyms, nearly all of them for writes ("change", "edit"), is a write verb when it opens a clause.
 */
export function readOnlyIntentError(message: string, plan: CompiledPlan, offered: RegisteredAction[], catalog?: Catalog): string[] {
  const calls = plan.steps.flatMap((s) => s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);
  if (!calls.length || calls.some((a) => a.risk !== "read")) return [];
  // Informational questions aren't commands, even if they mention a write verb ("who sent the email?"). A message can
  // ask, then tell ("Which leads never replied? Split them between the reps"): its other sentences still count.
  const told = toldPart(message);
  if (!told) return [];
  message = told;
  const writes = offered.filter((a) => a.risk !== "read");
  const verbs = new Set([...writes.map((a) => words(a.name)[0]!), ...INDIRECT]);
  const meta = loadCardMeta();
  // In a read clause, "draft" and "pending" describe records, not commands to write. A later
  // imperative clause ("find records, then send reminders") still supplies write-intent evidence.
  const clauses = message.split(/[,;]|\b(?:and|then|but)\b/i).map((clause) => words(clause).filter((w, i) => i !== 0 || w !== "please"));
  const text = ` ${clauses.filter((tokens) => !READ_HEADS.has(tokens[0] ?? "")).flat().join(" ")} `;
  const opens = new Set(clauses.map((tokens) => tokens[0]).filter((w) => w && imperativeHeads(catalog ?? { list: () => offered }, meta).has(w)));
  const match = writes.some((a) => [a.name, ...(meta[a.id]?.synonyms ?? [])].some((phrase) => {
    const tokens = words(phrase);
    // Match a verb head, not a record noun or an incidental word further inside a phrase.
    return tokens.length > 0 && ((verbs.has(tokens[0]!) && text.includes(` ${tokens[0]} `)) || opens.has(tokens[0]!));
  }));
  return match ? ["the plan only finds records; add the action that does it, or reply unsupported if no listed action does"] : [];
}

/** The sentences of a message that aren't questions: "" when it only asks. */
export function toldPart(message: string): string {
  return message.split(/(?<=[?.!])\s+/).filter((s) => !/\?\s*$/.test(s) && !QUESTION.test(s)).join(" ").trim();
}

const QUESTION = /^\s*(which|what|who|when|where|how|did|does|has|have|is|are|was|were)\b/i;
const IMPERATIVE_MIN = 5;
const WRITE_SHARE = 0.9;
type Catalog = { list(): RegisteredAction[] };
const headsCache = new WeakMap<Catalog, Set<string>>();

/** Words that head synonyms of write actions far more than of reads: "change" opens "change phone number". */
function imperativeHeads(catalog: Catalog, meta: ReturnType<typeof loadCardMeta>): Set<string> {
  const cached = headsCache.get(catalog);
  if (cached) return cached;
  const tally = new Map<string, { write: number; read: number }>();
  for (const a of catalog.list()) {
    for (const phrase of [a.name, ...(meta[a.id]?.synonyms ?? [])]) {
      const head = words(phrase)[0];
      if (!head) continue;
      const t = tally.get(head) ?? { write: 0, read: 0 };
      t[a.risk === "read" ? "read" : "write"]++;
      tally.set(head, t);
    }
  }
  const heads = new Set([...tally].filter(([, t]) => t.write + t.read >= IMPERATIVE_MIN && t.write / (t.write + t.read) >= WRITE_SHARE).map(([h]) => h));
  headsCache.set(catalog, heads);
  return heads;
}
