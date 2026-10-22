import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("publish needs a linked calendar that is public and active", async () => {
  const w = await testWorld();
  const bare = w.f.bookingPage();
  assert.equal(failure(() => w.call("M23.A09", { bookingPageId: bare.id })).code, "CONFLICT");
  assert.match(failure(() => w.call("M23.A09", { bookingPageId: bare.id })).message, /Link a public, active calendar/);

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

  const cal = w.f.calendar({ visibility: "public", status: "active", name: "Public intro" });
  const page = w.f.bookingPage();
  w.call("M23.A05", { bookingPageId: page.id, calendarId: cal.id });
  w.call("M20.A09", { calendarId: cal.id, visibility: "private" });
  assert.match(failure(() => w.call("M23.A09", { bookingPageId: page.id })).message, /private/);
  w.call("M20.A09", { calendarId: cal.id, visibility: "public" });
  const published = w.call("M23.A09", { bookingPageId: page.id });
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt);
  assert.equal(failure(() => w.call("M23.A09", { bookingPageId: page.id })).code, "CONFLICT");

  const swapped = w.f.calendar({ visibility: "private" });
  assert.equal(failure(() => w.call("M23.A05", { bookingPageId: page.id, calendarId: swapped.id })).code, "CONFLICT");
  assert.equal(w.call("M23.A10", { bookingPageId: page.id }).status, "draft");
  assert.equal(failure(() => w.call("M23.A10", { bookingPageId: page.id })).code, "CONFLICT");
});

test("writes refuse duplicates, no-ops, and a bad id", async () => {
  const w = await testWorld();
  w.call("M23.A01", { title: "Intro", slug: "intro" });
  assert.equal(failure(() => w.call("M23.A01", { title: "Other", slug: "intro" })).code, "DUPLICATE");
  const page = w.f.bookingPage({ title: "Keep", slug: "keep" });
  assert.equal(failure(() => w.call("M23.A04", { bookingPageId: page.id, title: "Keep" })).code, "CONFLICT");
  const cal = w.f.calendar();
  w.call("M23.A05", { bookingPageId: page.id, calendarId: cal.id });
  assert.equal(failure(() => w.call("M23.A05", { bookingPageId: page.id, calendarId: cal.id })).code, "CONFLICT");
  w.call("M23.A06", { bookingPageId: page.id, fields: [{ label: "Company", type: "text", required: false }] });
  assert.equal(failure(() => w.call("M23.A06", { bookingPageId: page.id, fields: [{ label: "Company", type: "text", required: false }] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M23.A06", { bookingPageId: page.id, fields: [{ label: "Size", type: "dropdown", required: true, options: [] }] })).code, "INVALID");
  w.call("M23.A07", { bookingPageId: page.id, confirmationMessage: "See you then" });
  assert.equal(failure(() => w.call("M23.A07", { bookingPageId: page.id, confirmationMessage: "See you then" })).code, "CONFLICT");
  w.call("M23.A08", { bookingPageId: page.id, redirectUrl: "https://example.com/thanks" });
  assert.equal(failure(() => w.call("M23.A08", { bookingPageId: page.id, redirectUrl: "https://example.com/thanks" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M23.A08", { bookingPageId: page.id, redirectUrl: "notaurl" })).code, "INVALID");
  assert.equal(failure(() => w.call("M23.A09", { bookingPageId: "bkp_99999" })).code, "NOT_FOUND");
  assert.equal(failure(() => w.call("M23.A04", { bookingPageId: page.id, madeUp: 1 })).code, "INVALID");
});
