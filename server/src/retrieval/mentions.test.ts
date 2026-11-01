import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { loadRegistry, type Registry } from "../registry/registry.js";
import { world } from "../store/world.js";
import { buildCards } from "./cards.js";
import { mentions, nameRuns, withTextFields } from "./mentions.js";
import { Retriever } from "./retrieve.js";

let registry: Registry;
before(async () => {
  registry = await loadRegistry();
});

const linked = (message: string, ctx = world()) => mentions(message, registry, ctx.store).map((m) => `${m.name}: ${m.entity}${m.count > 1 ? ` x${m.count}` : ""}`);

describe("mentions", () => {
  test("an exact email links to its record", () => {
    assert.deepEqual(mentions("Text sjohnson@gmail.example that we got her message", registry, world().store).map((m) => [m.name, m.entity, m.linkedId]), [["sjohnson@gmail.example", "contact", "ct_32"]]);
    assert.deepEqual(mentions("Email nobody@nowhere.example.", registry, world().store), []);
  });

  test("a name that is other records' text in a field named after a record type says so", () => {
    const ctx = world();
    ctx.f.contact({ firstName: "Ana", lastName: "One", company: "Umbrellaco" });
    ctx.f.contact({ firstName: "Ben", lastName: "Two", company: "Umbrellaco" });
    const named = withTextFields([{ name: "Umbrellaco", entity: "opportunity", count: 1 }, { name: "Ana One", entity: "contact", count: 1 }], registry, ctx.store);
    assert.deepEqual(named[0]!.inField, [{ table: "contacts", field: "company", count: 2 }]);
    assert.equal(named[1]!.inField, undefined);
  });

  test("a full name links to the record type it belongs to", () => {
    const ctx = world();
    ctx.f.lead({ firstName: "Quinn", lastName: "Leadonly" });
    ctx.f.contact({ firstName: "Rory", lastName: "Contactonly" });
    assert.deepEqual(linked("is Quinn Leadonly qualified yet?", ctx), ["Quinn Leadonly: lead"]);
    assert.deepEqual(linked("What is Rory Contactonly's status?", ctx), ["Rory Contactonly: contact"]);
  });

  test("a word opening the sentence is dropped only when the whole run matched nothing", () => {
    const ctx = world();
    ctx.f.contact({ firstName: "Rory", lastName: "Contactonly" });
    assert.deepEqual(linked("Call Rory Contactonly tomorrow", ctx), ["Rory Contactonly: contact"]);
    // Mid-sentence an unknown full name stays unknown, even if its last word is someone else's name.
    ctx.f.contact({ firstName: "Pat", lastName: "Contactonly" });
    assert.deepEqual(linked("which company is Jo Contactonly with?", ctx), []);
  });

  test("names shared by several records are counted", () => {
    const ctx = world();
    ctx.f.contact({ firstName: "Zed", lastName: "Twin" });
    ctx.f.contact({ firstName: "Zed", lastName: "Twin" });
    assert.deepEqual(linked("what's Zed Twin's email?", ctx), ["Zed Twin: contact x2"]);
  });

  test("prefixes don't link: Tom is not Tomas", () => {
    const ctx = world();
    ctx.f.contact({ firstName: "Tomasz", lastName: "Prefixy" });
    assert.ok(!linked("ask Tomasz about it", ctx).some((l) => l.includes("Tom:")));
    assert.deepEqual(linked("ping Tomas", ctx), []);
  });

  test("names that start with an accented capital are whole", () => {
    const ctx = world();
    ctx.f.contact({ firstName: "Ángel", lastName: "Núñez" });
    assert.deepEqual(linked("what's Ángel Núñez's phone?", ctx), ["Ángel Núñez: contact"]);
  });

  test("a word naming what a mentioned contact's own record holds links to that record, with its owner", () => {
    const ctx = world();
    const owner = ctx.f.contact({ firstName: "Una", lastName: "Owner" });
    const starter = ctx.f.product({ name: "Starterish" });
    const price = ctx.f.price({ productId: starter.id, label: "Monthly", amount: 49, interval: "month" });
    ctx.f.subscription({ contactId: owner.id, productId: starter.id, priceId: price.id });
    const all = mentions("Move Una Owner from Starterish to Pro", registry, ctx.store);
    assert.ok(all.some((m) => m.name === "Starterish" && m.entity === "subscription" && m.of === "Una Owner"), JSON.stringify(all));
    // Without the owner in the message, the subscription is not linked by its product's name alone.
    assert.ok(!mentions("Move from Starterish to Pro", registry, ctx.store).some((m) => m.entity === "subscription"));
  });

  test("runs are split off possessives and know whether they open a sentence", () => {
    assert.deepEqual(nameRuns("What is Sarah Johnson's status? Ask Tom."), [
      { name: "What", opens: true },
      { name: "Sarah Johnson", opens: false },
      { name: "Ask Tom", opens: true },
    ]);
  });

  test("a linked name brings its record type's get and search actions", () => {
    const retriever = new Retriever(buildCards(registry));
    const ids = (mentions?: { entity: string }[]) => retriever.retrieve({ message: "What is Sarah Johnson's status?", mentions }).picks.map((p) => p.id);
    assert.ok(!ids().some((id) => id.startsWith("M01.")), "the words alone don't say contact");
    assert.deepEqual(ids([{ entity: "contact" }]).filter((id) => id.startsWith("M01.")), ["M01.A02", "M01.A03"]);
  });
});
