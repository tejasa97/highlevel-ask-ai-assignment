/**
 * Ask-scoped NER: when the Ask app calls the sidecar, names link only against Ask's own records.
 *
 * The sidecar's default index is the ~2M-record seed built for GLiNER fine-tuning; other callers (fine-tuning,
 * standalone eval) keep using it. The Ask app instead registers its own entity names as scope "ask" (PUT
 * /v1/scopes/ask) and sends `scope: "ask"` with the index version on every extract. The index is rebuilt from the
 * store's current rows on each turn: when they changed (a create, update or delete), the new version is pushed before
 * extracting. No database call happens during linking; the store is only read to build the name list.
 *
 * Fail closed: if the scope can't be registered, the sidecar rejects it, or a returned id isn't one of Ask's records,
 * this throws NerSidecarError and the turn proceeds with no NER hints. It never falls back to the big index.
 */
import { createHash } from "node:crypto";
import type { Store } from "../store/db.js";
import { extractAndLink, NerSidecarError, nerSidecarUrl } from "./ner_client.js";
import type { NerLinkedSpan, NerSidecarRequest, NerSidecarResponse } from "./ner_sidecar_contract.js";

export const ASK_SCOPE = "ask";

export interface AskEntity { id: string; name: string; entity: "contact" | "lead" | "user" | "company"; detail?: string }

type Row = { id: string; name?: unknown; company?: unknown; email?: unknown; domain?: unknown };
const TABLES: [table: string, entity: AskEntity["entity"]][] = [["contacts", "contact"], ["leads", "lead"], ["companies", "company"], ["users", "user"]];

/** Every named contact, lead, company and user in the store: the whole Ask index. */
export function askEntities(store: Store): AskEntity[] {
  const have = new Set(store.tables());
  const out: AskEntity[] = [];
  for (const [table, entity] of TABLES) {
    if (!have.has(table)) continue;
    for (const r of store.all<Row>(table)) {
      if (typeof r.name !== "string" || !r.name.trim()) continue;
      const detail = [r.company, r.email, r.domain].find((v): v is string => typeof v === "string" && !!v.trim());
      out.push({ id: r.id, name: r.name, entity, ...(detail ? { detail } : {}) });
    }
  }
  return out;
}

export const askIndexVersion = (entities: AskEntity[]) => createHash("sha1").update(JSON.stringify(entities)).digest("hex").slice(0, 16);

/** Drop anything that isn't one of Ask's records. A span whose only ids are foreign becomes a miss. */
export function keepAskIds(spans: NerLinkedSpan[], ids: ReadonlySet<string>): NerLinkedSpan[] {
  return spans.map((s) => {
    const candidates = s.candidates?.filter((c) => ids.has(c.id));
    const linkedOk = !s.linkedId || ids.has(s.linkedId);
    if (linkedOk && (candidates?.length ?? 0) === (s.candidates?.length ?? 0)) return s;
    const { linkedId: _l, linkedEntity: _e, candidates: _c, ...rest } = s;
    return { ...rest, status: "miss" };
  });
}

export interface AskScopeOpts { url?: string; signal?: AbortSignal; fetchImpl?: typeof fetch }

/** Last version this process pushed, per sidecar URL. */
const pushed = new Map<string, string>();

async function pushScope(entities: AskEntity[], version: string, opts: AskScopeOpts, base: string): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1/scopes/${ASK_SCOPE}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version, entities }), signal: opts.signal });
  } catch (err) {
    throw new NerSidecarError(`NER sidecar unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  if (!res.ok) throw new NerSidecarError(`NER scope ${ASK_SCOPE} registration failed: HTTP ${res.status}`);
  pushed.set(base, version);
}

/** The Ask app's only way into the sidecar: extract linked against Ask's own records. */
export async function askScopedExtract(store: Store, request: Omit<NerSidecarRequest, "scope" | "scopeVersion">, opts: AskScopeOpts = {}): Promise<NerSidecarResponse> {
  const base = opts.url ?? nerSidecarUrl();
  const entities = askEntities(store);
  const version = askIndexVersion(entities);
  if (pushed.get(base) !== version) await pushScope(entities, version, opts, base);
  const scoped = { ...request, scope: ASK_SCOPE, scopeVersion: version };
  let res: NerSidecarResponse;
  try {
    res = await extractAndLink(scoped, opts);
  } catch (err) {
    // 409: the sidecar restarted or holds an older version. Push once and retry; a second failure ends NER for this turn.
    if (!(err instanceof NerSidecarError) || !/HTTP 409/.test(err.message)) throw err;
    await pushScope(entities, version, opts, base);
    res = await extractAndLink(scoped, opts);
  }
  if (res.scope !== ASK_SCOPE) throw new NerSidecarError(`NER sidecar answered from scope ${res.scope ?? "default"}, not ${ASK_SCOPE}`);
  return { ...res, spans: keepAskIds(res.spans, new Set(entities.map((e) => e.id))) };
}

/** Tests: forget what was pushed. */
export const resetAskScopeCache = () => pushed.clear();
