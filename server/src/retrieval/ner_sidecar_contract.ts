/**
 * Phase 0/1 NER sidecar wire contract (types only).
 *
 * TypeScript facade: ner_client.ts. Wired into planTurn when NER_SIDECAR=1
 * (or ASK_NER=1). Ambiguous spans clarify before the planner LLM.
 *
 * Standing rules:
 * - The sidecar must NOT make live CRM/DB calls to resolve entities. Linking
 *   uses an in-memory / prebuilt index only (exact map ± ANN).
 * - Ambiguous spans → clarify. Never auto-resolve a PoC top linked hit into
 *   writes when status is "ambiguous" (PoC LinkResult may still set `linked`
 *   to the top hit; that must not become a write binding).
 * - Canonical linkedId values are Store ids (`ct_`, `ld_`, `us_`, `co_`, …).
 *   PoC corpus ids (`pe_…`) must not appear as canonical linkedId on this wire.
 * - This file freezes the request/response shape only.
 *
 * Grounding: ask-ai-ner-poc/docs/integration-ask-ai-repo.md; Clarification in
 * server/src/core/execute.ts; Candidate in server/src/registry/registry.ts;
 * clarify reply SSE in server/src/server/conversation.ts; TurnOutcome reply in
 * server/src/planner/turn.ts.
 */

/** Store entity id prefixes used as canonical linkedId / candidate.id values. */
export type StoreIdPrefix = "ct_" | "ld_" | "us_" | "co_" | "tm_";

/**
 * Span labels from GLiNER / rule extractors. CRM entity mapping (contact|lead|
 * user|company) is optional on the span when the sidecar can decide; otherwise
 * the TypeScript facade maps person → contact|lead|user using context.
 */
export type NerSpanLabel =
  | "person"
  | "company"
  | "email"
  | "phone"
  | "id"
  | "team"
  | "product"
  | "contact"
  | "lead"
  | "user";

/** How the sidecar linked a span against its index. */
export type NerLinkMethod = "exact" | "embed" | "edit" | "rule";

/** Per-span link outcome. Never treat "ambiguous" as unique. */
export type NerSpanStatus = "linked" | "ambiguous" | "miss";

/** One candidate when the span is ambiguous (or listed for debugging). */
export interface NerCandidate {
  /** Store id (`ct_…` / `ld_…` / `us_…` / `co_…`). Not PoC `pe_…`. */
  id: string;
  name: string;
  /** Optional score from exact/embed/edit linking (higher = better). */
  score?: number;
  /** Optional CRM entity type for this candidate. */
  entity?: string;
  /** Optional qualifier detail (mirrors Candidate.detail for clarify options). */
  detail?: string;
}

/**
 * One extracted + linked span in the utterance.
 *
 * Offsets are UTF-16 code unit indices into `utterance` (JS string indexing),
 * half-open [start, end), matching `utterance.slice(start, end) === text`
 * when the sidecar and facade agree on encoding.
 */
export interface NerLinkedSpan {
  text: string;
  label: NerSpanLabel;
  start: number;
  end: number;
  status: NerSpanStatus;
  /**
   * Set only when status === "linked" (unique hit). Must be a Store id.
   * Must be absent (or ignored by consumers) when status is "ambiguous" or "miss".
   */
  linkedId?: string;
  /** CRM entity for the unique link, when known (contact|lead|user|company|…). */
  linkedEntity?: string;
  /** Present when status === "ambiguous"; may be empty for miss. */
  candidates?: NerCandidate[];
  method?: NerLinkMethod;
  /** Best match score; informational. Must not drive auto-commit on ambiguous. */
  score?: number;
}

/** Sidecar extract+link request. Keep minimal; optional ask-path context. */
export interface NerSidecarRequest {
  /** Correlation id for logs / SSE turn tracing. */
  requestId: string;
  /** Raw user utterance (same string the ask path would pass to mentions). */
  utterance: string;
  /** Optional ask actor (POST /api/ask actorId). */
  actorId?: string;
  /** Optional planner tier (POST /api/ask tier). */
  tier?: "fast" | "strong";
}

/** Sidecar extract+link response. */
export interface NerSidecarResponse {
  requestId: string;
  spans: NerLinkedSpan[];
  /** Optional sidecar/model version string for debugging. */
  model?: string;
  /** Wall time in ms if the sidecar reports it. */
  latencyMs?: number;
}

/**
 * Clarify-reply payload aligned with existing assignment shapes.
 *
 * Planner early clarify (TurnOutcome):
 *   { kind: "reply", status: "clarify", text, options?: string[] }
 *   — see server/src/planner/turn.ts TurnOutcome
 *
 * Execute multi-hit:
 *   Clarification { stepId, entity, name, candidates: Candidate[] }
 *   Candidate { id, name, detail?, inactive? } — registry/registry.ts
 *   RunStatus / StepStatus includes "needs_clarification"
 *
 * Conversation SSE:
 *   emit("reply", { status, text, options?, … })
 *   where status is "clarify" | "needs_clarification" (among others)
 *   and options are string labels derived from candidates:
 *   `c.detail ? \`${c.name} (${c.detail})\` : c.name`
 *   — see conversation.ts run / finish
 */
export interface NerClarifyReply {
  status: "clarify" | "needs_clarification";
  text: string;
  /** Display labels for the client; same string[] as TurnOutcome / finish options. */
  options?: string[];
  /**
   * Optional structured Clarification when the hit came from an execute resolve
   * step. Field names match execute.ts Clarification exactly.
   */
  clarification?: {
    stepId: string;
    entity: string;
    name: string;
    candidates: Array<{
      id: string;
      name: string;
      detail?: string;
      inactive?: string;
    }>;
  };
}

/** True when a unique Store link may be used (never for ambiguous/miss). */
export function isUniqueLink(span: NerLinkedSpan): boolean {
  return span.status === "linked" && typeof span.linkedId === "string" && span.linkedId.length > 0;
}

/**
 * Map ambiguous span candidates to clarify option strings, matching
 * conversation.ts: `c.detail ? \`${c.name} (${c.detail})\` : c.name`.
 * Does not pick a winner.
 */
export function ambiguousOptions(span: NerLinkedSpan): string[] {
  if (span.status !== "ambiguous" || !span.candidates?.length) return [];
  return span.candidates.map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name));
}

/**
 * Build a planner-style clarify reply from an ambiguous span.
 * Consumers must not auto-select candidates[0].
 */
export function clarifyFromAmbiguousSpan(
  span: NerLinkedSpan,
  text = "Which one did you mean?",
): NerClarifyReply | undefined {
  if (span.status !== "ambiguous") return undefined;
  const options = ambiguousOptions(span);
  return {
    status: "clarify",
    text,
    ...(options.length ? { options } : {}),
  };
}
