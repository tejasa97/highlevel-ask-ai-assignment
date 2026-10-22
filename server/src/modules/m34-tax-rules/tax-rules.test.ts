import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("guards: duplicate rule, no-op edits, duplicate certificate, unknown field", async () => {
  const w = await testWorld();
  w.f.taxRule({ name: "State tax", region: "US", rate: 5 });
  assert.equal(failure(() => w.call("M34.A01", { name: "State tax", rate: 1, region: "US-NY" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M34.A01", { name: "Other", rate: 1, region: "US", madeUp: 1 })).code, "INVALID");
  const rule = w.f.taxRule({ region: "US", rate: 5, productCategory: null, inclusive: false });
  assert.equal(failure(() => w.call("M34.A04", { taxRuleId: rule.id, rate: 5 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M34.A05", { taxRuleId: rule.id, region: "US" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M34.A06", { taxRuleId: rule.id, productCategory: null })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M34.A07", { taxRuleId: rule.id, inclusive: false })).code, "CONFLICT");
  const contact = w.f.contact();
  w.f.taxExemption({ contactId: contact.id, certificateNumber: "EX-1" });
  assert.equal(failure(() => w.call("M34.A08", { contactId: contact.id, certificateNumber: "ex-1" })).code, "DUPLICATE");
  const inactive = w.f.taxRule({ status: "inactive" });
  assert.equal(failure(() => w.call("M34.A10", { taxRuleId: inactive.id })).code, "CONFLICT");
});

test("specific region wins, then category, inclusive is not added, exemptions zero the tax", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const food = w.f.product({ taxCategory: "food" });
  const plain = w.f.product({ taxCategory: null });
  const clothing = w.f.product({ taxCategory: "clothing" });
  w.f.taxRule({ region: "US", rate: 5, productCategory: null });
  w.f.taxRule({ region: "US-CA", rate: 10, productCategory: null });
  w.f.taxRule({ region: "US-CA", rate: 2, productCategory: "food" });
  w.f.taxRule({ region: "US", rate: 4, productCategory: "food" });
  w.f.taxRule({ region: "US-NY", rate: 9, productCategory: "clothing" });
  const caFood = w.call("M34.A09", { contactId: contact.id, country: "US", region: "CA", lines: [{ productId: food.id, amount: 100 }] });
  assert.equal(caFood.lines[0].rate, 2);
  assert.equal(caFood.lines[0].tax, 2);
  assert.equal(caFood.total, 102);
  const caPlain = w.call("M34.A09", { contactId: contact.id, country: "US", region: "CA", lines: [{ productId: plain.id, amount: 100 }] });
  assert.equal(caPlain.lines[0].rate, 10);
  const nyFood = w.call("M34.A09", { contactId: contact.id, country: "US", region: "NY", lines: [{ productId: food.id, amount: 100 }] });
  assert.equal(nyFood.lines[0].rate, 4);
  const nyClothing = w.call("M34.A09", { contactId: contact.id, country: "US", region: "NY", lines: [{ productId: clothing.id, amount: 100 }] });
  assert.equal(nyClothing.lines[0].rate, 9);
  const countryOnly = w.call("M34.A09", { contactId: contact.id, country: "US", lines: [{ productId: plain.id, amount: 33.33 }] });
  assert.equal(countryOnly.lines[0].tax, 1.67);
  w.f.taxExemption({ contactId: contact.id, regions: ["US"], expiresAt: w.f.day(0) });
  const exempt = w.call("M34.A09", { contactId: contact.id, country: "US", region: "CA", lines: [{ productId: food.id, amount: 100 }] });
  assert.deepEqual([exempt.exempt, exempt.taxTotal, exempt.total], [true, 0, 100]);
  const other = w.f.contact();
  const expired = w.f.taxExemption({ contactId: other.id, regions: [], expiresAt: w.f.day(-1) });
  assert.ok(expired.id);
  const taxed = w.call("M34.A09", { contactId: other.id, country: "US", region: "CA", lines: [{ productId: food.id, amount: 100 }] });
  assert.equal(taxed.exempt, false);
  assert.equal(taxed.lines[0].tax, 2);
  const narrow = w.f.contact();
  w.f.taxExemption({ contactId: narrow.id, regions: ["US-NY"] });
  const still = w.call("M34.A09", { contactId: narrow.id, country: "US", region: "CA", lines: [{ productId: food.id, amount: 100 }] });
  assert.equal(still.lines[0].tax, 2);
  const anywhere = w.f.contact();
  w.f.taxExemption({ contactId: anywhere.id, regions: [] });
  assert.equal(w.call("M34.A09", { contactId: anywhere.id, country: "US", region: "CA", lines: [{ productId: food.id, amount: 50 }] }).taxTotal, 0);
  const none = w.call("M34.A09", { contactId: contact.id, country: "DE", lines: [{ productId: plain.id, amount: 40 }] });
  assert.equal(none.lines[0].tax, 0);
  assert.equal(none.total, 40);
});

test("inclusive tax is carved out; order total adds exclusive tax only; inactive rules are ignored", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const included = w.f.product({ taxCategory: "inc" });
  const added = w.f.product({ taxCategory: "exc" });
  const dead = w.f.taxRule({ region: "US", rate: 99, productCategory: "inc", status: "inactive" });
  w.f.taxRule({ region: "US", rate: 10, productCategory: "inc", inclusive: true });
  w.f.taxRule({ region: "US", rate: 10, productCategory: "exc", inclusive: false });
  const out = w.call("M34.A09", {
    contactId: contact.id,
    country: "US",
    lines: [{ productId: included.id, amount: 110 }, { productId: added.id, amount: 100 }],
    subtotal: 200,
    discountTotal: 10,
  });
  assert.equal(dead.status, "inactive");
  assert.deepEqual(out.lines.map((line: { tax: number; inclusive: boolean }) => [line.tax, line.inclusive]), [[10, true], [10, false]]);
  assert.deepEqual([out.taxTotal, out.exclusiveTax, out.total], [20, 10, 200]);
  assert.equal(failure(() => w.call("M34.A09", { contactId: "ct_99999", country: "US", lines: [] })).code, "NOT_FOUND");
  const rule = w.call("M34.A01", { name: "City", rate: 1, region: "us-tx", productCategory: "inc", inclusive: true });
  assert.equal(rule.region, "US-TX");
  assert.equal(w.call("M34.A02", { taxRuleId: rule.id }).rate, 1);
  assert.equal(w.call("M34.A04", { taxRuleId: rule.id, rate: 3 }).rate, 3);
  assert.equal(w.call("M34.A05", { taxRuleId: rule.id, region: "GB" }).region, "GB");
  assert.equal(w.call("M34.A06", { taxRuleId: rule.id, productCategory: null }).productCategory, null);
  w.call("M34.A07", { taxRuleId: rule.id, inclusive: false });
  const recorded = w.call("M34.A08", { contactId: contact.id, certificateNumber: "EX-200", regions: ["gb"], expiresAt: w.f.day(3) });
  assert.deepEqual(recorded.regions, ["GB"]);
  w.call("M34.A10", { taxRuleId: rule.id });
  assert.equal(w.call("M34.A03", { status: "inactive", query: "City" }).total, 1);
});
