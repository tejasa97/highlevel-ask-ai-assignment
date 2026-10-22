import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

async function plainQuote() {
  const w = await testWorld();
  const quote = w.f.quote();
  return { w, quote };
}

// A $100 default price on "Audit", and a draft quote for a fresh contact.
async function auditQuote() {
  const w = await testWorld();
  const contact = w.f.contact();
  const product = w.f.product({ name: "Audit" });
  const price = w.call("M26.A01", { productId: product.id, label: "Standard", amount: 100 });
  const quote = w.call("M27.A01", { contactId: contact.id });
  return { w, product, price, quote };
}

// A draft quote with 2 x $100 of work, a 10% discount and a week to accept.
async function workQuote() {
  const w = await testWorld();
  const contact = w.f.contact();
  const quote = w.call("M27.A01", { contactId: contact.id });
  w.call("M27.A04", { quoteId: quote.id, description: "Work", unitPrice: 100, quantity: 2 });
  w.call("M27.A07", { quoteId: quote.id, discount: { type: "percent", value: 10 } });
  w.call("M27.A06", { quoteId: quote.id, expiresAt: w.f.at(7) });
  return { w, contact, quote };
}

test("M27.A01 create refuses an archived contact", async () => {
  const w = await testWorld();
  const archived = w.f.contact({ status: "archived" });
  assert.equal(failure(() => w.call("M27.A01", { contactId: archived.id })).code, "CONFLICT");
});

test("M27.A01 unknown input field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M27.A01", { contactId: w.f.contact().id, madeUp: 1 })).code, "INVALID");
});

test("M27.A04 add line refuses a non-USD price", async () => {
  const { w, quote } = await plainQuote();
  const eur = w.f.price({ currency: "EUR", amount: 40 });
  assert.equal(failure(() => w.call("M27.A04", { quoteId: quote.id, priceId: eur.id })).code, "CONFLICT");
});

test("M27.A05 line quantity refuses a no-op", async () => {
  const w = await testWorld();
  const lined = w.f.quote({
    lines: [{ id: "ql_9", description: "Work", productId: null, priceId: null, quantity: 1, unitPrice: 10, amount: 10 }],
    subtotal: 10,
    total: 10,
  });
  assert.equal(failure(() => w.call("M27.A05", { quoteId: lined.id, lineId: "ql_9", quantity: 1 })).code, "CONFLICT");
});

test("M27.A06 expiry refuses a no-op", async () => {
  const { w, quote } = await plainQuote();
  assert.equal(failure(() => w.call("M27.A06", { quoteId: quote.id, expiresAt: null })).code, "CONFLICT");
});

test("M27.A07 discount refuses a no-op", async () => {
  const { w, quote } = await plainQuote();
  assert.equal(failure(() => w.call("M27.A07", { quoteId: quote.id, discount: null })).code, "CONFLICT");
});

test("M27.A08 send needs the sending permission", async () => {
  const { w, quote } = await plainQuote();
  const sales = w.f.user({ roles: ["sales"] });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: quote.id }, sales.id)).code, "PERMISSION");
});

test("M27.A09 accept refuses a draft", async () => {
  const { w, quote } = await plainQuote();
  assert.equal(failure(() => w.call("M27.A09", { quoteId: quote.id })).code, "CONFLICT");
});

test("M27.A10 convert needs the invoicing permission", async () => {
  const { w, quote } = await plainQuote();
  const sales = w.f.user({ roles: ["sales"] });
  assert.equal(failure(() => w.call("M27.A10", { quoteId: quote.id }, sales.id)).code, "PERMISSION");
});

test("M27.A04 a product line takes the default USD price", async () => {
  const { w, product, quote } = await auditQuote();
  const added = w.call("M27.A04", { quoteId: quote.id, productId: product.id, quantity: 2 });
  assert.equal(added.lines[0].unitPrice, 100);
  assert.equal(added.lines[0].amount, 200);
  assert.equal(added.subtotal, 200);
});

test("M27.A07 a percent discount comes off the subtotal", async () => {
  const { w, product, quote } = await auditQuote();
  w.call("M27.A04", { quoteId: quote.id, productId: product.id, quantity: 2 });
  const discounted = w.call("M27.A07", { quoteId: quote.id, discount: { type: "percent", value: 10 } });
  assert.equal(discounted.total, 180);
});

test("M27.A07 a fixed discount is capped at the subtotal", async () => {
  const { w, product, quote } = await auditQuote();
  w.call("M27.A04", { quoteId: quote.id, productId: product.id, quantity: 2 });
  const capped = w.call("M27.A07", { quoteId: quote.id, discount: { type: "amount", value: 500 } });
  assert.equal(capped.total, 0);
});

test("M27.A04 a line priced in another currency is refused", async () => {
  const { w, quote } = await auditQuote();
  assert.equal(failure(() => w.call("M27.A04", { quoteId: quote.id, priceId: w.f.price({ currency: "GBP" }).id })).code, "CONFLICT");
});

test("M27.A08 send marks the quote sent, after which lines are refused", async () => {
  const { w, price, quote } = await auditQuote();
  const sent = w.call("M27.A08", { quoteId: quote.id });
  assert.equal(sent.status, "sent");
  assert.equal(failure(() => w.call("M27.A04", { quoteId: quote.id, priceId: price.id })).code, "CONFLICT");
});

test("M27.A08 send refuses a quote that was already sent", async () => {
  const { w, quote } = await auditQuote();
  w.call("M27.A08", { quoteId: quote.id });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: quote.id })).code, "CONFLICT");
});

test("M27.A08 send ignores do-not-disturb and stores no emails row", async () => {
  const w = await testWorld();
  const quiet = w.f.contact({ preferences: { email: false, sms: false, call: false, dnd: true } });
  const quote = w.f.quote({ contactId: quiet.id });
  const emails = w.store.all("emails").length;
  const sent = w.call("M27.A08", { quoteId: quote.id });
  assert.equal(sent.status, "sent");
  assert.equal(sent.sentAt, w.clock.now().toISOString());
  assert.equal(w.store.all("emails").length, emails);
});

test("M27.A08 send needs both permissions", async () => {
  const w = await testWorld();
  const billing = w.f.user({ roles: ["billing"] });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: w.f.quote().id }, billing.id)).code, "PERMISSION");
});

test("M27.A08 send needs an email address", async () => {
  const w = await testWorld();
  const noEmail = w.f.quote({ contactId: w.f.contact({ email: null }).id });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: noEmail.id })).code, "CONFLICT");
});

test("M27.A08 a deactivated admin cannot send", async () => {
  const w = await testWorld();
  const gone = w.f.user({ roles: ["admin"], status: "deactivated" });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: w.f.quote().id }, gone.id)).code, "PERMISSION");
});

test("M27.A10 convert needs the quote accepted first", async () => {
  const { w, quote } = await workQuote();
  w.call("M27.A08", { quoteId: quote.id });
  assert.equal(failure(() => w.call("M27.A10", { quoteId: quote.id })).message, "Accept the quote first");
});

test("M27.A09 accept refuses an expired quote", async () => {
  const w = await testWorld();
  const expired = w.f.quote({ status: "sent", sentAt: w.f.now(), expiresAt: w.f.at(-1) });
  assert.match(failure(() => w.call("M27.A09", { quoteId: expired.id })).message, /expired/);
});

test("M27.A09 accept marks a sent quote accepted", async () => {
  const { w, quote } = await workQuote();
  const sent = w.call("M27.A08", { quoteId: quote.id });
  const accepted = w.call("M27.A09", { quoteId: sent.id });
  assert.equal(accepted.status, "accepted");
});

test("M27.A10 convert makes an open invoice with the discounted total and the lines copied", async () => {
  const { w, quote } = await workQuote();
  w.call("M27.A08", { quoteId: quote.id });
  w.call("M27.A09", { quoteId: quote.id });
  const billing = w.f.user({ roles: ["billing"] });
  const { quote: converted, invoice } = w.call("M27.A10", { quoteId: quote.id }, billing.id);
  assert.equal(converted.status, "converted");
  assert.equal(converted.invoiceId, invoice.id);
  assert.equal(invoice.status, "open");
  assert.equal(invoice.currency, "USD");
  assert.equal(invoice.issueDate, w.f.today);
  assert.equal(invoice.amountPaid, 0);
  assert.deepEqual([invoice.total, invoice.amountDue], [180, 180]);
  assert.deepEqual(invoice.lineItems, [{ description: "Work", quantity: 2, unitPrice: 100, amount: 200 }]);
});

test("M27.A10 a second convert names the invoice", async () => {
  const { w, quote } = await workQuote();
  w.call("M27.A08", { quoteId: quote.id });
  w.call("M27.A09", { quoteId: quote.id });
  const { invoice } = w.call("M27.A10", { quoteId: quote.id });
  const again = failure(() => w.call("M27.A10", { quoteId: quote.id }));
  assert.equal(again.code, "CONFLICT");
  assert.match(again.message, new RegExp(`already converted to ${invoice.id}`));
});

test("M27.A03 list finds a converted quote by contact and status", async () => {
  const { w, contact, quote } = await workQuote();
  w.call("M27.A08", { quoteId: quote.id });
  w.call("M27.A09", { quoteId: quote.id });
  w.call("M27.A10", { quoteId: quote.id });
  const found = w.call("M27.A03", { contactId: contact.id, status: "converted" });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, quote.id);
});
