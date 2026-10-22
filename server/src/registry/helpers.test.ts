import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { matchByName, norm } from "./helpers.js";

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
});
