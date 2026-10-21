import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clauses, terms } from "./text.js";

describe("terms", () => {
  test("stems so word forms meet", () => {
    assert.deepEqual(terms("Rescheduled appointments"), terms("reschedule appointment"));
  });

  test("drops filler words and numbers", () => {
    assert.deepEqual(terms("please send the 3 invoices for $1,200 by 10:30"), terms("send invoices"));
  });

  test("expands shorthand both ways", () => {
    assert.deepEqual(terms("txt Priya"), terms("text priya"));
    assert.ok(terms("sms").includes(terms("text")[0]!));
    assert.deepEqual(terms("appt"), terms("appointment"));
    assert.deepEqual(terms("to-do"), terms("task"));
  });

  test("hyphenated words match joined and split forms", () => {
    const t = terms("follow-up");
    for (const x of [...terms("followup"), ...terms("follow")]) assert.ok(t.includes(x), x);
  });

  test("keeps tokens that mix letters and digits", () => {
    assert.ok(terms("utm_source facebook2026").length > 0);
  });
});

describe("clauses", () => {
  test("splits a multi-part request", () => {
    assert.deepEqual(clauses("find leads from facebook, give them to Sales and then make a follow-up task"), [
      "find leads from facebook",
      "give them to Sales",
      "make a follow-up task",
    ]);
  });

  test("drops clauses with nothing searchable", () => {
    assert.deepEqual(clauses("create a contact. thanks!"), ["create a contact"]);
  });
});
