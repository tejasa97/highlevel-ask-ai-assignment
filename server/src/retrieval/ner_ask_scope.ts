/**
 * Ask-scoped NER: when the Ask app calls the sidecar, names link only against Ask's own records.
 *
 * The sidecar's default index is the ~2M-record seed built for GLiNER fine-tuning; other callers (fine-tuning,
 * standalone eval) keep using it. The Ask app instead registers its own entity names as scope "ask" (PUT
 * /v1/scopes/ask) and sends `scope: "ask"` with the index version on every extract. The name list and its version
 * are cached per store and rebuilt only after a write (the store's change counter moved); when the version changed,
 * it is pushed before extracting. The push has its own budget (NER_SCOPE_TIMEOUT_MS, default 10000) and keeps going
 * when the turn stops waiting for it, so a slow build costs one turn its hints, not every turn a re-push. No database
 * call happens during linking; the store is only read to build the name list.
 *
 * Fail closed: if the scope can't be registered, the sidecar rejects it, or a returned id isn't one of Ask's records,
 * this throws NerSidecarError and the turn proceeds with no NER hints. It never falls back to the big index.
 */
import { createHash } from "node:crypto";
import type { Store } from "../store/db.js";
import { extractAndLink, fetchFailure, httpFailure, nerEmbed, NerSidecarError, nerLog, nerSidecarUrl } from "./ner_client.js";
import { describeIssues, type NerLinkedSpan, type NerSidecarRequest, type NerSidecarResponse, nerScopeResponseSchema } from "./ner_sidecar_contract.js";

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

interface AskIndex { changes: number; entities: AskEntity[]; version: string; ids: ReadonlySet<string> }
const indexes = new WeakMap<Store, AskIndex>();

/** askEntities + askIndexVersion, recomputed only when the store has been written to since. */
export function askIndex(store: Store): AskIndex {
  const changes = store.changes();
  const got = indexes.get(store);
  if (got && got.changes === changes) return got;
  const entities = askEntities(store);
  const index = { changes, entities, version: askIndexVersion(entities), ids: new Set(entities.map((e) => e.id)) };
  indexes.set(store, index);
  return index;
}

const intEnv = (v: string | undefined, fallback: number) => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
/** Budget for one scope push, apart from the turn's NER timeout: building a big scope can take longer than a turn waits. */
export const nerScopeTimeoutMs = (env: NodeJS.ProcessEnv = process.env) => intEnv(env.NER_SCOPE_TIMEOUT_MS, 10_000);

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

export interface AskScopeOpts { url?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; scopeTimeoutMs?: number }

/** Last version this process pushed, per sidecar URL. */
const pushed = new Map<string, string>();
/** The push in flight, per sidecar URL: a second turn for the same version waits on it instead of pushing again. */
const inflight = new Map<string, { version: string; done: Promise<void> }>();

/** Whether a scope push to this sidecar is still running (a turn that timed out waiting on it isn't the sidecar's fault). */
export const askScopePushPending = (base = nerSidecarUrl()) => inflight.has(base);

async function putScope(entities: AskEntity[], version: string, opts: AskScopeOpts, base: string, signal: AbortSignal): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let json: unknown;
  try {
    const res = await fetchImpl(`${base}/v1/scopes/${ASK_SCOPE}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version, entities }), signal });
    if (!res.ok) throw await httpFailure(res, `NER scope ${ASK_SCOPE} registration failed`);
    json = await res.json().catch(() => undefined);
  } catch (err) {
    if (err instanceof NerSidecarError) throw err;
    throw fetchFailure(err, base, signal);
  }
  const parsed = nerScopeResponseSchema.safeParse(json);
  if (!parsed.success) throw new NerSidecarError(`NER scope ${ASK_SCOPE} registration answer breaks the contract: ${describeIssues(parsed.error)}`, "invalid");
  if (parsed.data.scope !== ASK_SCOPE || parsed.data.version !== version) throw new NerSidecarError(`NER sidecar registered ${parsed.data.scope}@${parsed.data.version}, not ${ASK_SCOPE}@${version}`, "invalid");
  pushed.set(base, version);
}

/** Rejects as soon as the signal aborts; `p` itself keeps running. */
const waitFor = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> =>
  !signal ? p : signal.aborted ? Promise.reject(signal.reason) : new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });

/**
 * Push this version unless it is the one pushed. The PUT runs on its own budget, not the turn's: if the turn stops
 * waiting, the push carries on and the next turn finds it done (or joins it while it runs).
 */
async function pushScope(entities: AskEntity[], version: string, opts: AskScopeOpts, base: string): Promise<void> {
  let job = inflight.get(base);
  if (!job || job.version !== version) {
    const done = putScope(entities, version, opts, base, AbortSignal.timeout(opts.scopeTimeoutMs ?? nerScopeTimeoutMs()));
    const entry = { version, done };
    job = entry;
    inflight.set(base, entry);
    done.then(
      () => {},
      (err: unknown) => nerLog()({ evt: "ner.scope_push", url: base, version, outcome: err instanceof NerSidecarError ? err.kind : "error", error: err instanceof Error ? err.message : String(err) }),
    ).finally(() => { if (inflight.get(base) === entry) inflight.delete(base); });
  }
  await waitFor(job.done, opts.signal);
}

/** The Ask app's only way into the sidecar: extract linked against Ask's own records. */
export async function askScopedExtract(store: Store, request: Omit<NerSidecarRequest, "scope" | "scopeVersion">, opts: AskScopeOpts = {}): Promise<NerSidecarResponse> {
  const base = opts.url ?? nerSidecarUrl();
  const { entities, version, ids } = askIndex(store);
  if (pushed.get(base) !== version) await pushScope(entities, version, opts, base);
  const scoped = { ...request, scope: ASK_SCOPE, scopeVersion: version, ...(request.embed === undefined && !nerEmbed() ? { embed: false } : {}) };
  let res: NerSidecarResponse;
  try {
    res = await extractAndLink(scoped, opts);
  } catch (err) {
    // 409: the sidecar restarted or holds an older version. Push once and retry; a second failure ends NER for this turn.
    if (!(err instanceof NerSidecarError) || err.kind !== "http" || err.status !== 409) throw err;
    pushed.delete(base);
    await pushScope(entities, version, opts, base);
    res = await extractAndLink(scoped, opts);
  }
  if (res.scope !== ASK_SCOPE) throw new NerSidecarError(`NER sidecar answered from scope ${res.scope ?? "default"}, not ${ASK_SCOPE}`, "invalid");
  return { ...res, spans: keepAskIds(res.spans, ids) };
}

/** Tests: forget what was pushed. */
export const resetAskScopeCache = () => {
  pushed.clear();
  inflight.clear();
};
