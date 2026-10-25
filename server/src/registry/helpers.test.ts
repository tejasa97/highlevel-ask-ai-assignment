import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { matchByName, norm, withoutTypeNoun } from "./helpers.js";

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

  test("the word for the kind of record is dropped, and only the trailing one", () => {
    assert.equal(withoutTypeNoun("the fall webinar campaigns"), "fall webinar");
    assert.equal(withoutTypeNoun("the open opportunities"), "open");
    assert.equal(withoutTypeNoun("campaign"), "campaign", "never strips down to nothing");
    assert.equal(withoutTypeNoun("spring campaign launch"), "spring campaign launch", "the noun must be last");
  });

  test("a phrase that names its record type still finds the record", () => {
    const docs = [{ l: "Fall Webinar Series" }, { l: "Spring Promo" }];
    assert.deepEqual(matchByName(docs, "the fall webinar campaign", (d) => d.l), [docs[0]]);
    assert.deepEqual(matchByName(docs, "the fall webinar campaigns", (d) => d.l), [docs[0]]);
  });

  test("the fallback never overrides a match the phrase already had", () => {
    const docs = [{ l: "Fall Webinar Series" }, { l: "Fall Webinar Series Europe" }];
    assert.deepEqual(matchByName(docs, "Fall Webinar Series", (d) => d.l), [docs[0]]);
  });

  test("a record whose name contains the noun still matches itself exactly", () => {
    const docs = [{ l: "The Campaign" }];
    assert.deepEqual(matchByName(docs, "The Campaign", (d) => d.l), docs);
    assert.deepEqual(matchByName([{ l: "Campaign House" }], "the campaign house", (d) => d.l), [{ l: "Campaign House" }]);
  });

  test("stripping a noun doesn't invent a match", () => {
    const docs = [{ l: "Fall Webinar Series" }];
    assert.deepEqual(matchByName(docs, "spring launch campaign", (d) => d.l), []);
  });

  test("an ambiguous name still returns every candidate", () => {
    const docs = [{ l: "Zoe Costa" }, { l: "Zoe Costa" }];
    assert.equal(matchByName(docs, "zoe costa", (d) => d.l).length, 2);
  });
});
