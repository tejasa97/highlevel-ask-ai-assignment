import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

async function publishedPage() {
  const w = await testWorld();
  const cal = w.f.calendar({ visibility: "public", status: "active", name: "Public intro" });
  const page = w.f.bookingPage();
  w.call("M23.A05", { bookingPageId: page.id, calendarId: cal.id });
  return { w, cal, page };
}

test("M23.A09 publish needs a linked calendar", async () => {
  const w = await testWorld();
  const bare = w.f.bookingPage();
  assert.equal(failure(() => w.call("M23.A09", { bookingPageId: bare.id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M23.A09", { bookingPageId: bare.id })).message, /Link a public, active calendar/);
});

test("M23.A09 publish refuses a private or archived calendar", async () => {
  const w = await testWorld();
  const priv = w.f.calendar({ visibility: "private", status: "active" });
  const privPage = w.f.bookingPage();
  w.call("M23.A05", { bookingPageId: privPage.id, calendarId: priv.id });
  const privErr = failure(() => w.call("M23.A09", { bookingPageId: privPage.id }));
  assert.equal(privErr.code, "CONFLICT");
  assert.match(privErr.message, /private/);

  const archived = w.f.calendar({ visibility: "public", status: "archived" });
  const oldPage = w.f.bookingPage({ calendarId: archived.id });
  const oldErr = failure(() => w.call("M23.A09", { bookingPageId: oldPage.id }));
  assert.equal(oldErr.code, "CONFLICT");
  assert.match(oldErr.message, /archived/);
});

test("M23.A09 publish follows the calendar's visibility, and a published page cannot be published again", async () => {
  const { w, cal, page } = await publishedPage();
  w.call("M20.A09", { calendarId: cal.id, visibility: "private" });
  assert.match(failure(() => w.call("M23.A09", { bookingPageId: page.id })).message, /private/);
  w.call("M20.A09", { calendarId: cal.id, visibility: "public" });
  const published = w.call("M23.A09", { bookingPageId: page.id });
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt);
  assert.equal(failure(() => w.call("M23.A09", { bookingPageId: page.id })).code, "CONFLICT");
});

test("M23.A05 a published page cannot be moved to a private calendar", async () => {
  const { w, page } = await publishedPage();
  w.call("M23.A09", { bookingPageId: page.id });
  const swapped = w.f.calendar({ visibility: "private" });
  assert.equal(failure(() => w.call("M23.A05", { bookingPageId: page.id, calendarId: swapped.id })).code, "CONFLICT");
});

test("M23.A10 unpublish returns a page to draft, once", async () => {
  const { w, page } = await publishedPage();
  w.call("M23.A09", { bookingPageId: page.id });
  assert.equal(w.call("M23.A10", { bookingPageId: page.id }).status, "draft");
  assert.equal(failure(() => w.call("M23.A10", { bookingPageId: page.id })).code, "CONFLICT");
});

test("M23.A01 create refuses a duplicate slug", async () => {
  const w = await testWorld();
  w.call("M23.A01", { title: "Intro", slug: "intro" });
  assert.equal(failure(() => w.call("M23.A01", { title: "Other", slug: "intro" })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M23.A01", { title: "Other", slug: "Intro" })).code, "DUPLICATE", "slugs compare case-insensitively, as on blogs and landing pages");
});

test("M23.A04 update refuses a no-op and an unknown field", async () => {
  const w = await testWorld();
  const page = w.f.bookingPage({ title: "Keep", slug: "keep" });
  assert.equal(failure(() => w.call("M23.A04", { bookingPageId: page.id, title: "Keep" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M23.A04", { bookingPageId: page.id, madeUp: 1 })).code, "INVALID");
});

test("M23.A05 link refuses the calendar it already has", async () => {
  const w = await testWorld();
  const page = w.f.bookingPage({ title: "Keep", slug: "keep" });
  const cal = w.f.calendar();
  w.call("M23.A05", { bookingPageId: page.id, calendarId: cal.id });
  assert.equal(failure(() => w.call("M23.A05", { bookingPageId: page.id, calendarId: cal.id })).code, "CONFLICT");
});

test("M23.A06 fields refuse a no-op and a dropdown with no options", async () => {
  const w = await testWorld();
  const page = w.f.bookingPage({ title: "Keep", slug: "keep" });
  w.call("M23.A06", { bookingPageId: page.id, fields: [{ label: "Company", type: "text", required: false }] });
  assert.equal(failure(() => w.call("M23.A06", { bookingPageId: page.id, fields: [{ label: "Company", type: "text", required: false }] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M23.A06", { bookingPageId: page.id, fields: [{ label: "Size", type: "dropdown", required: true, options: [] }] })).code, "INVALID");
});

test("M23.A07 confirmation message refuses a no-op", async () => {
  const w = await testWorld();
  const page = w.f.bookingPage({ title: "Keep", slug: "keep" });
  w.call("M23.A07", { bookingPageId: page.id, confirmationMessage: "See you then" });
  assert.equal(failure(() => w.call("M23.A07", { bookingPageId: page.id, confirmationMessage: "See you then" })).code, "CONFLICT");
});

test("M23.A08 redirect url refuses a no-op and a malformed url", async () => {
  const w = await testWorld();
  const page = w.f.bookingPage({ title: "Keep", slug: "keep" });
  w.call("M23.A08", { bookingPageId: page.id, redirectUrl: "https://example.com/thanks" });
  assert.equal(failure(() => w.call("M23.A08", { bookingPageId: page.id, redirectUrl: "https://example.com/thanks" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M23.A08", { bookingPageId: page.id, redirectUrl: "notaurl" })).code, "INVALID");
});

test("M23.A09 publish of an unknown page is NOT_FOUND", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M23.A09", { bookingPageId: "bkp_99999" })).code, "NOT_FOUND");
});
