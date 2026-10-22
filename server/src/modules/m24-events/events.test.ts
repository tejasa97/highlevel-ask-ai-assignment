import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("a full event waitlists, cancel frees a seat without promoting, and promote is explicit", async () => {
  const w = await testWorld();
  const event = w.call("M24.A01", { title: "Workshop", startsAt: w.f.at(2, 15), endsAt: w.f.at(2, 17), capacity: 1 });
  const a = w.f.contact({ name: "Ada Lane" });
  const b = w.f.contact({ name: "Bea Moss" });
  const c = w.f.contact({ name: "Cy Diaz" });
  const first = w.call("M24.A06", { eventId: event.id, contactId: a.id });
  assert.equal(first.status, "registered");
  const second = w.call("M24.A06", { eventId: event.id, contactId: b.id });
  assert.equal(second.status, "waitlisted");
  assert.equal(second.waitlistPosition, 1);
  const third = w.call("M24.A08", { eventId: event.id, contactId: c.id });
  assert.equal(third.status, "waitlisted");
  assert.equal(third.waitlistPosition, 2);
  assert.equal(failure(() => w.call("M24.A09", { eventId: event.id })).code, "CONFLICT");
  assert.equal(w.call("M24.A02", { eventId: event.id }).waitlisted, 2);

  w.call("M24.A07", { registrationId: first.id });
  assert.equal(w.call("M24.A02", { eventId: event.id }).waitlisted, 2);
  const still = w.store.get("event_registrations", second.id) as { status: string; waitlistPosition: number };
  assert.equal(still.status, "waitlisted");
  assert.equal(still.waitlistPosition, 1);

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

  assert.match(failure(() => w.call("M24.A10", { registrationId: third.id })).message, /Promote them first/);
  const checked = w.call("M24.A10", { registrationId: promoted.id });
  assert.equal(checked.status, "checked_in");
  assert.ok(checked.checkedInAt);
  assert.equal(failure(() => w.call("M24.A10", { registrationId: promoted.id })).code, "CONFLICT");
  assert.equal(w.call("M24.A02", { eventId: event.id }).checkedIn, 1);
});

test("writes refuse bad times, no-ops, duplicates, and a second cancel", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M24.A01", { title: "Backwards", startsAt: "2026-10-22T15:00:00.000Z", endsAt: "2026-10-22T14:00:00.000Z" })).code, "INVALID");
  const event = w.f.event({ title: "Night", capacity: 4 });
  assert.equal(failure(() => w.call("M24.A04", { eventId: event.id, title: "Night" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M24.A05", { eventId: event.id, capacity: 4 })).code, "CONFLICT");
  const contact = w.f.contact();
  const reg = w.call("M24.A06", { eventId: event.id, contactId: contact.id });
  assert.equal(failure(() => w.call("M24.A06", { eventId: event.id, contactId: contact.id })).code, "CONFLICT");
  const extra = w.f.contact();
  const held = w.call("M24.A08", { eventId: event.id, contactId: extra.id });
  assert.equal(held.status, "waitlisted");
  assert.equal(failure(() => w.call("M24.A08", { eventId: event.id, contactId: extra.id })).code, "CONFLICT");
  w.call("M24.A07", { registrationId: reg.id });
  assert.equal(failure(() => w.call("M24.A07", { registrationId: reg.id })).code, "CONFLICT");
  const empty = w.f.event();
  assert.equal(failure(() => w.call("M24.A09", { eventId: empty.id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M24.A10", { registrationId: "evr_99999" })).code, "NOT_FOUND");
  const filled = w.f.event({ capacity: 5 });
  w.f.registration({ eventId: filled.id, status: "registered" });
  w.f.registration({ eventId: filled.id, status: "checked_in", checkedInAt: w.f.now() });
  assert.equal(failure(() => w.call("M24.A05", { eventId: filled.id, capacity: 1 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M24.A02", { eventId: event.id, madeUp: 1 })).code, "INVALID");
});
