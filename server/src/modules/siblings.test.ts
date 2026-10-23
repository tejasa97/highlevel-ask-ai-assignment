import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCards } from "../retrieval/cards.js";
import { registry } from "../testkit.js";

test("every declared sibling is a real action and never the action itself", async () => {
  const reg = await registry();
  for (const a of reg.list()) {
    for (const s of a.siblings ?? []) {
      assert.ok(reg.get(s), `${a.id} lists ${s}, which is not registered`);
      assert.notEqual(s, a.id, `${a.id} lists itself as a sibling`);
    }
  }
});

test("a sibling declared on one action shows up on the other in the retrieval cards", async () => {
  const cards = buildCards(await registry());
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const card of cards) {
    for (const s of card.siblings) {
      assert.ok(byId.get(s)?.siblings.includes(card.id), `${card.id} lists ${s} but ${s} does not list ${card.id}`);
    }
  }
});
