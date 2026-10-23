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

  test("a request with words around a whole name still finds it, but only after every closer match", () => {
    const docs = [{ l: "Zoe Costa" }, { l: "Mailbox delivery Owen Hale" }, { l: "Ana" }, { l: "Zoe" }];
    assert.deepEqual(matchByName(docs, "Zoe Costa at Umbrella", (d) => d.l), [docs[0]]);
    assert.deepEqual(matchByName(docs, "Owen Hale Mailbox delivery support", (d) => d.l), [docs[1]]);
    // A one-word name inside a longer request is not enough to pick a record.
    assert.deepEqual(matchByName(docs, "Ana Smith", (d) => d.l), []);
    // A closer tier wins: the exact name, not the longer request it sits in.
    assert.deepEqual(matchByName([...docs, { l: "Zoe Costa at Umbrella" }], "Zoe Costa at Umbrella", (d) => d.l), [{ l: "Zoe Costa at Umbrella" }]);
  });
});
