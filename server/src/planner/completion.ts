import type { CompiledPlan } from "../core/compile.js";
import type { RegisteredAction } from "../registry/registry.js";
import { loadCardMeta } from "../retrieval/cards.js";

// Canonical write verbs plus the indirect verb heads used by non-experts. Noun-only synonyms are not
// intent evidence. This is a repair heuristic, never a permission or execution decision.
const INDIRECT = ["chase", "cover", "take", "help", "pick", "loop", "hand"];
const READ_HEADS = new Set(["list", "show", "find", "search", "read", "get", "count", "summarize", "tell"]);
const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];

export function readOnlyIntentError(message: string, plan: CompiledPlan, offered: RegisteredAction[]): string[] {
  const calls = plan.steps.flatMap((s) => s.kind === "action" ? [s.call.action] : s.kind === "forEach" ? s.calls.map((c) => c.action) : []);
  if (!calls.length || calls.some((a) => a.risk !== "read")) return [];
  // Informational questions aren't commands, even if they mention a write verb ("who sent the email?").
  if (/^\s*(which|what|who|when|where|how|did|does|has|have|is|are|was|were)\b/i.test(message)) return [];
  const writes = offered.filter((a) => a.risk !== "read");
  const verbs = new Set([...writes.map((a) => words(a.name)[0]!), ...INDIRECT]);
  const meta = loadCardMeta();
  // In a read clause, "draft" and "pending" describe records, not commands to write. A later
  // imperative clause ("find records, then send reminders") still supplies write-intent evidence.
  const clauses = message.split(/[,;]|\b(?:and|then|but)\b/i).map((clause) => words(clause).filter((w, i) => i !== 0 || w !== "please"));
  const text = ` ${clauses.filter((tokens) => !READ_HEADS.has(tokens[0] ?? "")).flat().join(" ")} `;
  const match = writes.some((a) => [a.name, ...(meta[a.id]?.synonyms ?? [])].some((phrase) => {
    const tokens = words(phrase);
    // Match a verb head, not a record noun or an incidental word further inside a phrase.
    return tokens.length > 0 && verbs.has(tokens[0]!) && text.includes(` ${tokens[0]} `);
  }));
  return match ? ["the plan only finds records; add the action that does it, or reply unsupported if no listed action does"] : [];
}
