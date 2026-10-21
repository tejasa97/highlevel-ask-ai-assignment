import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { SearchCard } from "./cards.js";
import type { Dense } from "./retrieve.js";

// The meaning half of hybrid retrieval: a small local embedding model (bge-base, quantized, ~110 MB, no API
// call) turns each card and each question into a vector; cards are ranked by cosine similarity to the question.
// BM25 matches words, this matches meaning ("hold off on the webinar emails" → Pause campaign). Its ranking
// is fused with BM25's in retrieve.ts.
//
// Card vectors take ~30 s to compute (one card at a time, see embed()), so they are cached in server/data/ and recomputed only when a card's
// text or the model changes. The model itself is downloaded from Hugging Face once, into server/data/models/.

export const MODEL = "Xenova/bge-base-en-v1.5";
// bge models are trained with this prefix on the query side only.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const DATA = fileURLToPath(new URL("../../data/", import.meta.url));

export const cardText = (c: SearchCard) => `${c.name} (${c.module}). ${c.description} Also: ${c.synonyms.join(", ")}.`;

export class Embedder implements Dense {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly extract: FeatureExtractionPipeline,
    private readonly ids: string[],
    private readonly vectors: Float32Array[],
    readonly dims: number,
  ) {}

  /** Loads the model and the card vectors (from the cache when the cards haven't changed). */
  static async load(cards: SearchCard[], log: (line: string) => void = () => {}): Promise<Embedder> {
    if (!cards.length) throw new Error("no cards to embed");
    env.cacheDir = `${DATA}models/`;
    const started = performance.now();
    // The slow first-run steps are announced on stderr whatever `log` is, so a quiet caller doesn't look hung.
    if (!existsSync(`${DATA}models/${MODEL}`)) console.error(`downloading ${MODEL} (~110 MB, once) into server/data/models/`);
    const extract = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
    const dims = (await embed(extract, ["probe"]))[0]!.length;
    const texts = cards.map(cardText);
    const hash = createHash("sha256").update(`${MODEL} unbatched`).update(JSON.stringify(texts)).digest("hex").slice(0, 16);
    const file = `${DATA}vectors-${hash}.bin`;

    // A cache file of the wrong size (cut short by a crash, say) is ignored and rebuilt.
    let vectors = readCache(file, cards.length, dims);
    if (!vectors) {
      console.error(`embedding ${cards.length} cards with ${MODEL} (once; cached after)`);
      vectors = await embed(extract, texts);
      const all = new Float32Array(cards.length * dims);
      vectors.forEach((v, i) => all.set(v, i * dims));
      mkdirSync(DATA, { recursive: true });
      // Write then rename, so a reader never sees half a file.
      writeFileSync(`${file}.tmp`, new Uint8Array(all.buffer));
      renameSync(`${file}.tmp`, file);
      pruneCaches(file);
    }
    log(`embeddings ready: ${MODEL}, ${cards.length} cards, ${Math.round(performance.now() - started)} ms`);
    return new Embedder(extract, cards.map((c) => c.id), vectors, dims);
  }

  /** For each text, every card id ordered by similarity (best first). One model call for all texts. */
  rank(texts: string[]): Promise<{ id: string; score: number }[][]> {
    // One inference at a time: concurrent turns queue rather than contend for the same session.
    const run = this.queue.then(async () => {
      const qs = await embed(this.extract, texts.map((t) => QUERY_PREFIX + t));
      return qs.map((q) =>
        this.vectors
          .map((v, i) => ({ id: this.ids[i]!, score: dot(q, v) }))
          .sort((a, b) => b.score - a.score),
      );
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

// One text per call: in a batch, shorter texts are padded, and with the quantized model padding shifts
// their vectors (cosine ~0.99 to the unpadded one, enough to reorder close cards).
async function embed(extract: FeatureExtractionPipeline, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const text of texts) out.push((await extract(text, { pooling: "cls", normalize: true })).data as Float32Array);
  return out;
}

function readCache(file: string, n: number, dims: number): Float32Array[] | undefined {
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  if (bytes.length !== n * dims * 4) return undefined;
  const all = new Float32Array(new Uint8Array(bytes).buffer);
  return Array.from({ length: n }, (_, i) => all.subarray(i * dims, (i + 1) * dims));
}

// Keeps the few most recent caches, so switching between card sets (an eval variant, a branch) doesn't
// recompute each time, without letting old ones pile up.
function pruneCaches(keep: string, max = 3) {
  const old = readdirSync(DATA)
    .filter((f) => /^vectors-[0-9a-f]+\.bin(\.tmp)?$/.test(f) && `${DATA}${f}` !== keep)
    .map((f) => ({ f, t: statSync(`${DATA}${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of old.slice(max - 1)) rmSync(`${DATA}${f}`, { force: true });
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/** RETRIEVAL=bm25 turns the model off. If it can't load (no network on first run, say), retrieval falls
 *  back to BM25 alone and says so once, on stderr, whatever `log` is. */
export async function loadDense(cards: SearchCard[], log: (line: string) => void = console.log): Promise<Embedder | undefined> {
  const mode = process.env.RETRIEVAL ?? "hybrid";
  if (mode === "bm25") return undefined;
  if (mode !== "hybrid") throw new Error(`RETRIEVAL must be "hybrid" or "bm25", got "${mode}"`);
  try {
    return await Embedder.load(cards, log);
  } catch (e) {
    console.error(`embedding model unavailable, retrieval is BM25 only: ${(e as Error).message}`);
    return undefined;
  }
}
