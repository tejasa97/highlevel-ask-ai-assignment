import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOG_ACTIONS } from "../registry/catalog.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { buildCards, ENTITY_TYPES, loadCardMeta, type SearchCard } from "./cards.js";
import { loadQueries, score, summarize } from "./eval.js";
import { mentions } from "./mentions.js";
import { Embedder, MODEL } from "./embed.js";
import { type Dense, Retriever } from "./retrieve.js";
import { terms } from "./text.js";

let registry: Registry;
let cards: SearchCard[];
let r: Retriever;
before(async () => {
  registry = await loadRegistry();
  cards = buildCards(registry);
  r = new Retriever(cards);
});
const ids = (x: { picks: { id: string }[] }) => x.picks.map((p) => p.id);
const QUERIES = fileURLToPath(new URL("../../../eval/retrieval/queries.jsonl", import.meta.url));

describe("cards", () => {
  test("discovery metadata distinguishes read-only lookup from create and ID-only get", () => {
    for (const [id, entity] of [["M50.A03", "report"], ["M20.A03", "calendar"], ["M14.A03", "template"], ["M43.A02", "community"]])
      assert.equal(cards.find((c) => c.id === id)!.lookupFor, entity);
    for (const id of ["M50.A01", "M50.A02", "M50.A07", "M20.A01", "M20.A02"])
      assert.equal(cards.find((c) => c.id === id)!.lookupFor, null);
    for (const c of cards.filter((c) => c.lookupFor)) assert.equal(registry.get(c.id)!.risk, "read", c.id);
  });
  test("module card metadata describes returned records and implemented capabilities", () => {
    for (const id of ["M47.A07", "M47.A08"]) assert.equal(cards.find(c=>c.id===id)!.produces,"ticket",`${id} returns a ticket, not a standalone note/email`);
    for (const [id, unsupported] of [["M45.A02","text review link"],["M46.A07","holiday hours"],["M47.A06","mark ticket pending"],["M47.A10","time to resolve"]]) {
      assert.ok(!cards.find(c=>c.id===id)!.synonyms.includes(unsupported!));
    }
  });
  test("one per catalog action, all with generated metadata", () => {
    assert.equal(cards.length, CATALOG_ACTIONS.size);
    const meta = loadCardMeta();
    const missing = cards.filter((c) => !meta[c.id]).map((c) => c.id);
    assert.deepEqual(missing, [], "run `npm run cards` for these");
    for (const c of cards) {
      assert.ok(c.synonyms.length >= 5, `${c.id} has ${c.synonyms.length} synonyms`);
      assert.ok(c.description, `${c.id} has no description`);
    }
  });

  test("entity types and siblings point at real things", () => {
    const types = new Set<string>(ENTITY_TYPES);
    for (const c of cards) {
      if (c.produces) assert.ok(types.has(c.produces), `${c.id} produces ${c.produces}`);
      for (const t of c.consumes) assert.ok(types.has(t), `${c.id} consumes ${t}`);
      for (const s of c.siblings) assert.ok(CATALOG_ACTIONS.has(s) && s !== c.id, `${c.id} sibling ${s}`);
    }
  });

  test("only implemented actions are available", () => {
    for (const c of cards) assert.equal(c.available, registry.get(c.id) !== undefined, c.id);
  });

  // The eval is only honest if cards weren't written to match it: no synonym may contain a whole
  // paraphrase question. (The generator never sees eval/; this catches anyone hand-editing cards.json.)
  test("no synonym copies an eval paraphrase", () => {
    const norm = (s: string) => terms(s).join(" ");
    const qs = loadQueries(QUERIES).filter((q) => q.group === "paraphrase" || q.group === "brief").map((q) => norm(q.q));
    const copies = cards.flatMap((c) => c.synonyms.filter((s) => qs.includes(norm(s))).map((s) => `${c.id}: ${s}`));
    assert.deepEqual(copies, []);
  });
});

describe("retrieve", () => {
  test("a selected create action never substitutes for the existing-record discovery dependency", () => {
    const retriever = new Retriever(cards, { k: 0, siblings: 0 });
    const result = retriever.retrieve({ message: "run report", resolvable: [], context: { prev: ["M50.A07", "M50.A01"] } });
    assert.ok(result.picks.some((p) => p.id === "M50.A03" && p.why === "producer" && p.via === "M50.A07"));
    assert.ok(result.picks.filter((p) => p.why === "producer").every((p) => registry.get(p.id)!.risk === "read"));
  });
  test("named-record helpers use a standalone search, not every related list of that entity", () => {
    const retriever = new Retriever(cards, { k: 0, siblings: 0 });
    const result = retriever.retrieve({ message: "Sarah Johnson", mentions: [{ entity: "contact" }], resolvable: registry.resolverEntities() });
    assert.ok(ids(result).includes("M01.A02"));
    assert.ok(ids(result).includes("M01.A03"));
    assert.ok(!ids(result).includes("M02.A10"), "listing a company's contacts first needs a company ID");
    assert.ok(!ids(result).includes("M08.A08"), "finding contacts by tag first needs a tag ID");
  });
  test("trace mode follows actual rankings rather than whether an embedder was configured", async () => {
    assert.equal(r.retrieve({message:"create support ticket"}).mode,"bm25");
    const good = new Retriever(cards,{}, {rank:async()=>[[{id:"M47.A01",score:1}]]});
    assert.equal(good.retrieve(await good.prepare({message:"create support ticket"})).mode,"hybrid");
    const broken = new Retriever(cards,{}, {rank:async()=>{throw Error("test inference failure");}});
    assert.equal(broken.retrieve(await broken.prepare({message:"create support ticket"})).mode,"bm25");
  });
  test("finds the obvious action first", () => {
    assert.equal(r.retrieve({ message: "create a contact for Ana Ruiz" }).picks[0]!.id, "M01.A01");
  });

  test("caps any one module", () => {
    const x = r.retrieve({ message: "contact contacts contact details contact list" }, { siblings: 0, producers: false });
    assert.ok(ids(x).filter((id) => id.startsWith("M01")).length <= 6);
  });

  test("each clause's best match makes the list", () => {
    const x = r.retrieve({ message: "find leads from facebook created last week, give them to whoever on the Sales team is free, and make a follow-up task for each" });
    for (const id of ["M03.A03", "M49.A09", "M06.A01"]) assert.ok(ids(x).slice(0, 6).includes(id), id);
  });

  test("adds siblings of top picks, marked with where they came from", () => {
    const x = r.retrieve({ message: "create a lead" });
    const sibs = x.picks.filter((p) => p.why === "sibling");
    assert.ok(sibs.length > 0);
    for (const p of sibs) assert.ok(r.card(p.via!)!.siblings.includes(p.id), `${p.id} via ${p.via}`);
  });

  test("a message about every record of a type brings in that type's search even when it resolves by name", () => {
    const resolvable = registry.resolverEntities();
    const ids = (message: string) => r.retrieve({ message, resolvable }, { siblings: 0 }).picks.map((p) => p.id);
    assert.ok(ids("Archive every contact at Wayne").includes("M01.A03"));
    assert.ok(!ids("Archive Elodie Mercer").includes("M01.A03"));
  });

  test("adds producers only for record types the planner can't resolve by name", () => {
    const msg = "allocate the payment to the invoice";
    const prod = (resolvable: string[]) => r.retrieve({ message: msg, resolvable }, { siblings: 0 }).picks.filter((p) => p.why === "producer");
    // Nothing resolvable: a contact producer comes in alongside the others.
    const all = prod([]).map((p) => r.card(p.id)!.produces);
    assert.ok(all.includes("contact"), all.join());
    // With the real resolvers, contacts are looked up by name, so their producers drop out.
    const resolvable = registry.resolverEntities();
    for (const p of prod(resolvable)) assert.ok(p.via && !resolvable.includes(r.card(p.id)!.produces!), p.id);
    // Whatever else a pick needs is produced by some pick (ranked or added).
    const picks = r.retrieve({ message: msg, resolvable }, { siblings: 0 }).picks.map((p) => r.card(p.id)!);
    for (const need of new Set(picks.flatMap((c) => c.consumes))) {
      assert.ok(resolvable.includes(need) || picks.some((c) => c.produces === need), need);
    }
  });

  test("a follow-up keeps the previous turn's actions", () => {
    // M06.A01 ranks on its own words; the campaign launch only comes in because the last turn used it.
    const x = r.retrieve({ message: "make those high priority", context: { prev: ["M06.A01", "M15.A07"], entities: ["task"] } });
    assert.ok(x.picks.some((p) => p.id === "M06.A01"));
    assert.ok(x.picks.some((p) => p.id === "M15.A07" && p.why === "carried"));
  });

  test("exclude leaves out what was already offered", () => {
    const first = ids(r.retrieve({ message: "send a text" }));
    const again = ids(r.retrieve({ message: "send a text", exclude: first }));
    assert.equal(again.filter((id) => first.includes(id)).length, 0);
  });

  test("no match when nothing in the catalog overlaps", () => {
    const x = r.retrieve({ message: "how do I cook risotto?" });
    assert.ok(x.noMatch);
    assert.equal(x.picks.length, 0);
  });
});

describe("module cap", () => {
  test("other modules go first, but slots nothing else fills go back to the capped cards", () => {
    // Only 4 cards outside Reviews clear the score floor, so all 10 review actions still fit in k=15.
    const ranked = r.retrieve({ message: "answer the 2-star review from yesterday" }, { moduleCap: 1 }).picks.filter((p) => p.why === "bm25");
    const reviews = ranked.map((p) => p.id.startsWith("M45"));
    assert.equal(reviews.filter(Boolean).length, 10);
    assert.ok(ranked.map((p) => p.id).includes("M45.A08"), "Reply to review");
    assert.ok(reviews.indexOf(false) < reviews.lastIndexOf(true) && reviews.slice(1, 5).every((x) => !x), "after the first review card, the other modules' cards come next");
  });
});

// The embedding half, with a stand-in model: a fixed ranking for every text it is asked about.
describe("hybrid fusion", () => {
  const fake = (top: string[]) => {
    const asked: string[][] = [];
    const dense: Dense = {
      rank: async (texts) => {
        asked.push(texts);
        return texts.map(() => top.map((id, i) => ({ id, score: 1 - i / 100 })));
      },
    };
    return { dense, asked };
  };

  test("prepare asks about the whole message and each clause; without a model it changes nothing", async () => {
    const { dense, asked } = fake(["M15.A08"]);
    const message = "pause the webinar campaign and add a note to Sarah";
    const input = await new Retriever(cards, {}, dense).prepare({ message, context: { entities: ["smart_list"] } });
    assert.deepEqual(asked, [[`${message} smart list`, "pause the webinar campaign", "add a note to Sarah"]]);
    assert.equal(input.dense!.length, 3);
    assert.deepEqual(await r.prepare({ message }), { message });
  });

  test("a card the meaning ranking puts first is picked even when its words barely match", async () => {
    // BM25 alone ranks Pause campaign 24th, under the score floor that "send email" sets.
    const message = "hold off on the fall webinar emails for now";
    assert.ok(!ids(r.retrieve({ message })).includes("M15.A08"));
    const h = new Retriever(cards, {}, fake(["M15.A08", "M15.A09"]).dense);
    const pick = h.retrieve(await h.prepare({ message })).picks.find((p) => p.id === "M15.A08");
    assert.equal(pick?.why, "bm25", "it has a weak BM25 hit, so it keeps that label and score");
  });

  test("a card only the meaning ranking found is labelled dense, without a BM25 score", async () => {
    const h = new Retriever(cards, {}, fake(["M46.A03"]).dense);
    const pick = h.retrieve(await h.prepare({ message: "create a contact for Ana Ruiz" })).picks.find((p) => p.id === "M46.A03");
    assert.deepEqual([pick?.why, pick?.score, pick?.matched], ["dense", undefined, undefined]);
  });

  test("past the floor exemption, a meaning-only card still needs a BM25 score over the floor", async () => {
    const h = new Retriever(cards, {}, fake(["M46.A03"]).dense);
    const input = await h.prepare({ message: "create a contact for Ana Ruiz" });
    assert.ok(!ids(h.retrieve(input, { denseFloorExempt: 0 })).includes("M46.A03"));
  });

  test("noMatch still comes from BM25 alone: an embedding ranking always has a nearest card", async () => {
    const h = new Retriever(cards, {}, fake(["M01.A01"]).dense);
    const x = h.retrieve(await h.prepare({ message: "how do I cook risotto?" }));
    assert.equal(x.noMatch, true);
    assert.equal(x.picks.length, 0);
  });

  test("ids the catalog doesn't have are ignored (a stale vector cache, say)", async () => {
    const h = new Retriever(cards, {}, fake(["M99.A99", "M46.A03"]).dense);
    const x = h.retrieve(await h.prepare({ message: "create a contact for Ana Ruiz" }));
    assert.ok(!ids(x).includes("M99.A99"));
    assert.ok(ids(x).includes("M46.A03"));
  });

  test("a model that throws costs the turn its embedding half, not the turn", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const h = new Retriever(cards, {}, { rank: async () => { throw new Error("session closed"); } });
    const message = "find leads from facebook";
    const input = await h.prepare({ message });
    assert.deepEqual(input, { message });
    assert.deepEqual(ids(h.retrieve(input)), ids(r.retrieve({ message })));
    assert.equal(errors.mock.callCount(), 1);
  });
});

// Regression gate on the whole question set. Floors sit a little under the measured numbers
// (docs/PLAN.md), so tuning can move them but not quietly lose them. With all 500 actions
// implemented, BM25 R@15 measured 0.8989.
describe("retrieval eval", () => {
  test("recall stays at its measured level", async () => {
    const qs = loadQueries(QUERIES);
    const { store } = world();
    const s = summarize(
      await Promise.all(qs.map((q) => score(q, r, [15], registry.resolverEntities(), (m) => mentions(m, registry, store)))),
      [15],
    );
    assert.ok(s.total.recall[15]! >= 0.89, `R@15 ${s.total.recall[15]}`);
    assert.equal(s.groups.direct!.recall[15], 1, "every direct question finds its action");
    assert.ok(s.groups.paraphrase!.recall[15]! >= 0.8, `paraphrase R@15 ${s.groups.paraphrase!.recall[15]}`);
    assert.equal(s.falseRejects, 0, "no in-scope question is rejected as no match");
    assert.ok(s.total.picks <= 22, `average shortlist ${s.total.picks}`);
  });
});

// The same gate with the real embedding model, when it has been downloaded (npm run serve or eval:retrieval
// fetch it once into server/data/models/). Measured: R@15 96.7%, paraphrase 93.6% (BM25 alone: 90.4%, 82.7%).
const modelOnDisk = existsSync(fileURLToPath(new URL(`../../data/models/${MODEL}/`, import.meta.url)));
describe("retrieval eval, hybrid", { skip: !modelOnDisk && "embedding model not downloaded" }, () => {
  test("recall stays at its measured level", async () => {
    const h = new Retriever(cards, {}, await Embedder.load(cards));
    const { store } = world();
    const scored = [];
    for (const q of loadQueries(QUERIES)) scored.push(await score(q, h, [15], registry.resolverEntities(), (m) => mentions(m, registry, store)));
    const s = summarize(scored, [15]);
    assert.ok(s.total.recall[15]! >= 0.95, `R@15 ${s.total.recall[15]}`);
    assert.equal(s.groups.direct!.recall[15], 1, "every direct question finds its action");
    assert.ok(s.groups.paraphrase!.recall[15]! >= 0.9, `paraphrase R@15 ${s.groups.paraphrase!.recall[15]}`);
    assert.equal(s.falseRejects, 0, "no in-scope question is rejected as no match");
    assert.ok(s.total.picks <= 22, `average shortlist ${s.total.picks}`);
  });
});
