// One contract, two languages: the zod schemas match the JSON Schema exported from the sidecar's Pydantic models, and
// the shared fixtures (also run by server/ner-sidecar/tests/test_contract.py) validate the same way on both sides.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { z } from "zod";
import { extractAndLink, NerSidecarError } from "./ner_client.js";
import { NER_WIRE_SCHEMAS, nerCandidateSchema, nerSidecarRequestSchema, nerSidecarResponseSchema } from "./ner_sidecar_contract.js";

const contractDir = new URL("../../ner-sidecar/contract/", import.meta.url);
const shared = JSON.parse(readFileSync(new URL("ner-sidecar.schema.json", contractDir), "utf8")) as { $defs: Record<string, unknown> };
type Fixture = { name: string; kind: string; valid: boolean; body: unknown };
const fixtures = JSON.parse(readFileSync(new URL("fixtures.json", contractDir), "utf8")) as { extractResponse: Fixture[]; extractRequest: Fixture[] };

/** Only what constrains a value: refs inlined, annotations and each generator's spelling of "anything goes" dropped. */
function normalize(node: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => normalize(n, defs));
  if (!node || typeof node !== "object") return node;
  const o = node as Record<string, unknown>;
  if (typeof o.$ref === "string") return normalize(defs[o.$ref.replace("#/$defs/", "")], defs);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (["title", "description", "$schema", "x-invariants", "propertyNames", "$defs"].includes(k)) continue;
    if (k === "additionalProperties") {
      if (v === false) continue; // zod's closed objects; Pydantic ignores extra fields, and so does the parse
      out[k] = true; // {} and true both mean any value
      continue;
    }
    if ((k === "maximum" && v === Number.MAX_SAFE_INTEGER) || (k === "minimum" && v === Number.MIN_SAFE_INTEGER)) continue;
    out[k] = k === "required" && Array.isArray(v) ? [...v].sort() : normalize(v, defs);
  }
  return out;
}

describe("NER sidecar contract", () => {
  test("every shared schema has a zod twin, and they say the same thing", () => {
    assert.deepEqual(Object.keys(NER_WIRE_SCHEMAS).sort(), Object.keys(shared.$defs).sort());
    for (const [name, schema] of Object.entries(NER_WIRE_SCHEMAS)) {
      const ours = normalize(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }), {});
      assert.deepEqual(ours, normalize(shared.$defs[name], shared.$defs), name);
    }
  });

  test("the comparison notices drift: a new field, a lost constraint, an optional field made required", () => {
    const candidate = normalize(shared.$defs.Candidate, shared.$defs);
    const drifted = [
      nerCandidateSchema.extend({ extra: z.string().optional() }),
      nerCandidateSchema.extend({ id: z.string() }),
      nerCandidateSchema.extend({ score: z.number() }),
    ];
    for (const d of drifted) assert.notDeepEqual(normalize(z.toJSONSchema(d, { io: "input" }), {}), candidate);
  });

  test("response fixtures: good, ambiguous and empty pass; every malformed one fails", () => {
    assert.deepEqual(new Set(fixtures.extractResponse.map((f) => f.kind)), new Set(["good", "ambiguous", "empty", "malformed"]));
    const wrong = fixtures.extractResponse.filter((f) => nerSidecarResponseSchema.safeParse(f.body).success !== f.valid).map((f) => f.name);
    assert.deepEqual(wrong, []);
  });

  test("request fixtures", () => {
    const wrong = fixtures.extractRequest.filter((f) => nerSidecarRequestSchema.safeParse(f.body).success !== f.valid).map((f) => f.name);
    assert.deepEqual(wrong, []);
  });

  test("the client returns valid fixtures and turns malformed ones into an invalid failure, not hints", async () => {
    for (const f of fixtures.extractResponse) {
      const fetchImpl = (async () => new Response(JSON.stringify(f.body), { status: 200 })) as unknown as typeof fetch;
      const call = extractAndLink({ requestId: "req_1", utterance: "x" }, { url: "http://ner", fetchImpl });
      if (f.valid) assert.ok((await call).spans, f.name);
      else await assert.rejects(call, (e: unknown) => e instanceof NerSidecarError && e.kind === "invalid", f.name);
    }
  });

  test("a response for another request is rejected", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ requestId: "someone_else", spans: [] }))) as unknown as typeof fetch;
    await assert.rejects(extractAndLink({ requestId: "req_1", utterance: "x" }, { url: "http://ner", fetchImpl }), /answered requestId someone_else/);
  });
});
