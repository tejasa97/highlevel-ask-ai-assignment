import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

// One seat, one registered contact, two on the waitlist (second, then third).
async function fullEvent() {
  const w = await testWorld();
  const event = w.call("M24.A01", { title: "Workshop", startsAt: w.f.at(2, 15), endsAt: w.f.at(2, 17), capacity: 1 });
  const a = w.f.contact({ name: "Ada Lane" });
  const b = w.f.contact({ name: "Bea Moss" });
  const c = w.f.contact({ name: "Cy Diaz" });
  const first = w.call("M24.A06", { eventId: event.id, contactId: a.id });
  const second = w.call("M24.A06", { eventId: event.id, contactId: b.id });
  const third = w.call("M24.A08", { eventId: event.id, contactId: c.id });
  return { w, event, a, first, second, third };
}

test("M24.A06 a full event waitlists, and M24.A08 queues behind the waitlist", async () => {
  const w = await testWorld();
  const event = w.call("M24.A01", { title: "Workshop", startsAt: w.f.at(2, 15), endsAt: w.f.at(2, 17), capacity: 1 });
  const first = w.call("M24.A06", { eventId: event.id, contactId: w.f.contact({ name: "Ada Lane" }).id });
  assert.equal(first.status, "registered");
  const second = w.call("M24.A06", { eventId: event.id, contactId: w.f.contact({ name: "Bea Moss" }).id });
  assert.equal(second.status, "waitlisted");
  assert.equal(second.waitlistPosition, 1);
  const third = w.call("M24.A08", { eventId: event.id, contactId: w.f.contact({ name: "Cy Diaz" }).id });
  assert.equal(third.status, "waitlisted");
  assert.equal(third.waitlistPosition, 2);
  assert.equal(failure(() => w.call("M24.A09", { eventId: event.id })).code, "CONFLICT");
  assert.equal(w.call("M24.A02", { eventId: event.id }).waitlisted, 2);
});

test("M24.A07 cancel frees a seat without promoting anyone", async () => {
  const { w, event, first, second } = await fullEvent();
  w.call("M24.A07", { registrationId: first.id });
  assert.equal(w.call("M24.A02", { eventId: event.id }).waitlisted, 2);
  const still = w.store.get("event_registrations", second.id) as { status: string; waitlistPosition: number };
  assert.equal(still.status, "waitlisted");
  assert.equal(still.waitlistPosition, 1);
});

test("M24.A09 promote is explicit, takes the head of the waitlist, and needs a free seat", async () => {
  const { w, event, a, first, second, third } = await fullEvent();
  w.call("M24.A07", { registrationId: first.id });
  const again = w.call("M24.A06", { eventId: event.id, contactId: a.id });
  assert.equal(again.status, "registered");
  assert.equal(failure(() => w.call("M24.A09", { eventId: event.id })).code, "CONFLICT");
  w.call("M24.A07", { registrationId: again.id });
  const promoted = w.call("M24.A09", { eventId: event.id });
  assert.equal(promoted.id, second.id);
  assert.equal(promoted.status, "registered");
  assert.equal(promoted.waitlistPosition, null);
  const moved = w.store.get("event_registrations", third.id) as { status: string; waitlistPosition: number };
  assert.equal(moved.status, "waitlisted");
  assert.equal(moved.waitlistPosition, 1);
});

test("M24.A10 check-in needs a registered attendee and happens once", async () => {
  const { w, event, first, second, third } = await fullEvent();
  w.call("M24.A07", { registrationId: first.id });
  const promoted = w.call("M24.A09", { eventId: event.id });
  assert.equal(promoted.id, second.id);
  assert.match(failure(() => w.call("M24.A10", { registrationId: third.id })).message, /Promote them first/);
  const checked = w.call("M24.A10", { registrationId: promoted.id });
  assert.equal(checked.status, "checked_in");
  assert.ok(checked.checkedInAt);
  assert.equal(failure(() => w.call("M24.A10", { registrationId: promoted.id })).code, "CONFLICT");
  assert.equal(w.call("M24.A02", { eventId: event.id }).checkedIn, 1);
});

test("M24.A01 create refuses an event that ends before it starts", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M24.A01", { title: "Backwards", startsAt: "2026-10-22T15:00:00.000Z", endsAt: "2026-10-22T14:00:00.000Z" })).code, "INVALID");
});

test("M24.A04 update refuses a no-op", async () => {
  const w = await testWorld();
  const event = w.f.event({ title: "Night", capacity: 4 });
  assert.equal(failure(() => w.call("M24.A04", { eventId: event.id, title: "Night" })).code, "CONFLICT");
});

test("M24.A05 capacity refuses a no-op and a cut below the seats already taken", async () => {
  const w = await testWorld();
  const event = w.f.event({ title: "Night", capacity: 4 });
  assert.equal(failure(() => w.call("M24.A05", { eventId: event.id, capacity: 4 })).code, "CONFLICT");
  const filled = w.f.event({ capacity: 5 });
  w.f.registration({ eventId: filled.id, status: "registered" });
  w.f.registration({ eventId: filled.id, status: "checked_in", checkedInAt: w.f.now() });
  assert.equal(failure(() => w.call("M24.A05", { eventId: filled.id, capacity: 1 })).code, "CONFLICT");
});

test("M24.A06 registering the same contact twice conflicts", async () => {
  const w = await testWorld();
  const event = w.f.event({ title: "Night", capacity: 4 });
  const contact = w.f.contact();
  w.call("M24.A06", { eventId: event.id, contactId: contact.id });
  assert.equal(failure(() => w.call("M24.A06", { eventId: event.id, contactId: contact.id })).code, "CONFLICT");
});

test("M24.A08 waitlisting the same contact twice conflicts", async () => {
  const w = await testWorld();
  const event = w.f.event({ title: "Night", capacity: 4 });
  const extra = w.f.contact();
  const held = w.call("M24.A08", { eventId: event.id, contactId: extra.id });
  assert.equal(held.status, "waitlisted");
  assert.equal(failure(() => w.call("M24.A08", { eventId: event.id, contactId: extra.id })).code, "CONFLICT");
});

test("M24.A07 a second cancel conflicts", async () => {
  const w = await testWorld();
  const event = w.f.event({ title: "Night", capacity: 4 });
  const reg = w.call("M24.A06", { eventId: event.id, contactId: w.f.contact().id });
  w.call("M24.A07", { registrationId: reg.id });
  assert.equal(failure(() => w.call("M24.A07", { registrationId: reg.id })).code, "CONFLICT");
});

test("M24.A09 promote with nobody waitlisted conflicts", async () => {
  const w = await testWorld();
  const empty = w.f.event();
  assert.equal(failure(() => w.call("M24.A09", { eventId: empty.id })).code, "CONFLICT");
});

test("M24.A10 check-in of an unknown registration is NOT_FOUND", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M24.A10", { registrationId: "evr_99999" })).code, "NOT_FOUND");
});

test("M24.A02 unknown input field is INVALID", async () => {
  const w = await testWorld();
  const event = w.f.event({ title: "Night", capacity: 4 });
  assert.equal(failure(() => w.call("M24.A02", { eventId: event.id, madeUp: 1 })).code, "INVALID");
});
