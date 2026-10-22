import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("archive is refused while a booked appointment is still upcoming", async () => {
  const w = await testWorld();
  const live = w.f.calendar({ name: "Sales" });
  w.f.appointment({ calendarId: live.id, startAt: w.f.at(1), endAt: w.f.at(2), status: "booked" });
  w.f.appointment({ calendarId: live.id, startAt: w.f.at(3), endAt: w.f.at(4), status: "booked" });
  const blocked = failure(() => w.call("M20.A10", { calendarId: live.id }));
  assert.equal(blocked.code, "CONFLICT");
  assert.match(blocked.message, /Cancel or wait out 2 upcoming appointments first/);
  assert.equal(w.call("M20.A02", { calendarId: live.id }).status, "active");

  const done = w.f.calendar();
  w.f.appointment({ calendarId: done.id, startAt: "2026-10-20T12:00:00.000Z", endAt: "2026-10-21T14:00:00.000Z", status: "booked" });
  w.f.appointment({ calendarId: done.id, startAt: w.f.at(1), endAt: w.f.at(2), status: "cancelled" });
  w.f.appointment({ calendarId: done.id, startAt: w.f.at(1), endAt: w.f.at(2), status: "completed" });
  w.f.appointment({ calendarId: w.f.calendar().id, startAt: w.f.at(1), endAt: w.f.at(2), status: "booked" });
  assert.equal(w.call("M20.A10", { calendarId: done.id }).status, "archived");
  assert.equal(failure(() => w.call("M20.A10", { calendarId: done.id })).code, "CONFLICT");
});

test("writes refuse a no-op, a bad id, or a host who cannot take bookings", async () => {
  const w = await testWorld();
  const c = w.f.calendar({ name: "Intro", timezone: "America/New_York", durationMinutes: 30, bufferMinutes: 0, visibility: "private" });
  assert.equal(failure(() => w.call("M20.A01", { name: "Nope", timezone: "Not/AZone" })).code, "INVALID");
  assert.equal(failure(() => w.call("M20.A04", { calendarId: c.id, name: "Intro" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M20.A05", { calendarId: c.id, timezone: "America/New_York" })).code, "CONFLICT");
  w.call("M20.A06", { calendarId: c.id, userId: "us_1" });
  assert.equal(failure(() => w.call("M20.A06", { calendarId: c.id, userId: "us_1" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M20.A06", { calendarId: c.id, userId: w.f.user({ status: "deactivated" }).id })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M20.A07", { calendarId: c.id, durationMinutes: 30 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M20.A08", { calendarId: c.id, bufferMinutes: 0 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M20.A09", { calendarId: c.id, visibility: "private" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M20.A04", { calendarId: "cal_99999", name: "Missing" })).code, "NOT_FOUND");
});

test("unknown input field is INVALID, and list is name then id with total before the limit", async () => {
  const w = await testWorld();
  const c = w.f.calendar();
  assert.equal(failure(() => w.call("M20.A02", { calendarId: c.id, madeUp: 1 })).code, "INVALID");
  w.f.calendar({ name: "SortMe Bravo" });
  w.f.calendar({ name: "SortMe Alpha" });
  const listed = w.call("M20.A03", { query: "SortMe", limit: 1 });
  assert.equal(listed.total, 2);
  assert.equal(listed.items[0].name, "SortMe Alpha");
  const created = w.call("M20.A01", { name: "Defaults" });
  assert.deepEqual([created.timezone, created.durationMinutes, created.bufferMinutes, created.visibility, created.status, created.hostIds], ["America/New_York", 30, 0, "private", "active", []]);
});
