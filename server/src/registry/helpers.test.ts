import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contains, matchByName, norm } from "./helpers.js";

describe("name matching", () => {
  test("a possessive names the same words as without it", () => {
    assert.equal(norm("Sarah Johnson's walkthrough"), "sarah johnson walkthrough");
    assert.equal(norm("Sarah Johnson’s walkthrough"), "sarah johnson walkthrough");
    assert.equal(norm("Patrick O'Sullivan"), "patrick osullivan");
  });

  test("a possessive request finds the meeting", () => {
    const docs = [{ l: "Agency plan walkthrough with Sarah Johnson" }, { l: "Intro call with Sarah Johnson" }];
    assert.deepEqual(matchByName(docs, "Sarah Johnson's Agency plan walkthrough", (d) => d.l), [docs[0]]);
  });

  test("a request with words around a whole name still finds it, but only after every closer match", () => {
    const docs = [{ l: "Zoe Costa" }, { l: "Mailbox delivery Owen Hale" }, { l: "Ana" }, { l: "Zoe" }];
    assert.deepEqual(matchByName(docs, "Zoe Costa at Umbrella", (d) => d.l), [docs[0]]);
    assert.deepEqual(matchByName(docs, "Owen Hale Mailbox delivery support", (d) => d.l), [docs[1]]);
    // A one-word name inside a longer request is not enough to pick a record.
    assert.deepEqual(matchByName(docs, "Ana Smith", (d) => d.l), []);
    // A closer tier wins: the exact name, not the longer request it sits in.
    assert.deepEqual(matchByName([...docs, { l: "Zoe Costa at Umbrella" }], "Zoe Costa at Umbrella", (d) => d.l), [{ l: "Zoe Costa at Umbrella" }]);
  });

  test("words naming the record type are ignored only when nothing closer matches", () => {
    const docs = [{ l: "Fall Webinar Series" }, { l: "Spring Promo" }];
    assert.deepEqual(matchByName(docs, "fall webinar campaign", (d) => d.l), [docs[0]]);
    assert.deepEqual(matchByName(docs, "the Spring Promo campaign", (d) => d.l), [docs[1]]);
    assert.deepEqual(matchByName(docs, "summer campaign", (d) => d.l), []);
    assert.deepEqual(matchByName(docs, "campaign", (d) => d.l), [], "a bare type word names nothing");
    assert.deepEqual(matchByName([...docs, { l: "Fall Webinar Recap" }], "fall webinar campaign", (d) => d.l), [docs[0], { l: "Fall Webinar Recap" }], "still ambiguous: both are returned");
  });

  test("a name said in the plural names the singular record, and only as a last resort", () => {
    const docs = [{ l: "Ceramic Mug" }, { l: "Mug Set" }, { l: "Setup Package" }];
    assert.deepEqual(matchByName(docs, "Ceramic Mugs", (d) => d.l), [docs[0]]);
    assert.deepEqual(matchByName(docs, "setup packages", (d) => d.l), [docs[2]]);
    assert.deepEqual(matchByName(docs, "Ceramic Bowls", (d) => d.l), []);
    assert.deepEqual(matchByName([...docs, { l: "Ceramic Mugs" }], "Ceramic Mugs", (d) => d.l), [{ l: "Ceramic Mugs" }], "an exact name still wins");
    assert.ok(contains("Ceramic Mug", "ceramic mugs"));
    assert.ok(!contains("Ceramic Mug", "ceramic bowls"));
  });

  test("a search term matches a name across punctuation and plurals, but not another word", () => {
    assert.ok(contains("Soylent - Pro plan", "Soylent Pro"));
    assert.ok(contains("Pro plan - Soylent", "soylent pro"));
    assert.ok(!contains("Soylent - Agency plan", "Soylent Pro"));
    assert.ok(!contains("Soylent - Pro plan", "Acme Pro"));
    assert.ok(!contains(3, "x"));
  });
});
