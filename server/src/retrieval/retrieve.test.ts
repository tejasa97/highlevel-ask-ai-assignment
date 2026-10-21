import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOG_ACTIONS } from "../registry/catalog.js";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { buildCards, ENTITY_TYPES, loadCardMeta, type SearchCard } from "./cards.js";
import { loadQueries, score, summarize } from "./eval.js";
import { mentions } from "./mentions.js";
import { Retriever } from "./retrieve.js";
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

  test("adds producers only for record types the planner can't resolve by name", () => {
    const msg = "move the Acme deal to the negotiation stage";
    const prod = (resolvable: string[]) => r.retrieve({ message: msg, resolvable }, { siblings: 0 }).picks.filter((p) => p.why === "producer");
    // Nothing resolvable: a contact producer comes in alongside the others.
    const all = prod([]).map((p) => r.card(p.id)!.produces);
    assert.ok(all.includes("contact"), all.join());
    // With the real resolvers, contacts and users are looked up by name, so their producers drop out.
    const resolvable = registry.resolverEntities();
    const some = prod(resolvable);
    assert.ok(some.length > 0);
    for (const p of some) assert.ok(p.via && !resolvable.includes(r.card(p.id)!.produces!), p.id);
  });

  test("a follow-up keeps the previous turn's actions", () => {
    const x = r.retrieve({ message: "make those high priority", context: { prev: ["M06.A01"], entities: ["task"] } });
    assert.ok(x.picks.some((p) => p.id === "M06.A01" && p.why === "carried"));
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

// Regression gate on the whole question set. Floors sit a little under the measured numbers
// (docs/PLAN.md), so tuning can move them but not quietly lose them.
describe("retrieval eval", () => {
  test("recall stays at its measured level", () => {
    const qs = loadQueries(QUERIES);
    const { store } = world();
    const s = summarize(
      qs.map((q) => score(q, r, [15], registry.resolverEntities(), (m) => mentions(m, registry, store))),
      [15],
    );
    assert.ok(s.total.recall[15]! >= 0.9, `R@15 ${s.total.recall[15]}`);
    assert.equal(s.groups.direct!.recall[15], 1, "every direct question finds its action");
    assert.ok(s.groups.paraphrase!.recall[15]! >= 0.8, `paraphrase R@15 ${s.groups.paraphrase!.recall[15]}`);
    assert.equal(s.falseRejects, 0, "no in-scope question is rejected as no match");
    assert.ok(s.total.picks <= 22, `average shortlist ${s.total.picks}`);
  });
});
