import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Mention } from "./mentions.js";
import {
  clarifyFromSpans,
  entityForSpan,
  mergeMentions,
  nerSidecarEnabled,
  nerSidecarUrl,
  spansToMentions,
} from "./ner_client.js";
import type { NerLinkedSpan } from "./ner_sidecar_contract.js";

describe("ner_client flag / url", () => {
  test("NER_SIDECAR / ASK_NER enable the facade", () => {
    assert.equal(nerSidecarEnabled({}), false);
    assert.equal(nerSidecarEnabled({ NER_SIDECAR: "1" }), true);
    assert.equal(nerSidecarEnabled({ ASK_NER: "true" }), true);
    assert.equal(nerSidecarEnabled({ NER_SIDECAR: "0" }), false);
  });

  test("NER_SIDECAR_URL defaults to localhost:8091", () => {
    assert.equal(nerSidecarUrl({}), "http://127.0.0.1:8091");
    assert.equal(nerSidecarUrl({ NER_SIDECAR_URL: "http://127.0.0.1:9091/" }), "http://127.0.0.1:9091");
  });
});

describe("spansToMentions / clarify", () => {
  const linked: NerLinkedSpan = {
    text: "Clear Finance",
    label: "company",
    start: 0,
    end: 13,
    status: "linked",
    linkedId: "co_1",
    linkedEntity: "company",
    method: "exact",
    score: 1,
  };
  const ambiguous: NerLinkedSpan = {
    text: "Sarah Johnson",
    label: "person",
    start: 8,
    end: 21,
    status: "ambiguous",
    candidates: [
      { id: "ct_a", name: "Sarah Johnson", detail: "Brightside", entity: "contact" },
      { id: "ct_b", name: "Sarah Johnson", detail: "gmail", entity: "contact" },
    ],
    method: "exact",
    score: 1,
  };
  const miss: NerLinkedSpan = {
    text: "Zed Nowhere",
    label: "person",
    start: 0,
    end: 11,
    status: "miss",
  };

  test("unique link becomes a count-1 mention with Store linkedId", () => {
    const m = spansToMentions([linked]);
    assert.deepEqual(m, [
      {
        name: "Clear Finance",
        entity: "company",
        count: 1,
        linkedId: "co_1",
        method: "exact",
        score: 1,
      },
    ]);
  });

  test("ambiguous becomes count>1 with candidates; never sets linkedId", () => {
    const m = spansToMentions([ambiguous]);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.ambiguous, true);
    assert.equal(m[0]!.count, 2);
    assert.equal(m[0]!.linkedId, undefined);
    assert.equal(m[0]!.candidates?.[0]?.id, "ct_a");
  });

  test("miss spans are omitted (create/search owns unknowns)", () => {
    assert.deepEqual(spansToMentions([miss]), []);
  });

  test("clarifyFromSpans never picks candidates[0] as a winner", () => {
    const c = clarifyFromSpans([linked, ambiguous]);
    assert.ok(c);
    assert.equal(c!.status, "clarify");
    assert.deepEqual(c!.options, ["Sarah Johnson (Brightside)", "Sarah Johnson (gmail)"]);
    assert.match(c!.text, /Sarah Johnson/);
    assert.match(c!.text, /I found 2 matching/);
  });

  test("near-miss typo with one candidate uses Did you mean <name>?", () => {
    const nearMiss: NerLinkedSpan = {
      text: "Klar Finance",
      label: "company",
      start: 16,
      end: 28,
      status: "ambiguous",
      candidates: [{ id: "co_1", name: "Clear Finance", score: 0.82, entity: "company" }],
      method: "embed",
      score: 0.82,
    };
    const c = clarifyFromSpans([nearMiss]);
    assert.ok(c);
    assert.equal(c!.status, "clarify");
    assert.equal(c!.text, "Did you mean Clear Finance?");
    assert.deepEqual(c!.options, ["Clear Finance"]);
    assert.equal(c!.options?.[0], nearMiss.candidates?.[0]?.name);
  });

  test("near-miss with several candidates uses Did you mean one of these instead of …?", () => {
    const nearMiss: NerLinkedSpan = {
      text: "Sara Jonson",
      label: "person",
      start: 8,
      end: 19,
      status: "ambiguous",
      candidates: [
        { id: "ct_a", name: "Sarah Johnson", detail: "Brightside", entity: "contact", score: 0.81 },
        { id: "ct_b", name: "Sarah Johnson", detail: "gmail", entity: "contact", score: 0.8 },
      ],
      method: "embed",
      score: 0.81,
    };
    const c = clarifyFromSpans([nearMiss]);
    assert.ok(c);
    assert.equal(c!.text, "Did you mean one of these instead of Sara Jonson?");
    assert.deepEqual(c!.options, ["Sarah Johnson (Brightside)", "Sarah Johnson (gmail)"]);
  });

  test("miss without candidates still omits from spansToMentions and clarify", () => {
    assert.deepEqual(spansToMentions([miss]), []);
    assert.equal(clarifyFromSpans([miss, linked]), undefined);
  });

  test("near-miss ambiguous still becomes a mention with candidates (no linkedId)", () => {
    const nearMiss: NerLinkedSpan = {
      text: "Clear Fin",
      label: "company",
      start: 0,
      end: 9,
      status: "ambiguous",
      candidates: [{ id: "co_1", name: "Clear Finance", score: 0.88, entity: "company" }],
      method: "embed",
      score: 0.88,
    };
    const m = spansToMentions([nearMiss]);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.ambiguous, true);
    assert.equal(m[0]!.linkedId, undefined);
    assert.equal(m[0]!.candidates?.[0]?.name, "Clear Finance");
  });

  test("entityForSpan prefers linkedEntity / candidate entity over person→contact", () => {
    assert.equal(entityForSpan(linked), "company");
    assert.equal(entityForSpan(ambiguous), "contact");
    assert.equal(entityForSpan({ ...miss, label: "person" }), "contact");
  });
});

describe("mergeMentions", () => {
  test("NER replaces same-name Title-Case mentions and keeps uncovered legacy", () => {
    const ner: Mention[] = [{ name: "Clear Finance", entity: "company", count: 1, linkedId: "co_1" }];
    const legacy: Mention[] = [
      { name: "Clear Finance", entity: "company", count: 1 },
      { name: "Yusuf Silva", entity: "contact", count: 1 },
    ];
    const merged = mergeMentions(ner, legacy);
    assert.equal(merged.filter((m) => m.name === "Clear Finance").length, 1);
    assert.equal(merged.find((m) => m.name === "Clear Finance")?.linkedId, "co_1");
    assert.ok(merged.some((m) => m.name === "Yusuf Silva"));
  });
});
