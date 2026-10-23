import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import { weekday, zonedInstant } from "./clock-local.js";

test("zonedInstant follows the calendar timezone", () => {
  assert.equal(zonedInstant("2026-10-21", "09:00", "America/Chicago"), "2026-10-21T14:00:00.000Z");
  assert.equal(zonedInstant("2026-10-21", "10:00", "America/New_York"), "2026-10-21T14:00:00.000Z");
  assert.equal(zonedInstant("2026-10-21", "09:00", "Europe/London"), "2026-10-21T08:00:00.000Z");
  assert.equal(weekday("2026-10-21"), "wed");
  assert.equal(weekday("2026-10-25"), "sun");
});

test("slots are working hours in the calendar zone, and a free host keeps the time", async () => {
  const w = await testWorld();
  const ada = w.f.user({ name: "Ada Host" });
  const bea = w.f.user({ name: "Bea Host" });
  const cal = w.f.calendar({
    timezone: "America/Chicago",
    durationMinutes: 30,
    bufferMinutes: 0,
    hostIds: [bea.id, ada.id],
  });
  w.f.availability({
    calendarId: cal.id,
    weekly: { wed: [{ start: "09:00", end: "11:00" }] },
    minNoticeMinutes: 0,
    maxHorizonDays: 7,
  });
  const open = w.call("M22.A09", { calendarId: cal.id, from: "2026-10-21", to: "2026-10-21", limit: 100 });
  const at = (iso: string) => open.items.filter((s: { start: string }) => s.start === iso).map((s: { hostId: string }) => s.hostId).sort();
  assert.deepEqual(at("2026-10-21T14:00:00.000Z"), [ada.id, bea.id].sort());
  assert.deepEqual(at("2026-10-21T15:30:00.000Z"), [ada.id, bea.id].sort());
  assert.equal(open.total, 8);

  w.f.appointment({ hostId: ada.id, calendarId: null, startAt: "2026-10-21T14:00:00.000Z", endAt: "2026-10-21T14:30:00.000Z", status: "booked" });
  const oneBusy = w.call("M22.A09", { calendarId: cal.id, from: "2026-10-21", to: "2026-10-21", limit: 100 });
  assert.deepEqual(
    oneBusy.items.filter((s: { start: string }) => s.start === "2026-10-21T14:00:00.000Z").map((s: { hostId: string }) => s.hostId),
    [bea.id],
  );
  assert.equal(oneBusy.items.some((s: { start: string; hostId: string }) => s.start === "2026-10-21T14:30:00.000Z" && s.hostId === ada.id), true);

  const backToBack = w.call("M22.A10", { calendarId: cal.id, startAt: "2026-10-21T14:30:00.000Z", hostId: ada.id });
  assert.equal(backToBack.free, true);
});

test("blocks, buffers, overrides, notice and horizon cut the grid", async () => {
  const w = await testWorld();
  const host = w.f.user();
  const cal = w.f.calendar({ timezone: "America/Chicago", durationMinutes: 30, bufferMinutes: 30, hostIds: [host.id] });
  w.f.availability({
    calendarId: cal.id,
    weekly: {
      wed: [{ start: "09:00", end: "11:00" }],
      thu: [{ start: "12:00", end: "12:30" }],
      fri: [{ start: "12:00", end: "12:30" }],
    },
    blocks: [{ id: "tb_1", date: "2026-10-21", start: "10:00", end: "10:30", reason: "Lunch" }],
    minNoticeMinutes: 0,
    maxHorizonDays: 1,
  });
  w.f.appointment({ hostId: host.id, calendarId: cal.id, startAt: "2026-10-21T14:00:00.000Z", endAt: "2026-10-21T14:30:00.000Z", status: "booked" });
  const wed = w.call("M22.A09", { calendarId: cal.id, from: "2026-10-21", to: "2026-10-21", limit: 100 });
  // 09:00 appointment plus 30 minutes of buffer covers through 10:00. 10:00-10:30 is blocked. 10:30 remains.
  assert.deepEqual(wed.items.map((s: { start: string }) => s.start), ["2026-10-21T15:30:00.000Z"]);

  w.call("M22.A03", { calendarId: cal.id, date: "2026-10-21", ranges: [] });
  assert.equal(w.call("M22.A09", { calendarId: cal.id, from: "2026-10-21", to: "2026-10-21" }).total, 0);
  w.call("M22.A04", { calendarId: cal.id, date: "2026-10-21" });
  assert.equal(w.call("M22.A09", { calendarId: cal.id, from: "2026-10-21", to: "2026-10-21" }).total, 1);

  const horizon = w.call("M22.A09", { calendarId: cal.id, to: "2026-11-01", limit: 100 });
  const days = [...new Set(horizon.items.map((s: { start: string }) => s.start.slice(0, 10)))];
  assert.deepEqual(days, ["2026-10-21", "2026-10-22"]);

  w.call("M22.A07", { calendarId: cal.id, minNoticeMinutes: 120 });
  const noticed = w.call("M22.A09", { calendarId: cal.id, from: "2026-10-21", to: "2026-10-21" });
  assert.equal(noticed.total, 0);

  const tooSoon = w.call("M22.A10", { calendarId: cal.id, startAt: "2026-10-21T15:30:00.000Z", hostId: host.id });
  assert.equal(tooSoon.free, false);
  assert.deepEqual(tooSoon.reasons, ["before the minimum booking notice"]);
});

test("conflict check is read-only and reports hours, blocks, hosts and horizon", async () => {
  const w = await testWorld();
  const host = w.f.user();
  const other = w.f.user();
  const cal = w.f.calendar({ timezone: "America/Chicago", durationMinutes: 30, bufferMinutes: 0, hostIds: [host.id] });
  w.f.availability({
    calendarId: cal.id,
    weekly: { wed: [{ start: "09:00", end: "11:00" }] },
    blocks: [{ id: "tb_2", date: "2026-10-21", start: "10:00", end: "10:30", reason: null }],
    minNoticeMinutes: 0,
    maxHorizonDays: 7,
  });
  const before = w.store.audit().length;
  const appts = w.store.all("appointments").length;
  const free = w.call("M22.A10", { calendarId: cal.id, startAt: "2026-10-21T14:15:00.000Z" });
  assert.equal(free.free, true);
  assert.equal(free.hostId, host.id);
  assert.equal(w.store.audit().length, before);
  assert.equal(w.store.all("appointments").length, appts);
  w.call("M22.A09", { calendarId: cal.id, from: "2026-10-21", to: "2026-10-21" });
  assert.equal(w.store.audit().length, before);

  assert.deepEqual(w.call("M22.A10", { calendarId: cal.id, startAt: "2026-10-21T23:00:00.000Z" }).reasons, ["outside working hours"]);
  assert.deepEqual(w.call("M22.A10", { calendarId: cal.id, startAt: "2026-10-21T15:00:00.000Z" }).reasons, ["overlaps a blocked time"]);
  w.f.appointment({ hostId: host.id, calendarId: null, startAt: "2026-10-21T14:00:00.000Z", endAt: "2026-10-21T15:00:00.000Z", status: "booked" });
  assert.deepEqual(w.call("M22.A10", { calendarId: cal.id, startAt: "2026-10-21T14:00:00.000Z", hostId: host.id }).reasons, ["the host is booked"]);
  w.f.appointment({ hostId: other.id, calendarId: cal.id, startAt: "2026-10-21T15:30:00.000Z", endAt: "2026-10-21T16:00:00.000Z", status: "booked" });
  assert.deepEqual(w.call("M22.A10", { calendarId: cal.id, startAt: "2026-10-21T15:30:00.000Z" }).reasons, ["every host is booked"]);

  const solo = w.f.calendar({ timezone: "America/Chicago", durationMinutes: 30, bufferMinutes: 0, hostIds: [] });
  w.f.availability({ calendarId: solo.id, weekly: { wed: [{ start: "09:00", end: "11:00" }] }, minNoticeMinutes: 0, maxHorizonDays: 7 });
  w.f.appointment({ calendarId: solo.id, startAt: "2026-10-21T14:00:00.000Z", endAt: "2026-10-21T14:30:00.000Z", status: "booked" });
  assert.deepEqual(w.call("M22.A10", { calendarId: solo.id, startAt: "2026-10-21T14:00:00.000Z" }).reasons, ["the calendar is booked"]);
  const open = w.call("M22.A10", { calendarId: solo.id, startAt: "2026-10-21T14:30:00.000Z" });
  assert.equal(open.free, true);
  assert.equal(open.hostId, null);

  const later = w.f.calendar({ timezone: "America/Chicago", durationMinutes: 30, hostIds: [] });
  w.f.availability({ calendarId: later.id, weekly: { mon: [{ start: "09:00", end: "17:00" }] }, maxHorizonDays: 1, minNoticeMinutes: 0 });
  const far = w.call("M22.A10", { calendarId: later.id, startAt: "2026-10-26T15:00:00.000Z" });
  assert.equal(far.free, false);
  assert.ok(far.reasons.includes("past the booking horizon"));

  const fresh = w.f.calendar();
  assert.equal(failure(() => w.call("M22.A02", { calendarId: fresh.id })).code, "NOT_FOUND");
  assert.equal(failure(() => w.call("M22.A09", { calendarId: fresh.id })).code, "NOT_FOUND");
});

test("the first write creates availability; later writes refuse no-ops and duplicates", async () => {
  const w = await testWorld();
  const cal = w.f.calendar();
  const created = w.call("M22.A07", { calendarId: cal.id, minNoticeMinutes: 90 });
  assert.equal(created.minNoticeMinutes, 90);
  assert.equal(created.maxHorizonDays, 60);
  assert.deepEqual(created.weekly.mon, []);
  assert.equal(failure(() => w.call("M22.A07", { calendarId: cal.id, minNoticeMinutes: 90 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M22.A01", { calendarId: "cal_99999", hours: [] })).code, "NOT_FOUND");
  w.call("M22.A01", { calendarId: cal.id, hours: [{ weekday: "wed", ranges: [{ start: "09:00", end: "12:00" }] }] });
  assert.equal(failure(() => w.call("M22.A01", { calendarId: cal.id, hours: [{ weekday: "wed", ranges: [{ start: "09:00", end: "12:00" }] }] })).code, "CONFLICT");
  w.call("M22.A03", { calendarId: cal.id, date: "2026-12-24", ranges: [] });
  assert.equal(failure(() => w.call("M22.A03", { calendarId: cal.id, date: "2026-12-24", ranges: [{ start: "10:00", end: "11:00" }] })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M22.A04", { calendarId: cal.id, date: "2026-12-25" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M22.A05", { calendarId: "cal_99999", date: "2026-10-21", start: "12:00", end: "13:00" })).code, "NOT_FOUND");
  assert.equal(failure(() => w.call("M22.A05", { calendarId: cal.id, date: "2026-10-21", start: "13:00", end: "12:00" })).code, "INVALID");
  assert.equal(failure(() => w.call("M22.A06", { calendarId: cal.id, blockId: "tb_99999" })).code, "NOT_FOUND");
  w.call("M22.A08", { calendarId: cal.id, maxHorizonDays: 14 });
  assert.equal(failure(() => w.call("M22.A08", { calendarId: cal.id, maxHorizonDays: 14 })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M22.A09", { calendarId: cal.id, madeUp: 1 })).code, "INVALID");
});

test("a search that starts long before today costs no more than one that starts today", async () => {
  const w = await testWorld();
  const cal = w.f.calendar({ timezone: "America/Chicago", durationMinutes: 30, bufferMinutes: 0, hostIds: [] });
  w.f.availability({ calendarId: cal.id, weekly: { mon: [{ start: "09:00", end: "17:00" }], wed: [{ start: "09:00", end: "17:00" }] }, minNoticeMinutes: 0, maxHorizonDays: 7 });
  const began = Date.now();
  const early = w.call("M22.A09", { calendarId: cal.id, from: "1900-01-01", limit: 100 });
  assert.ok(Date.now() - began < 1000, `took ${Date.now() - began} ms`);
  assert.deepEqual(early.items, w.call("M22.A09", { calendarId: cal.id, limit: 100 }).items);
});
