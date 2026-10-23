import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld, type TestWorld } from "../testkit.js";
import type { CommunityMember } from "./m43-communities/schema.js";
import type { Coupon } from "./m31-coupons/schema.js";
import type { Invoice } from "./m28-invoices/schema.js";
import type { Payment } from "./m29-payments/schema.js";
import type { Product } from "./m25-products/schema.js";
import type { Quote } from "./m27-quotes/schema.js";

// Each scenario calls real actions in sequence on one world and asserts the state the next step depends on.
// Module tests cover one module at a time with hand-built fixtures; these catch the seams between modules.

const ADDR = { line1: "1 Main", city: "Oakland", region: "CA", postalCode: "94612", country: "US" };

/** Moves the world's clock, so two payments don't share a timestamp. */
function setNow(w: TestWorld, iso: string): void {
  w.clock.now = () => new Date(iso);
}

test("product -> price -> quote -> send -> accept -> convert: the invoice is open and carries the quote's lines", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const product = w.call("M25.A01", { name: "Site audit" });
  const price = w.call("M26.A01", { productId: product.id, label: "Standard", amount: 250 });

  const quote = w.call("M27.A01", { contactId: contact.id }) as Quote;
  w.call("M27.A04", { quoteId: quote.id, priceId: price.id, quantity: 2 });
  w.call("M27.A04", { quoteId: quote.id, description: "Setup", unitPrice: 50, quantity: 1 });
  const discounted = w.call("M27.A07", { quoteId: quote.id, discount: { type: "amount", value: 100 } }) as Quote;
  assert.deepEqual([discounted.lines.length, discounted.subtotal, discounted.total], [2, 550, 450]);
  assert.equal(discounted.lines[0]?.productId, product.id);

  const sent = w.call("M27.A08", { quoteId: quote.id }) as Quote;
  assert.equal(sent.status, "sent");
  assert.equal(failure(() => w.call("M27.A04", { quoteId: quote.id, description: "Late", unitPrice: 1 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M27.A10", { quoteId: quote.id })).code, "CONFLICT");
  assert.equal((w.call("M27.A09", { quoteId: quote.id }) as Quote).status, "accepted");

  const { quote: converted, invoice } = w.call("M27.A10", { quoteId: quote.id }) as { quote: Quote; invoice: Invoice };
  assert.equal(converted.status, "converted");
  assert.equal(converted.invoiceId, invoice.id);
  assert.equal(invoice.status, "open");
  assert.equal(invoice.contactId, contact.id);
  assert.deepEqual([invoice.total, invoice.amountPaid, invoice.amountDue], [450, 0, 450]);
  assert.deepEqual(
    invoice.lineItems.map((l) => [l.quantity, l.unitPrice, l.amount]),
    [
      [2, 250, 500],
      [1, 50, 50],
    ],
  );
  const fetched = w.call("M28.A02", { invoiceId: invoice.id });
  assert.deepEqual([fetched.id, fetched.status, fetched.total, fetched.payments], [invoice.id, "open", 450, []]);
});

test("product + coupon + tax rule -> order -> submit -> cancel: each step moves tax, discount, stock and redemptions, and cancel puts them back", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const product = w.call("M25.A01", { name: "Widget", inventory: 5 }) as Product;
  const price = w.call("M26.A01", { productId: product.id, label: "Each", amount: 100 });
  w.call("M34.A01", { name: "California", rate: 8, region: "US-CA" });
  const coupon = w.call("M31.A01", { code: "TEN", discount: { type: "percent", value: 10 }, maxRedemptions: 1 }) as Coupon;
  const stock = () => w.store.get<Product>("products", product.id)?.inventory;
  const redemptions = () => w.store.get<Coupon>("coupons", coupon.id)?.redemptions;

  const order = w.call("M32.A01", { contactId: contact.id });
  w.call("M32.A04", { orderId: order.id, productId: product.id, priceId: price.id, quantity: 2 });
  w.call("M32.A06", { orderId: order.id, address: ADDR });
  const priced = w.call("M32.A07", { orderId: order.id, couponId: coupon.id });
  assert.deepEqual([priced.subtotal, priced.discountTotal, priced.total], [200, 20, 180]);
  assert.deepEqual([stock(), redemptions()], [5, 0]);

  const submitted = w.call("M32.A08", { orderId: order.id });
  assert.deepEqual([submitted.subtotal, submitted.discountTotal, submitted.taxTotal, submitted.total], [200, 20, 14.4, 194.4]);
  assert.deepEqual([stock(), redemptions()], [3, 1]);
  const invoice = w.store.get<Invoice>("invoices", submitted.invoiceId ?? "");
  assert.deepEqual([invoice?.status, invoice?.total, invoice?.amountDue], ["open", 194.4, 194.4]);

  const cancelled = w.call("M32.A09", { orderId: order.id, reason: "Changed mind" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(w.store.get<Invoice>("invoices", submitted.invoiceId ?? "")?.status, "void");
  assert.equal(stock(), 5);
  // The single redemption this coupon allows is free again for the next customer.
  assert.equal(redemptions(), 0);
});

test("paid invoice -> refund request -> approve -> execute: allocations peel newest first and the invoice reopens", async () => {
  const w = await testWorld();
  const contact = w.f.contact();
  const invoiceFor = (amount: number): Invoice => {
    const inv = w.call("M28.A01", { contactId: contact.id, lineItems: [{ description: "Work", quantity: 1, unitPrice: amount }] }) as Invoice;
    return w.call("M28.A07", { invoiceId: inv.id }) as Invoice;
  };
  const first = invoiceFor(60);
  const second = invoiceFor(40);

  setNow(w, "2026-10-21T14:00:00.000Z");
  const payment = w.call("M29.A04", { contactId: contact.id, amount: 100, method: "card" }) as Payment;
  w.call("M29.A07", { paymentId: payment.id, invoiceId: first.id, amount: 60 });
  setNow(w, "2026-10-21T15:00:00.000Z");
  w.call("M29.A07", { paymentId: payment.id, invoiceId: second.id, amount: 40 });
  assert.equal(w.store.get<Invoice>("invoices", first.id)?.status, "paid");
  assert.equal(w.store.get<Invoice>("invoices", second.id)?.status, "paid");

  const refund = w.call("M33.A01", { paymentId: payment.id, amount: 55, reason: "Cancelled project" });
  assert.equal(refund.status, "requested");
  assert.equal(w.call("M33.A07", { refundId: refund.id }).status, "approved");
  assert.equal(w.call("M33.A09", { refundId: refund.id }).status, "executed");

  const after = w.store.get<Payment>("payments", payment.id);
  assert.deepEqual(
    after?.allocations.map((a) => [a.invoiceId, a.amount]),
    [[first.id, 45]],
  );
  const reopened = w.store.get<Invoice>("invoices", second.id);
  assert.deepEqual([reopened?.status, reopened?.amountPaid, reopened?.amountDue], ["open", 0, 40]);
  const partly = w.store.get<Invoice>("invoices", first.id);
  assert.deepEqual([partly?.status, partly?.amountPaid, partly?.amountDue], ["open", 45, 15]);
  assert.equal((w.call("M33.A06", { paymentId: payment.id }) as { refundable: number }).refundable, 45);
});

test("course -> section -> lessons -> publish -> enroll -> complete every lesson -> certificate", async () => {
  const w = await testWorld();
  const learner = w.f.contact();
  const course = w.call("M40.A01", { title: "Onboarding 101" });
  const sectionId = w.call("M40.A05", { courseId: course.id, title: "Basics" }).sections[0].id;
  const lessons = ["Welcome", "Setup"].map((title) => w.call("M41.A01", { courseId: course.id, sectionId, title, body: `${title} text` }));
  for (const lesson of lessons) w.call("M41.A09", { lessonId: lesson.id });

  assert.equal(failure(() => w.call("M42.A01", { courseId: course.id, contactId: learner.id })).code, "CONFLICT");
  assert.equal(w.call("M40.A09", { courseId: course.id }).status, "published");
  const enrollment = w.call("M42.A01", { courseId: course.id, contactId: learner.id });
  assert.equal(enrollment.status, "active");

  w.call("M42.A08", { enrollmentId: enrollment.id, lessonId: lessons[0].id });
  assert.equal(failure(() => w.call("M42.A10", { enrollmentId: enrollment.id })).code, "CONFLICT");
  w.call("M42.A08", { enrollmentId: enrollment.id, lessonId: lessons[1].id });

  const certified = w.call("M42.A10", { enrollmentId: enrollment.id });
  assert.equal(certified.certificate.issuedAt, w.f.now());
  assert.match(certified.certificate.number, /\S/);
});

test("membership with a course and two communities -> grant -> access -> revoke undoes only what the grant added", async () => {
  const w = await testWorld();
  const member = w.f.contact();
  const course = w.f.course({ status: "published" });
  const fresh = w.f.community();
  const already = w.f.community();
  const joined = w.call("M43.A05", { communityId: already.id, contactId: member.id });

  const plan = w.call("M44.A01", {
    name: "Gold",
    entitlements: [
      { type: "course", targetId: course.id },
      { type: "community", targetId: fresh.id },
      { type: "community", targetId: already.id },
    ],
  });
  assert.equal(w.call("M44.A10", { contactId: member.id, courseId: course.id }).allowed, false);

  const membership = w.call("M44.A07", { planId: plan.id, contactId: member.id });
  for (const target of [{ courseId: course.id }, { communityId: fresh.id }, { communityId: already.id }]) {
    assert.equal(w.call("M44.A10", { contactId: member.id, ...target }).allowed, true);
  }
  const enrollments = w.call("M42.A03", { courseId: course.id, contactId: member.id });
  assert.equal(enrollments.total, 1);
  assert.equal(enrollments.items[0].status, "active");
  assert.deepEqual(membership.grantedCommunityMemberIds.length, 1);

  w.call("M44.A09", { membershipId: membership.id, reason: "Plan ended" });
  assert.equal(w.call("M42.A03", { courseId: course.id, contactId: member.id }).items[0].status, "revoked");
  assert.equal(w.call("M44.A10", { contactId: member.id, courseId: course.id }).allowed, false);
  assert.equal(w.call("M44.A10", { contactId: member.id, communityId: fresh.id }).allowed, false);
  // The community this contact was already in before the grant is theirs to keep.
  const stayed = w.store.find<CommunityMember>("community_members", (m) => m.communityId === already.id);
  assert.deepEqual(stayed.map((m) => m.leftAt), [null]);
  assert.equal(joined.communityId, already.id);
});

test("event with capacity 2: register, fill up, waitlist, cancel, promote, check in", async () => {
  const w = await testWorld();
  const [ann, ben, cal] = [w.f.contact(), w.f.contact(), w.f.contact()];
  const event = w.call("M24.A01", { title: "Open house", startsAt: w.f.at(7), endsAt: w.f.at(8), capacity: 2 });
  const annReg = w.call("M24.A06", { eventId: event.id, contactId: ann.id });
  w.call("M24.A06", { eventId: event.id, contactId: ben.id });
  assert.equal(failure(() => w.call("M24.A06", { eventId: event.id, contactId: ann.id })).code, "CONFLICT");

  // The third registration doesn't fail; it waits.
  const waiting = w.call("M24.A06", { eventId: event.id, contactId: cal.id });
  assert.equal(waiting.status, "waitlisted");
  assert.equal(waiting.waitlistPosition, 1);
  assert.equal(failure(() => w.call("M24.A09", { eventId: event.id })).message, "The event is full");
  assert.equal(failure(() => w.call("M24.A10", { registrationId: waiting.id })).message, "Promote them first");

  assert.equal(w.call("M24.A07", { registrationId: annReg.id }).status, "cancelled");
  const promoted = w.call("M24.A09", { eventId: event.id });
  assert.equal(promoted.id, waiting.id);
  assert.equal(promoted.status, "registered");
  assert.equal(w.call("M24.A10", { registrationId: promoted.id }).status, "checked_in");
});

test("form with an email field -> publish -> submit twice -> one contact -> survey response from that contact", async () => {
  const w = await testWorld();
  const form = w.call("M18.A01", { name: "Newsletter" });
  const field = w.call("M18.A04", { formId: form.id, label: "Email", type: "email", required: true, mapsTo: "email" }).fields[0];
  assert.equal(failure(() => w.call("M18.A09", { formId: form.id, values: { [field.id]: "dana@example.com" } })).code, "CONFLICT");
  w.call("M18.A08", { formId: form.id });

  const contactsBefore = w.store.all("contacts").length;
  const first = w.call("M18.A09", { formId: form.id, values: { [field.id]: "dana@example.com" } });
  assert.notEqual(first.contactId, null);
  assert.equal(w.store.all("contacts").length, contactsBefore + 1);
  const again = w.call("M18.A09", { formId: form.id, values: { [field.id]: "Dana@Example.com" } });
  assert.equal(again.contactId, first.contactId);
  assert.equal(w.store.all("contacts").length, contactsBefore + 1);
  assert.equal(w.call("M18.A10", { formId: form.id }).total, 2);

  const survey = w.call("M19.A01", { name: "How was it?" });
  const question = w.call("M19.A04", { surveyId: survey.id, text: "Rate us", type: "rating", required: true }).questions[0];
  w.call("M19.A07", { surveyId: survey.id });
  w.call("M19.A09", { surveyId: survey.id, contactId: first.contactId, answers: { [question.id]: 5 } });
  const summary = w.call("M19.A10", { surveyId: survey.id });
  assert.equal(summary.total, 1);
  assert.equal(summary.questions[0].answered, 1);
});
