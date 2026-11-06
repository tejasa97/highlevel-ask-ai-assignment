// A "which one?" question as stored state, not as text the next message is glued onto. The question remembers the
// plan it paused, the step and argument it asked about, and the candidates it offered (each behind an opaque token).
// An answer, a click or the user's words, is matched against those candidates only, in code; the stored plan then
// resumes from the paused step with the pick bound as user-selected. The planner is never asked again.
//
// Status moves only through the methods here: awaiting → resolved | expired | cancelled | superseded. Nothing else
// can change it, and a settled question never reopens: answering it again gives back what the first answer did.
import { randomBytes } from "node:crypto";
import { type CompiledPlan, planDigest } from "../core/compile.js";
import type { Approval } from "../core/execute.js";
import { type IdentityBinding, type IdentityResolution, type MatchReason, optionLabel, type RankedCandidate } from "../core/identity.js";
import type { Tier } from "../planner/types.js";
import { norm } from "../registry/helpers.js";
import type { LookupWhere } from "../registry/registry.js";

export type ClarificationStatus = "awaiting" | "resolved" | "expired" | "cancelled" | "superseded";

export interface ClarificationOption {
  /** Opaque, random, and only meaningful to the question that issued it. */
  token: string;
  id: string;
  label: string;
  matchReason: MatchReason;
}

/** What the UI is shown: labels to read and tokens to send back. Never record ids. */
export interface ClarificationView {
  id: string;
  round: number;
  options: { token: string; label: string }[];
}

export interface PendingClarification {
  readonly id: string;
  readonly turnId: string;
  readonly planHash: string;
  readonly stepId: string;
  /** The action argument the step feeds ("contactId"), when one does. */
  readonly argument?: string;
  readonly entity: string;
  /** The name the user gave, as asked about. */
  readonly text: string;
  readonly candidates: readonly ClarificationOption[];
  readonly round: number;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly status: ClarificationStatus;
}

/** Where the question came from: the resolver binding NER-hinted lookups at plan time, or a lookup at execution. */
export type ClarificationSource = "resolver" | "lookup" | "look";

/** Everything needed to resume; kept beside the record, never sent to the client. */
export interface Paused {
  source: ClarificationSource;
  plan: CompiledPlan;
  /** The user's words for the paused request (qualifiers for the resolver, request/said for execution). */
  request: string;
  said: string;
  /** The lookup's scope as it was resolved, so the binding and its revalidation look in the same place. */
  where?: LookupWhere;
  ranked: RankedCandidate[];
  /** Other keys the user may answer with (an email), by candidate id, from the store when the question was asked. */
  keys: Record<string, string[]>;
  /**
   * The paused run's execution id and approvals. The resumed run reuses them: a write that already ran before the
   * pause is replayed from the ledger, never done again, and an approval already given still holds.
   */
  executionId?: string;
  approvals?: Approval[];
  /**
   * Set for a question a look asked (source "look"): the message to plan again on the answer, with the pick and any
   * earlier ones bound, since the look's plan isn't the one that does the request.
   */
  replan?: { message: string; tier: Tier; answering?: string; picks: IdentityBinding[] };
}

export interface OpenInput extends Paused {
  turnId: string;
  stepId: string;
  argument?: string;
  resolution: Pick<IdentityResolution, "entity" | "text" | "candidates">;
  /** Carried over from a question this one replaces (a pick that failed revalidation). */
  round?: number;
}

/** What one answer came to. The caller acts on it; the state has already moved. */
export type Answer =
  | { kind: "picked"; clarification: PendingClarification; candidate: RankedCandidate; paused: Paused }
  | { kind: "again"; clarification: PendingClarification; why: "none" | "several"; matches: RankedCandidate[] }
  | { kind: "gave_up"; clarification: PendingClarification }
  | { kind: "cancelled"; clarification: PendingClarification }
  | { kind: "expired"; clarification: PendingClarification }
  | { kind: "superseded"; clarification: PendingClarification }
  /** Already answered: what the first answer replied, or nothing yet while it is still running. */
  | { kind: "replay"; clarification: PendingClarification; result?: unknown }
  | { kind: "refused"; reason: string };

export interface ClarifyConfig {
  ttlMs: number;
  /** Questions about one name, the first included, before giving up honestly. */
  maxRounds: number;
}

export function clarifyConfig(env: NodeJS.ProcessEnv = process.env): ClarifyConfig {
  const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { ttlMs: num(env.CLARIFY_TTL_MS, 15 * 60_000), maxRounds: num(env.CLARIFY_MAX_ROUNDS, 2) };
}

interface Entry {
  record: PendingClarification;
  paused: Paused;
  /** What the first answer replied, for an idempotent second answer. */
  result?: unknown;
  /** An expiry already reported to a message, so the next one is just planned. */
  noticed?: boolean;
}

/** One conversation's questions. Ids and tokens from any other store are unknown here, so they are refused. */
export class Clarifications {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly config: ClarifyConfig = clarifyConfig(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Asks a new question; one still awaiting is superseded, as only one question is open at a time. */
  open(input: OpenInput): PendingClarification {
    const open = this.awaiting();
    if (open) this.move(open.record.id, "superseded");
    const id = `clr_${randomBytes(9).toString("base64url")}`;
    const record: PendingClarification = Object.freeze({
      id,
      turnId: input.turnId,
      planHash: planDigest(input.plan),
      stepId: input.stepId,
      ...(input.argument ? { argument: input.argument } : {}),
      entity: input.resolution.entity,
      text: input.resolution.text,
      candidates: Object.freeze(input.resolution.candidates.map((c) => Object.freeze({ token: randomBytes(12).toString("base64url"), id: c.id, label: optionLabel(c), matchReason: c.matchReason }))),
      round: input.round ?? 1,
      expiresAt: this.now() + this.config.ttlMs,
      status: "awaiting" as const,
    });
    const { turnId: _t, stepId: _s, argument: _a, resolution: _r, round: _n, ...paused } = input;
    this.entries.set(id, { record, paused });
    return record;
  }

  /** The question still waiting for an answer, if one is (an expired one is marked so on the way). */
  awaiting(): { record: PendingClarification; paused: Paused } | undefined {
    for (const e of this.entries.values()) {
      if (e.record.status !== "awaiting") continue;
      if (this.now() >= e.record.expiresAt) {
        this.move(e.record.id, "expired");
        continue;
      }
      return e;
    }
    return undefined;
  }

  get(id: string): PendingClarification | undefined {
    return this.entries.get(id)?.record;
  }

  view(c: PendingClarification): ClarificationView {
    return { id: c.id, round: c.round, options: c.candidates.map(({ token, label }) => ({ token, label })) };
  }

  /** A click: the question's id and one of its tokens. Anything else is refused. */
  choose(clarificationId: string, optionToken: string): Answer {
    const e = this.entries.get(clarificationId);
    if (!e) return { kind: "refused", reason: "unknown clarification" };
    const option = e.record.candidates.find((c) => c.token === optionToken);
    if (!option) return { kind: "refused", reason: "unknown option" };
    const settled = this.settled(e);
    if (settled) return settled;
    return this.pick(e, e.paused.ranked.find((c) => c.id === option.id)!);
  }

  /** The user's words while a question is open: matched against its candidates only. */
  reply(text: string): Exclude<Answer, { kind: "refused" }> | undefined {
    const e = this.awaiting();
    if (!e) {
      // Expired since it was asked: say so, so the message is planned fresh.
      const late = [...this.entries.values()].find((x) => x.record.status === "expired" && !x.noticed);
      if (late) {
        late.noticed = true;
        return { kind: "expired", clarification: late.record };
      }
      return undefined;
    }
    if (NONE.test(text.trim())) return { kind: "cancelled", clarification: this.move(e.record.id, "cancelled") };
    // A message with its own instruction is a new request, even when it names one of the candidates ("Email Acme about
    // the renewal" while "which Sarah? Acme / Brightside" is open): only an answer-shaped reply is matched as a pick.
    if (readsAsRequest(text)) return { kind: "superseded", clarification: this.move(e.record.id, "superseded") };
    const matches = matchCandidates(text, e.paused.ranked, e.paused.keys);
    if (matches.length === 1) return this.pick(e, matches[0]!);
    if (e.record.round >= this.config.maxRounds) return { kind: "gave_up", clarification: this.move(e.record.id, "cancelled") };
    const record = Object.freeze({ ...e.record, round: e.record.round + 1 });
    e.record = record;
    return { kind: "again", clarification: record, why: matches.length ? "several" : "none", matches };
  }

  /** "None of these": closes the question, nothing written. */
  cancel(clarificationId: string): Answer {
    const e = this.entries.get(clarificationId);
    if (!e) return { kind: "refused", reason: "unknown clarification" };
    return this.settled(e) ?? { kind: "cancelled", clarification: this.move(clarificationId, "cancelled") };
  }

  /** Remembers what the answer replied, so answering again replays it. */
  remember(clarificationId: string, result: unknown): void {
    const e = this.entries.get(clarificationId);
    if (e && e.record.status !== "awaiting") e.result = result;
  }

  /** A pick that turned out stale: the question it answered is replaced by a new one, never reopened. */
  replace(clarificationId: string): void {
    const e = this.entries.get(clarificationId);
    if (e?.record.status === "resolved") e.record = Object.freeze({ ...e.record, status: "superseded" as const });
  }

  clear(): void {
    this.entries.clear();
  }

  private settled(e: Entry): Answer | undefined {
    if (e.record.status === "awaiting" && this.now() >= e.record.expiresAt) this.move(e.record.id, "expired");
    switch (e.record.status) {
      case "awaiting":
        return undefined;
      case "expired":
        return { kind: "expired", clarification: e.record };
      case "superseded":
        return { kind: "superseded", clarification: e.record };
      default:
        return { kind: "replay", clarification: e.record, ...(e.result !== undefined ? { result: e.result } : {}) };
    }
  }

  private pick(e: Entry, candidate: RankedCandidate): Extract<Answer, { kind: "picked" }> {
    return { kind: "picked", clarification: this.move(e.record.id, "resolved"), candidate, paused: e.paused };
  }

  private move(id: string, status: Exclude<ClarificationStatus, "awaiting">): PendingClarification {
    const e = this.entries.get(id)!;
    if (e.record.status !== "awaiting") throw new Error(`clarification ${id} is already ${e.record.status}`);
    e.record = Object.freeze({ ...e.record, status });
    return e.record;
  }
}

const NONE = /^(none( of (these|them|those))?|neither( of (these|them|those))?|no(pe)?,? none|not (any|either) of (these|them|those)|cancel|never ?mind|forget it)\b[.! ]*$/i;
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4, fifth: 5, "5th": 5, five: 5 };
/** Opening words of a fresh instruction, not of an answer. */
const VERBS = /^(please |can you |could you |now |also |and |then |ok(ay)?,? )?(create|add|make|send|email|text|sms|message|show|list|find|search|get|delete|remove|archive|update|change|rename|move|assign|schedule|book|tag|untag|merge|cancel|refund|invoice|call|set|mark|close|open|how|what|who|which|when|where|why|is|are|do|does)\b/i;

/** How an answer opens ("the one at Acme?", "her gmail one?"): a question that starts so is still an answer. */
const ANSWER_OPENER = /^(the|that|this|her|his|him|them|it|option|number|no\.|#|\d)\b/i;

/** The user's words as a new request rather than an answer: an instruction or a question of several words. */
export function readsAsRequest(text: string): boolean {
  const t = text.trim();
  const words = t.split(/\s+/).length;
  return words >= 3 && (VERBS.test(t) || (t.endsWith("?") && !ANSWER_OPENER.test(t)));
}

/**
 * The stored candidates the user's words pick out, deterministically: a position ("the second one", "2"), the exact
 * label, name, id or email, or a detail that only some of them have ("the one at Acme"). Nothing outside the list.
 */
export function matchCandidates(text: string, candidates: readonly RankedCandidate[], keys: Record<string, string[]> = {}): RankedCandidate[] {
  const raw = text.trim().toLowerCase().replace(/[.!]+$/, "");
  const said = norm(text);
  if (!said && !raw) return [];
  // A position in the list.
  const pos = raw.match(/^(?:the |option |number |no\.? |#)?(\d+|first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|one|two|three|four|five|last)(?: one| option)?(?: please)?$/);
  if (pos) {
    const n = pos[1] === "last" ? candidates.length : ORDINALS[pos[1]!] ?? Number(pos[1]);
    return n >= 1 && n <= candidates.length ? [candidates[n - 1]!] : [];
  }
  // The exact label, name, id or another key: equal, never contained.
  const exact = candidates.filter((c) => [optionLabel(c), c.name, c.id, ...(keys[c.id] ?? [])].some((k) => k.toLowerCase() === raw || (norm(k) !== "" && norm(k) === said)));
  if (exact.length) return exact;
  // "Not the one at Brightside" names a candidate to rule it out: never a pick by what it mentions.
  if (NEGATION.test(said)) return [];
  // A word or detail that only some candidates have, said as whole words.
  const padded = ` ${said} `;
  const partsOf = (c: RankedCandidate) => [c.name, ...(c.detail ?? "").split(","), ...(keys[c.id] ?? [])].map((p) => norm(p)).filter((p) => p.length > 1);
  const shared = (p: string) => candidates.every((c) => partsOf(c).includes(p));
  const emails = (c: RankedCandidate) => (keys[c.id] ?? []).filter((k) => k.includes("@")).map((k) => k.toLowerCase());
  const parts = candidates.filter((c) => emails(c).some((e) => raw.includes(e)) || partsOf(c).some((p) => !shared(p) && padded.includes(` ${p} `)));
  if (parts.length) return parts;
  // Last, in a short answer, a distinctive word: one only a single candidate has, and not filler ("the Google listing"
  // for Maple Dental google / yelp). A word two of them share tells nothing apart, and words pointing at different
  // candidates leave it open: either way the question is asked again.
  const told = said.split(" ");
  if (told.length > ANSWER_WORDS) return [];
  // An email's parts are words too: "the gmail one" is sjohnson@gmail.example.
  const wordsOf = (c: RankedCandidate) => [c.name, ...(c.detail ?? "").split(","), ...(keys[c.id] ?? [])].flatMap((p) => norm(p.replace(/[@._+-]/g, " ")).split(" "));
  const all = candidates.map((c) => new Set(wordsOf(c).filter((w) => w.length > 2 && !FILLER.has(w))));
  const distinctive = told.filter((w) => !FILLER.has(w) && all.filter((ws) => ws.has(w)).length === 1);
  return candidates.filter((_, i) => distinctive.some((w) => all[i]!.has(w)));
}

/** Most words a reply can have and still be matched by a single word in it. */
const ANSWER_WORDS = 6;
const NEGATION = /\b(not|no|nor|neither|except|isnt|arent|dont|wasnt)\b/;
const FILLER = new Set([
  "the", "one", "ones", "and", "with", "from", "for", "that", "this", "these", "those", "who", "which", "please", "his", "her", "him", "she", "they",
  "them", "its", "our", "your", "their", "was", "are", "use", "mean", "meant", "want", "guess", "think", "yes", "yeah", "okay", "sure", "just",
  "other", "listing", "record", "contact", "person", "company", "account",
]);
