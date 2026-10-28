/**
 * Thin TypeScript facade for the Python GLiNER NER sidecar.
 *
 * Feature flag: NER_SIDECAR=1 (or ASK_NER=1). Default off.
 * URL: NER_SIDECAR_URL (default http://127.0.0.1:8091).
 *
 * Does not call Store resolvers. Ambiguous spans never auto-pick candidates[0].
 */
import type { Mention } from "./mentions.js";
import {
  ambiguousOptions,
  clarifyFromAmbiguousSpan,
  isUniqueLink,
  type NerClarifyReply,
  type NerLinkedSpan,
  type NerSidecarRequest,
  type NerSidecarResponse,
} from "./ner_sidecar_contract.js";

const DEFAULT_URL = "http://127.0.0.1:8091";
const EXTRACT_PATH = "/v1/extract";

/** True when ask-path should call the NER sidecar. */
export function nerSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NER_SIDECAR ?? env.ASK_NER;
  return v === "1" || v === "true" || v === "yes";
}

export function nerSidecarUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.NER_SIDECAR_URL ?? DEFAULT_URL).trim().replace(/\/$/, "");
  return raw || DEFAULT_URL;
}

export class NerSidecarError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NerSidecarError";
  }
}

/** POST /v1/extract against the sidecar. */
export async function extractAndLink(
  request: NerSidecarRequest,
  opts: { url?: string; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<NerSidecarResponse> {
  const base = opts.url ?? nerSidecarUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${base}${EXTRACT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request),
      signal: opts.signal,
    });
  } catch (err) {
    throw new NerSidecarError(`NER sidecar unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NerSidecarError(`NER sidecar HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as NerSidecarResponse;
  if (!json || !Array.isArray(json.spans)) {
    throw new NerSidecarError("NER sidecar response missing spans[]");
  }
  return json;
}

/** Map PoC / GLiNER labels onto CRM entity names used by Mention / retrieval. */
export function entityForSpan(span: NerLinkedSpan): string | undefined {
  if (span.linkedEntity) return span.linkedEntity;
  const fromCand = span.candidates?.find((c) => c.entity)?.entity;
  if (fromCand) return fromCand;
  switch (span.label) {
    case "company":
      return "company";
    case "team":
      return "team";
    case "contact":
    case "lead":
    case "user":
      return span.label;
    case "person":
      return "contact";
    default:
      return undefined;
  }
}

/**
 * Turn linked / ambiguous NER spans into Mention[]. Misses and rule-only
 * (email/phone/id without CRM entity) are omitted so existing create/search
 * behavior still owns unknowns.
 */
export function spansToMentions(spans: NerLinkedSpan[]): Mention[] {
  const out: Mention[] = [];
  for (const span of spans) {
    if (span.status === "miss") continue;
    const entity = entityForSpan(span);
    if (!entity) continue;
    if (span.status === "ambiguous") {
      const count = Math.max(2, span.candidates?.length ?? 2);
      if (!out.some((m) => m.name === span.text && m.entity === entity)) {
        out.push({
          name: span.text,
          entity,
          count,
          ambiguous: true,
          candidates: span.candidates?.map((c) => ({
            id: c.id,
            name: c.name,
            detail: c.detail,
            entity: c.entity,
          })),
          method: span.method,
          score: span.score,
        });
      }
      continue;
    }
    if (!isUniqueLink(span)) continue;
    if (!out.some((m) => m.name === span.text && m.entity === entity)) {
      out.push({
        name: span.text,
        entity,
        count: 1,
        linkedId: span.linkedId,
        method: span.method,
        score: span.score,
      });
    }
  }
  return out;
}

/**
 * Prefer NER-linked / NER-ambiguous mentions; keep Title-Case Store mentions
 * for names the sidecar did not cover.
 */
export function mergeMentions(ner: Mention[], legacy: Mention[]): Mention[] {
  const covered = new Set(ner.map((m) => normKey(m.name)));
  const kept = legacy.filter((m) => !covered.has(normKey(m.name)));
  return [...ner, ...kept];
}

const normKey = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

function normSurface(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when candidates look like near-miss suggestions (typo/partial), not exact-name dupes. */
function isNearMissSuggestion(span: NerLinkedSpan): boolean {
  const cands = span.candidates ?? [];
  if (cands.length === 0) return false;
  const surface = normSurface(span.text);
  const nameDiffers = cands.some((c) => normSurface(c.name) !== surface);
  const softScore = typeof span.score === "number" && span.score < 0.9;
  const embedNonExact =
    span.method === "embed" && cands.some((c) => normSurface(c.name) !== surface);
  return nameDiffers || softScore || embedNonExact;
}

/** First ambiguous span → planner-style clarify reply (never picks a winner). */
export function clarifyFromSpans(spans: NerLinkedSpan[]): NerClarifyReply | undefined {
  for (const span of spans) {
    if (span.status !== "ambiguous") continue;
    const entity = entityForSpan(span) ?? "record";
    const n = span.candidates?.length ?? 0;
    const firstName = span.candidates?.[0]?.name;
    let text: string;
    if (n > 0 && isNearMissSuggestion(span)) {
      text =
        n === 1 && firstName
          ? `Did you mean ${firstName}?`
          : `Did you mean one of these instead of ${span.text}?`;
    } else if (n > 0) {
      text = `I found ${n} matching ${entity.replaceAll("_", " ")} records named ${span.text}. Which one did you mean?`;
    } else {
      text = `Which ${entity.replaceAll("_", " ")} did you mean by ${span.text}?`;
    }
    return clarifyFromAmbiguousSpan(span, text) ?? { status: "clarify", text, options: ambiguousOptions(span) };
  }
  return undefined;
}

export { ambiguousOptions, clarifyFromAmbiguousSpan, isUniqueLink };
