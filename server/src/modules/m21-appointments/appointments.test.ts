import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("book: 30 minutes by default; past time INVALID; host unavailable, deactivated or busy CONFLICT", async () => {
  const w = await testWorld();
  const c = w.f.contact();
  const a = w.call("M21.A01", { contactId: c.id, hostId: "us_4", startAt: w.f.at(3, 10) });
  assert.equal(Date.parse(a.endAt) - Date.parse(a.startAt), 30 * 60_000);
  assert.deepEqual([a.status, a.title, a.attendees.length], ["booked", `Meeting with ${c.name}`, 1]);
  assert.equal(failure(() => w.call("M21.A01", { contactId: c.id, hostId: "us_4", startAt: w.f.at(-1) })).code, "INVALID");
  assert.equal(failure(() => w.call("M21.A01", { contactId: c.id, hostId: "us_4", startAt: w.f.at(3, 10), endAt: w.f.at(3, 9) })).code, "INVALID");
  assert.match(failure(() => w.call("M21.A01", { contactId: c.id, hostId: "us_3", startAt: w.f.at(3, 10) })).message, /unavailable/);
  assert.equal(failure(() => w.call("M21.A01", { contactId: c.id, hostId: "us_9", startAt: w.f.at(3, 10) })).code, "CONFLICT");
  // Raj has ap_1 at day 2, 15:00–15:30; 15:15 overlaps, 15:30 doesn't.
  const clash = failure(() => w.call("M21.A01", { contactId: c.id, hostId: "us_2", startAt: w.f.at(2, 15).replace(":00:00", ":15:00") }));
  assert.deepEqual([clash.code, (clash.details as { appointmentId: string }).appointmentId], ["CONFLICT", "ap_1"]);
  w.call("M21.A01", { contactId: c.id, hostId: "us_2", startAt: w.f.at(2, 15).replace(":00:00", ":30:00") });
});

test("reschedule: keeps the length; same time CONFLICT; can move within its own slot", async () => {
  const w = await testWorld();
  const ap = w.call("M21.A02", { appointmentId: "ap_3" });
  const moved = w.call("M21.A04", { appointmentId: "ap_3", startAt: w.f.at(7, 10) });
  assert.equal(Date.parse(moved.endAt) - Date.parse(moved.startAt), Date.parse(ap.endAt) - Date.parse(ap.startAt));
  assert.equal(failure(() => w.call("M21.A04", { appointmentId: "ap_3", startAt: w.f.at(7, 10) })).code, "CONFLICT");
  // Shifting by 15 minutes overlaps the old slot, which isn't a clash with itself.
  w.call("M21.A04", { appointmentId: "ap_3", startAt: w.f.at(7, 10).replace(":00:00", ":15:00") });
});

test("cancel, then nothing else applies", async () => {
  const w = await testWorld();
  const ap = w.f.appointment();
  assert.equal(w.call("M21.A05", { appointmentId: ap.id, reason: "postponed" }).cancelReason, "postponed");
  for (const [id, args] of [
    ["M21.A05", { appointmentId: ap.id }],
    ["M21.A04", { appointmentId: ap.id, startAt: w.f.at(5) }],
    ["M21.A06", { appointmentId: ap.id, hostId: "us_4" }],
    ["M21.A07", { appointmentId: ap.id, userId: "us_4" }],
  ] as const) {
    assert.equal(failure(() => w.call(id, args)).code, "CONFLICT", id);
  }
});

test("attendees: no duplicates or host; the main contact can't be removed", async () => {
  const w = await testWorld();
  w.call("M21.A07", { appointmentId: "ap_1", userId: "us_4" });
  assert.equal(failure(() => w.call("M21.A07", { appointmentId: "ap_1", userId: "us_4" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M21.A07", { appointmentId: "ap_1", userId: "us_2" })).code, "CONFLICT", "the host");
  assert.equal(failure(() => w.call("M21.A07", { appointmentId: "ap_1", userId: "us_4", contactId: "ct_1" })).code, "INVALID");
  const ap = w.call("M21.A02", { appointmentId: "ap_1" });
  assert.equal(failure(() => w.call("M21.A08", { appointmentId: "ap_1", attendeeId: ap.contactId })).code, "CONFLICT");
  assert.equal(w.call("M21.A08", { appointmentId: "ap_1", attendeeId: "us_4" }).attendees.length, 1);
  assert.equal(failure(() => w.call("M21.A08", { appointmentId: "ap_1", attendeeId: "us_4" })).code, "NOT_FOUND");
});

test("no-show and completed only once it has started; no-show flags the main person", async () => {
  const w = await testWorld();
  assert.match(failure(() => w.call("M21.A09", { appointmentId: "ap_1" })).message, /hasn't started/);
  assert.equal(failure(() => w.call("M21.A10", { appointmentId: "ap_1" })).code, "CONFLICT");
  const past = w.f.appointment({ startAt: w.f.at(-1), endAt: w.f.at(-1, 15) });
  const ns = w.call("M21.A09", { appointmentId: past.id });
  assert.deepEqual([ns.status, ns.attendees[0].noShow], ["no_show", true]);
  const done = w.f.appointment({ startAt: w.f.at(-2), endAt: w.f.at(-2, 15) });
  assert.equal(w.call("M21.A10", { appointmentId: done.id, outcome: "pilot" }).outcome, "pilot");
});

test("search: booked by default, soonest first; Sarah's booked meeting is with Raj", async () => {
  const w = await testWorld();
  const items = w.call("M21.A03", {}).items as { startAt: string; status: string }[];
  assert.ok(items.every((a) => a.status === "booked"));
  assert.deepEqual(items.map((a) => a.startAt), [...items.map((a) => a.startAt)].sort());
  assert.ok((w.call("M21.A03", { status: "any" }).items as unknown[]).length > items.length);
  const ap1 = w.call("M21.A02", { appointmentId: "ap_1" });
  assert.deepEqual([ap1.hostName, ap1.personName], ["Raj Iyer", "Sarah Johnson"]);
});
