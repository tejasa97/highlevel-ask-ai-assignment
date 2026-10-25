import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { world } from "../store/world.js";
import { registry } from "../testkit.js";

// Resolvers are the planner's way of turning a name into an id. They get the phrase as the user typed it,
// which usually carries the kind of record ("the fall webinar campaign") and a leading article.

const reg = await registry();

describe("resolvers", () => {
  test("a campaign keeps its name when the phrase adds its type", () => {
    const { store } = world();
    const found = reg.resolver("campaign")!(store, "the fall webinar campaign");
    assert.deepEqual(found.map((c) => c.name), ["Fall Webinar Series"]);
  });

  test("a team still resolves with its noun and article", () => {
    const { store } = world();
    const found = reg.resolver("team")!(store, "the Sales team");
    assert.deepEqual(found.map((c) => c.name), ["Sales"]);
  });

  test("two records with one name stay ambiguous", () => {
    const { store } = world();
    const found = reg.resolver("contact")!(store, "zoe costa");
    assert.equal(found.length, 2);
    assert.ok(found.every((c) => c.name === "Zoe Costa"));
  });
});
