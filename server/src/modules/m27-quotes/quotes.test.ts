import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("guards: bad contact, non-USD line, no-op edits, permissions, unknown field", async () => {
  const w = await testWorld();
  const archived = w.f.contact({ status: "archived" });
  assert.equal(failure(() => w.call("M27.A01", { contactId: archived.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M27.A01", { contactId: w.f.contact().id, madeUp: 1 })).code, "INVALID");
  const quote = w.f.quote();
  const eur = w.f.price({ currency: "EUR", amount: 40 });
  assert.equal(failure(() => w.call("M27.A04", { quoteId: quote.id, priceId: eur.id })).code, "CONFLICT");
  const lined = w.f.quote({
    lines: [{ id: "ql_9", description: "Work", productId: null, priceId: null, quantity: 1, unitPrice: 10, amount: 10 }],
    subtotal: 10,
    total: 10,
  });
  assert.equal(failure(() => w.call("M27.A05", { quoteId: lined.id, lineId: "ql_9", quantity: 1 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M27.A06", { quoteId: quote.id, expiresAt: null })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M27.A07", { quoteId: quote.id, discount: null })).code, "CONFLICT");
  const sales = w.f.user({ roles: ["sales"] });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: quote.id }, sales.id)).code, "PERMISSION");
  assert.equal(failure(() => w.call("M27.A09", { quoteId: quote.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M27.A10", { quoteId: quote.id }, sales.id)).code, "PERMISSION");
});

test("lines, discount and USD default price; non-USD and sent quotes are refused", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const product = w.f.product({ name: "Audit" });
  const price = w.call("M26.A01", { productId: product.id, label: "Standard", amount: 100 });
  const quote = w.call("M27.A01", { contactId: contact.id });
  const added = w.call("M27.A04", { quoteId: quote.id, productId: product.id, quantity: 2 });
  assert.equal(added.lines[0].unitPrice, 100);
  assert.equal(added.lines[0].amount, 200);
  assert.equal(added.subtotal, 200);
  const discounted = w.call("M27.A07", { quoteId: quote.id, discount: { type: "percent", value: 10 } });
  assert.equal(discounted.total, 180);
  const capped = w.call("M27.A07", { quoteId: quote.id, discount: { type: "amount", value: 500 } });
  assert.equal(capped.total, 0);
  w.call("M27.A07", { quoteId: quote.id, discount: { type: "percent", value: 10 } });
  assert.equal(failure(() => w.call("M27.A04", { quoteId: quote.id, priceId: w.f.price({ currency: "GBP" }).id })).code, "CONFLICT");
  const sent = w.call("M27.A08", { quoteId: quote.id });
  assert.equal(sent.status, "sent");
  assert.equal(failure(() => w.call("M27.A04", { quoteId: quote.id, priceId: price.id })).code, "CONFLICT");
});

test("send needs both permissions and an email, stores no emails row, and ignores do-not-disturb", async () => {
  const w = await testWorld();
  const quiet = w.f.contact({ preferences: { email: false, sms: false, call: false, dnd: true } });
  const quote = w.f.quote({ contactId: quiet.id });
  const emails = w.store.all("emails").length;
  const sent = w.call("M27.A08", { quoteId: quote.id });
  assert.equal(sent.status, "sent");
  assert.equal(sent.sentAt, w.clock.now().toISOString());
  assert.equal(w.store.all("emails").length, emails);
  const billing = w.f.user({ roles: ["billing"] });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: w.f.quote().id }, billing.id)).code, "PERMISSION");
  const noEmail = w.f.quote({ contactId: w.f.contact({ email: null }).id });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: noEmail.id })).code, "CONFLICT");
  const gone = w.f.user({ roles: ["admin"], status: "deactivated" });
  assert.equal(failure(() => w.call("M27.A08", { quoteId: w.f.quote().id }, gone.id)).code, "PERMISSION");
});

test("convert only from accepted: open invoice, discounted total, lines copied, second convert names the invoice", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const quote = w.call("M27.A01", { contactId: contact.id });
  w.call("M27.A04", { quoteId: quote.id, description: "Work", unitPrice: 100, quantity: 2 });
  w.call("M27.A07", { quoteId: quote.id, discount: { type: "percent", value: 10 } });
  w.call("M27.A06", { quoteId: quote.id, expiresAt: w.f.at(7) });
  const sent = w.call("M27.A08", { quoteId: quote.id });
  assert.equal(failure(() => w.call("M27.A10", { quoteId: quote.id })).message, "Accept the quote first");
  const expired = w.f.quote({ status: "sent", sentAt: w.f.now(), expiresAt: w.f.at(-1) });
  assert.match(failure(() => w.call("M27.A09", { quoteId: expired.id })).message, /expired/);
  const accepted = w.call("M27.A09", { quoteId: sent.id });
  assert.equal(accepted.status, "accepted");
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
  const again = failure(() => w.call("M27.A10", { quoteId: quote.id }));
  assert.equal(again.code, "CONFLICT");
  assert.match(again.message, new RegExp(`already converted to ${invoice.id}`));
  const found = w.call("M27.A03", { contactId: contact.id, status: "converted" });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, quote.id);
});
