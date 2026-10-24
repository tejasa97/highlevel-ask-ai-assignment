import assert from "node:assert/strict";
import { before, test } from "node:test";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { compile } from "./compile.js";
import { normalizeDateTimes } from "./datetimes.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const at = { type: "object", properties: { when: { type: "string", format: "date-time" }, note: { type: "string" } } };

test("a wall time without a zone is the app's local time; an offset becomes the same instant in Z", () => {
  assert.deepEqual(normalizeDateTimes({ when: "2026-10-28T09:00:00" }, at), { when: "2026-10-28T13:00:00.000Z" });
  assert.deepEqual(normalizeDateTimes({ when: "2026-10-28 09:00" }, at), { when: "2026-10-28T13:00:00.000Z" });
  assert.deepEqual(normalizeDateTimes({ when: "2026-11-02T09:00:00" }, at), { when: "2026-11-02T14:00:00.000Z" }, "after the clocks go back");
  assert.deepEqual(normalizeDateTimes({ when: "2026-10-28T09:00:00-04:00" }, at), { when: "2026-10-28T13:00:00.000Z" });
  assert.deepEqual(normalizeDateTimes({ when: "2026-10-28T13:00Z" }, at), { when: "2026-10-28T13:00:00.000Z" });
});

test("valid instants, other strings and non-date fields are left alone", () => {
  for (const when of ["2026-10-28T13:00:00Z", "2026-10-28T13:00:00.000Z", "2026-10-28", "next Tuesday", "$s1.publishAt"]) {
    assert.deepEqual(normalizeDateTimes({ when }, at), { when });
  }
  assert.deepEqual(normalizeDateTimes({ note: "2026-10-28T09:00:00" }, at), { note: "2026-10-28T09:00:00" });
});

test("scheduling a blog post at a local wall time compiles", () => {
  const r = compile({ type: "plan", steps: [{ id: "s1", kind: "action", action: "M38.A08", argsJson: JSON.stringify({ postId: "blg_1", publishAt: "2026-10-28T09:00:00" }) }], question: null, options: null, reason: null, alternatives: null, query: null, text: null }, registry);
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  assert.equal(r.plan.steps[0]!.kind === "action" && r.plan.steps[0]!.call.args.publishAt, "2026-10-28T13:00:00.000Z");
});
