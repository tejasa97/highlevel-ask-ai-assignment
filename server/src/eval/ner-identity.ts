import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Registry } from "../registry/registry.js";
import type { Fixtures } from "../store/fixtures.js";
import { world } from "../store/world.js";
import { classifyFailure } from "./failure-class.js";
import { type Scenario, ScenarioSchema, type ScenarioRun } from "./scenario.js";

// Workstream D: does NER make the app better? A labelled set (eval/ner-identity/cases.v*.json) of utterances that
// name people, each with the outcome a careful assistant would reach. Every case runs as an ordinary scenario
// (runScenario: same Conversation as the web app, one unscripted question answered with the case's `answer`), and
// this file grades the trace on identity: which existing records the run touched, whether it asked, and whether
// the task finished. The safety metric is a wrong-record binding: acting on (or, for a read, answering about) a
// record that isn't the one the user meant.

const Id = z.string().regex(/^[a-z]{2}_\d+$/);
const Outcome = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("bind"), id: Id }),
  z.strictObject({ outcome: z.literal("ask"), candidates: z.array(Id).min(1), pick: Id }),
  z.strictObject({ outcome: z.literal("not_found"), lookalikes: z.array(Id).default([]) }),
  z.strictObject({ outcome: z.literal("filter") }),
  z.strictObject({ outcome: z.literal("create+warn"), existing: z.array(Id).min(1) }),
]);

export const CATEGORIES = ["aggregate", "create-existing", "quoted", "message-body", "missing-lookalike", "duplicate", "typo", "email", "scoped", "non-english"] as const;
const PREFIX = { contact: "ct", lead: "ld", user: "us" } as const;

export const NerCaseSchema = z
  .strictObject({
    id: z.string(),
    category: z.enum(CATEGORIES),
    /** The kind of record the name refers to; its id prefix is the default scope. */
    entity: z.enum(["contact", "lead", "user"]),
    /** Whether the request is a change (graded on writes) or a question (graded on reads and the reply). */
    intent: z.enum(["read", "write"]),
    utterance: z.string(),
    note: z.string().optional(),
    /** Id prefixes whose records count for binding, when the name could be another kind of record too. */
    scope: z.array(z.string()).optional(),
    setup: ScenarioSchema.shape.setup,
    expect: Outcome,
    /** What the user says if asked a question; without it, the default "go ahead" answer. */
    answer: z.string().optional(),
    /** The person as the utterance names them (not_found, create+warn): the reply must refer to them. */
    name: z.string().optional(),
    /** Extra scenario checks (state, reply, noChanges) the run must also pass to count as finished. */
    check: ScenarioSchema.shape.expect.partial().optional(),
  })
  .refine((c) => c.expect.outcome !== "ask" || c.expect.candidates.includes(c.expect.pick), { message: "pick must be one of the candidates" })
  .refine((c) => c.expect.outcome !== "ask" || c.answer, { message: "an ask case needs the answer that names its pick" })
  .refine((c) => !["not_found", "create+warn"].includes(c.expect.outcome) || c.name, { message: "a not_found or create+warn case needs the name it uses" });
export type NerCase = z.infer<typeof NerCaseSchema>;

export function loadNerCases(file: string): { version: number; cases: NerCase[] } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; cases: unknown[] };
  const cases = raw.cases.map((c, i) => {
    const parsed = NerCaseSchema.safeParse(c);
    if (!parsed.success) throw new Error(`${file} #${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    return parsed.data;
  });
  const dup = cases.map((c) => c.id).find((id, i, all) => all.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate case id ${dup}`);
  return { version: raw.version, cases };
}

export const scopeOf = (c: NerCase) => c.scope ?? [PREFIX[c.entity]];

/** The scenario runScenario plays for a case. */
export function toScenario(c: NerCase): Scenario {
  return ScenarioSchema.parse({
    id: c.id,
    category: c.expect.outcome === "ask" ? "ambiguous" : "direct",
    modules: [],
    ...(c.note ? { note: c.note } : {}),
    setup: c.setup,
    turns: [{ user: c.utterance, ...(c.answer ? { answer: c.answer } : {}) }],
    expect: c.check ?? {},
  });
}

const TABLE: Record<string, string> = { ct: "contacts", ld: "leads", us: "users" };

/** Ids of the scope's records that exist before the run (base seed plus the case's fixtures). */
export function existingIds(c: NerCase): Set<string> {
  const w = world();
  for (const step of c.setup) if ("fixture" in step) (w.f as unknown as Record<string, (o: unknown) => unknown>)[step.fixture]!.call(w.f as Fixtures, step.with);
  const out = new Set<string>();
  for (const p of scopeOf(c)) for (const r of w.store.db.prepare(`SELECT id FROM ${TABLE[p] ?? p} `).all() as { id: string }[]) out.add(r.id);
  w.store.close();
  return out;
}

/** Problems with a case's labels against the data it runs on: ids that don't exist, out of scope, ... */
export function lintCase(c: NerCase): string[] {
  const have = existingIds({ ...c, scope: Object.values(PREFIX) });
  const e = c.expect;
  const ids = e.outcome === "bind" ? [e.id] : e.outcome === "ask" ? e.candidates : e.outcome === "not_found" ? e.lookalikes : e.outcome === "create+warn" ? e.existing : [];
  const out: string[] = [];
  if (c.name && !mentions(c.utterance, c.name)) out.push(`${c.id}: the utterance doesn't contain its name "${c.name}"`);
  for (const id of ids) {
    if (!have.has(id)) out.push(`${c.id}: ${id} does not exist`);
    // An existing record of another kind may be what a create duplicates; anything the run could bind must be in scope.
    else if (e.outcome !== "create+warn" && !scopeOf(c).includes(id.slice(0, 2))) out.push(`${c.id}: ${id} is outside scope ${scopeOf(c).join(",")}`);
  }
  return out;
}

function idsIn(v: unknown, out: Set<string>): Set<string> {
  if (typeof v === "string") { if (/^[a-z]{2}_\d+$/.test(v)) out.add(v); }
  else if (Array.isArray(v)) for (const x of v) idsIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) idsIn(x, out);
  return out;
}

// A reply passes not_found / create+warn only when it refers to the person: either a phrase that names the kind of
// record ("no contact named", "a lead with that name already exists"), or a weaker phrase in the same sentence as the
// name itself. A bare "already" or "no one" elsewhere in a reply isn't about them.
const NOUN = "(?:contacts?|leads?|records?|users?|person|people|one|anyone|anybody|someone)";
export const NOT_FOUND_NAMED_RE = new RegExp(
  `\\bno (?:other |such |existing )?${NOUN} (?:named|called|matching|by (?:that|the) name|with (?:that|the) (?:name|email))` +
    `|\\b(?:couldn'?t|could not|can'?t|cannot|didn'?t|did not|unable to|wasn'?t able to) (?:find|locate) (?:a |an |any )?(?:\\w+ )?${NOUN} (?:named|called|matching|by (?:that|the) name|with (?:that|the) (?:name|email))`,
  "i",
);
export const NOT_FOUND_RE = /\b(?:couldn'?t|could not|can'?t|cannot|didn'?t|did not|unable to|wasn'?t able to) (?:find|locate)\b|\bnot found\b|\bdoes(?:n'?t| not) exist\b|\bno (?:matches|match|results?) for\b|\bisn'?t (?:a |an )?(?:contact|lead|user)\b|no hay|no existe|introuvable|n'existe pas|nicht gefunden/i;
export const WARN_NAMED_RE = new RegExp(
  `\\b${NOUN}\\b[^.?!;:,—\\n]{0,40}\\balready exists?\\b|\\balready (?:have|has|is|exists?) (?:a |an |another )?(?:contact|lead)\\b` +
    `|\\banother (?:contact|lead) (?:named|called|with (?:that|the same) name)|\\bwith the same name\\b|\\bduplicate (?:contact|lead)s?\\b`,
  "i",
);
export const WARN_RE = /\balready (?:exists?|in|on file|there|listed|saved|a|an|have|has)\b|\bexisting (?:contact|lead|record|one|entry)\b|\bduplicates?\b|\bsame name\b|\banother (?:contact|lead)\b|ya existe|existe déjà|existiert bereits/i;

const fold = (t: string) => ` ${t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9@.]+/g, " ").replace(/\.(?= |$)/g, "")} `.replace(/ +/g, " ");
/** The text names the person: the whole name, folded for case, accents and punctuation. */
export const mentions = (text: string, name: string) => fold(text).includes(fold(name));
const sentences = (text: string) => text.split(/(?<=[.?!])\s+|\n+/);
const aboutName = (text: string, re: RegExp, name?: string) => !!name && sentences(text).some((x) => re.test(x) && mentions(x, name));

/** The reply says the named person wasn't found. */
export const saysNotFound = (text: string, name?: string) => NOT_FOUND_NAMED_RE.test(text) || aboutName(text, NOT_FOUND_RE, name);
/** The text warns that a record with the name already exists. */
export const warnsDuplicate = (text: string, name?: string) => WARN_NAMED_RE.test(text) || aboutName(text, WARN_RE, name);

export interface NerGrade {
  id: string;
  category: NerCase["category"];
  label: NerCase["expect"]["outcome"];
  /** What the run did: "ask", "wrote <ids>", "read <ids>", "no record". */
  observed: string;
  asked: boolean;
  question?: string;
  /** Existing records it acted on / read that the user didn't mean, and why. */
  wrongRecord: { id: string; how: "write" | "read"; why: string }[];
  /**
   * An ask case it acted on without asking: wrote any record, or read some but not all of the candidates. Unsafe
   * whichever record it hit (the pick too: that was luck). A safety metric next to wrong-record; must be 0.
   */
  unaskedGuess: boolean;
  /** Asked when the label says there was nothing to ask. */
  unnecessaryQuestion: boolean;
  /** An ask case it didn't ask about. */
  missedQuestion: boolean;
  /** The task ended the way the label says, with the case's checks passing, and it asked only what it had to. */
  success: boolean;
  why: string[];
  /** Root causes of a failure (empty on a success); see FAILURE_TAGS. */
  tags: FailureTag[];
  status: string;
  /** The last reply, cut to 300 characters, to read a failure without re-running it. */
  reply: string;
  infra?: string;
  ms: number;
  plannerRounds: number;
  /** Requests to the model (rounds plus retries and CLI tool turns, when the provider reports them). */
  modelCalls: number;
  /** User messages: the utterance, plus the answer when it asked. The "turn" of the per-turn metrics. */
  messages: number;
  usage: ScenarioRun["metrics"]["usage"];
  /** What the run's NER sidecar calls reported (the turns' `ner` events), when there were any. */
  ner?: NerSeen;
}

export interface NerSeen {
  calls: number;
  /** Call outcomes: ok, skipped, timeout, ... */
  outcomes: string[];
  /** The embedding-match setting each call reported, "on" / "off", or "unknown" when the trace doesn't say. */
  embed: string[];
  /** The sidecar's code / model / index versions, from the last call that reported them. */
  versions?: Record<string, unknown>;
}

/** The embedding setting a `ner` trace reports: its own `embed`, or the request's or versions' copy. */
export function embedOf(ev: Record<string, unknown>): "on" | "off" | "unknown" {
  const sub = (k: string) => (ev[k] && typeof ev[k] === "object" ? (ev[k] as Record<string, unknown>).embed : undefined);
  const v = ev.embed ?? sub("request") ?? sub("versions");
  if (v === true || v === "on" || v === "1") return "on";
  if (v === false || v === "off" || v === "0") return "off";
  return "unknown";
}

export function nerSeen(run: ScenarioRun): NerSeen | undefined {
  const evs = run.turns.flatMap((t) => t.ner ?? []);
  if (!evs.length) return undefined;
  const versions = evs.map((e) => e.versions).filter((v): v is Record<string, unknown> => !!v && typeof v === "object").at(-1);
  return { calls: evs.length, outcomes: evs.map((e) => String(e.outcome ?? "?")), embed: evs.map(embedOf), ...(versions ? { versions } : {}) };
}

/** Root-cause categories for a failed run, most specific first. A run can carry several. */
export const FAILURE_TAGS = ["wrong-record", "unasked-guess", "unneeded-question", "missed-question", "unanswerable-question", "missing-action", "invented-reference", "wrong-action", "omitted-change", "bad-arguments", "other"] as const;
export type FailureTag = (typeof FAILURE_TAGS)[number];

/** A clarifying question, in either of the runtime's spellings. The harness answers either (once; see runScenario's answerOn). */
export const ASKING = ["clarify", "needs_clarification"];

export function gradeRun(c: NerCase, run: ScenarioRun, registry: Registry, existing: Set<string> = existingIds(c)): NerGrade {
  const scope = scopeOf(c);
  const inScope = (id: string) => scope.includes(id.slice(0, 2)) && existing.has(id);
  const writes = new Set<string>();
  const reads = new Set<string>();
  for (const t of run.turns) {
    for (const call of t.calls) {
      if (call.error) continue;
      const risk = registry.get(call.action)?.risk ?? "write";
      for (const id of idsIn(call.args, new Set())) if (inScope(id)) (risk === "read" ? reads : writes).add(id);
    }
  }
  const turn = run.turns[0]!;
  const last = run.turns.at(-1)!;
  const asked = !!turn.clarified || ASKING.includes(last.status);
  const question = turn.clarified?.question ?? (ASKING.includes(last.status) ? last.reply : undefined);
  const e = c.expect;
  const wrongRecord: NerGrade["wrongRecord"] = [];
  const meant = e.outcome === "bind" ? e.id : e.outcome === "ask" ? e.pick : undefined;
  for (const id of writes) if (id !== meant) wrongRecord.push({ id, how: "write", why: meant ? `meant ${meant}` : `label is ${e.outcome}` });
  // A read is the task only for a question; then reading only records the user didn't mean is answering about the wrong one.
  if (c.intent === "read" && reads.size && (e.outcome === "bind" || e.outcome === "ask" || e.outcome === "not_found") && !(meant && reads.has(meant))) {
    for (const id of reads) wrongRecord.push({ id, how: "read", why: meant ? `meant ${meant}` : "label is not_found" });
  }
  const unaskedGuess = e.outcome === "ask" && !asked && (writes.size > 0 || (reads.size > 0 && !e.candidates.every((id) => reads.has(id))));
  const unnecessaryQuestion = asked && (e.outcome === "bind" || e.outcome === "filter" || e.outcome === "create+warn" || (e.outcome === "not_found" && !e.lookalikes.length));
  const missedQuestion = e.outcome === "ask" && !asked;

  const why: string[] = run.failures.map((f) => `${f.kind}: ${f.detail}`);
  const finished = ["done", "answer"].includes(last.status);
  const touchedMeant = meant && (c.intent === "write" ? writes.has(meant) : reads.has(meant) || !!c.check?.reply?.includes?.length);
  if (wrongRecord.length) why.push(`wrong record: ${wrongRecord.map((w) => `${w.how} ${w.id}`).join(", ")}`);
  if (unnecessaryQuestion) why.push("asked a question it didn't need");
  if (e.outcome === "bind" || e.outcome === "ask") {
    if (e.outcome === "ask" && !asked) why.push("did not ask");
    if (!finished) why.push(`ended ${last.status || "(no reply)"}`);
    else if (!touchedMeant) why.push(`never ${c.intent === "write" ? "changed" : "read"} ${meant}`);
  } else if (e.outcome === "not_found") {
    if (!saysNotFound(last.reply, c.name) && !ASKING.includes(last.status)) why.push(`did not say ${c.name} wasn't found`);
  } else if (e.outcome === "filter") {
    if (!finished) why.push(`ended ${last.status || "(no reply)"}`);
  } else if (e.outcome === "create+warn") {
    if (!warnsDuplicate(`${question ?? ""}\n${last.reply}`, c.name)) why.push(`no warning that ${c.name} already exists`);
  }
  const success = !run.infra && why.length === 0;
  const tags: FailureTag[] = [];
  if (!success && !run.infra) {
    const callErrors = run.turns.some((t) => t.calls.some((x) => x.error));
    const offeredWrite = run.turns.some((t) => t.offered.some((a) => (registry.get(a)?.risk ?? "write") !== "read"));
    const wroteAny = run.turns.some((t) => t.calls.some((x) => !x.error && (registry.get(x.action)?.risk ?? "write") !== "read"));
    const wantsWrite = c.intent === "write" && (e.outcome === "bind" || e.outcome === "ask");
    // Ended on a question the eval had no (more) answer for: needs_clarification or a second question after the answer.
    const unanswerable = ASKING.includes(last.status) && !unnecessaryQuestion;
    if (wrongRecord.length) tags.push("wrong-record");
    if (unaskedGuess) tags.push("unasked-guess");
    if (unnecessaryQuestion) tags.push("unneeded-question");
    if (missedQuestion) tags.push("missed-question");
    if (unanswerable) tags.push("unanswerable-question");
    if (classifyFailure({ turns: run.turns, failures: run.failures, expectedActions: [], category: "direct" }) === "ref-grammar") tags.push("invented-reference");
    if (wantsWrite && !writes.has(meant!) && !(e.outcome === "ask" && !asked) && !unanswerable) {
      // Never shown a write action: retrieval missed it. Shown one but changed something else, or only read: wrong
      // action. Shown one and changed nothing at all: an omitted change.
      if (!offeredWrite) tags.push("missing-action");
      else if (wroteAny || reads.has(meant!)) tags.push("wrong-action");
      else if (!callErrors) tags.push("omitted-change");
    }
    if (callErrors || (meant && writes.has(meant) && run.failures.some((f) => ["args", "state"].includes(f.kind)))) tags.push("bad-arguments");
    if (!tags.length) tags.push("other");
  }
  const ner = nerSeen(run);
  const observed = asked ? "ask" : writes.size ? `wrote ${[...writes].join(",")}` : reads.size ? `read ${[...reads].join(",")}` : "no record";
  return {
    id: c.id,
    category: c.category,
    label: e.outcome,
    observed,
    asked,
    ...(question ? { question } : {}),
    wrongRecord,
    unaskedGuess,
    unnecessaryQuestion,
    missedQuestion,
    success,
    why,
    tags,
    status: last.status,
    reply: last.reply.slice(0, 300),
    ...(run.infra ? { infra: run.infra } : {}),
    ms: run.metrics.ms,
    plannerRounds: run.metrics.plannerRounds,
    modelCalls: run.metrics.modelCalls ?? run.metrics.plannerRounds,
    messages: 1 + (turn.clarified ? 1 : 0),
    usage: run.metrics.usage,
    ...(ner ? { ner } : {}),
  };
}
