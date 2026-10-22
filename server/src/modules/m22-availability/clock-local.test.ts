import assert from "node:assert/strict";
import { test } from "node:test";
import { testWorld } from "../../testkit.js";
import { addMinutes, fromMinutes, minutes, weekday, zonedDate, zonedInstant, zonedTime } from "./clock-local.js";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const LONDON = "Europe/London";
const KOLKATA = "Asia/Kolkata";

// Policy for a wall time that clocks make ambiguous: a time that happens twice (clocks going back) is the FIRST
// occurrence, and a time that never happens (clocks going forward) lands the same distance after the gap.

test("New York: spring forward skips 02:00-03:00, so a time in the gap lands after it", () => {
  assert.equal(zonedInstant("2026-03-08", "01:59", NY), "2026-03-08T06:59:00.000Z");
  assert.equal(zonedInstant("2026-03-08", "02:30", NY), "2026-03-08T07:30:00.000Z");
  assert.equal(zonedInstant("2026-03-08", "03:00", NY), "2026-03-08T07:00:00.000Z");
  assert.equal(zonedTime(zonedInstant("2026-03-08", "02:30", NY), NY), "03:30");
});

test("New York: fall back repeats 01:00-02:00, and the first occurrence wins", () => {
  assert.equal(zonedInstant("2026-11-01", "00:30", NY), "2026-11-01T04:30:00.000Z");
  assert.equal(zonedInstant("2026-11-01", "01:30", NY), "2026-11-01T05:30:00.000Z");
  assert.equal(zonedInstant("2026-11-01", "02:00", NY), "2026-11-01T07:00:00.000Z");
  assert.equal(zonedTime("2026-11-01T05:30:00Z", NY), "01:30");
  assert.equal(zonedTime("2026-11-01T06:30:00Z", NY), "01:30");
});

test("Los Angeles: the same rules at 10:00 UTC in March and 09:00 UTC in November", () => {
  assert.equal(zonedInstant("2026-03-08", "01:30", LA), "2026-03-08T09:30:00.000Z");
  assert.equal(zonedInstant("2026-03-08", "02:30", LA), "2026-03-08T10:30:00.000Z");
  assert.equal(zonedInstant("2026-03-08", "03:00", LA), "2026-03-08T10:00:00.000Z");
  assert.equal(zonedInstant("2026-11-01", "01:30", LA), "2026-11-01T08:30:00.000Z");
  assert.equal(zonedInstant("2026-11-01", "02:00", LA), "2026-11-01T10:00:00.000Z");
});

test("London switches on the last Sunday of March and October, at 01:00 UTC", () => {
  assert.equal(zonedInstant("2026-03-29", "00:30", LONDON), "2026-03-29T00:30:00.000Z");
  assert.equal(zonedInstant("2026-03-29", "01:30", LONDON), "2026-03-29T01:30:00.000Z");
  assert.equal(zonedInstant("2026-03-29", "02:00", LONDON), "2026-03-29T01:00:00.000Z");
  assert.equal(zonedInstant("2026-10-25", "00:30", LONDON), "2026-10-24T23:30:00.000Z");
  assert.equal(zonedInstant("2026-10-25", "01:30", LONDON), "2026-10-25T00:30:00.000Z");
  assert.equal(zonedInstant("2026-10-25", "02:00", LONDON), "2026-10-25T02:00:00.000Z");
});

test("Kolkata is UTC+5:30 all year with no daylight saving", () => {
  assert.equal(zonedInstant("2026-06-15", "09:00", KOLKATA), "2026-06-15T03:30:00.000Z");
  assert.equal(zonedInstant("2026-12-15", "09:00", KOLKATA), "2026-12-15T03:30:00.000Z");
  assert.equal(zonedInstant("2026-01-15", "00:00", KOLKATA), "2026-01-14T18:30:00.000Z");
  assert.equal(zonedDate("2026-01-14T18:30:00Z", KOLKATA), "2026-01-15");
  assert.equal(zonedTime("2026-01-14T18:29:00Z", KOLKATA), "23:59");
});

test("midnight rolls to the next day and a day is 23, 24 or 25 hours long", () => {
  assert.equal(zonedDate("2026-01-01T04:59:00Z", NY), "2025-12-31");
  assert.equal(zonedDate("2026-01-01T05:00:00Z", NY), "2026-01-01");
  assert.equal(zonedTime("2026-01-01T05:00:00Z", NY), "00:00");
  assert.equal(zonedInstant("2026-03-08", "24:00", NY), zonedInstant("2026-03-09", "00:00", NY));
  const hours = (date: string, next: string) => (Date.parse(zonedInstant(next, "00:00", NY)) - Date.parse(zonedInstant(date, "00:00", NY))) / 3_600_000;
  assert.equal(hours("2026-03-08", "2026-03-09"), 23);
  assert.equal(hours("2026-06-01", "2026-06-02"), 24);
  assert.equal(hours("2026-11-01", "2026-11-02"), 25);
});

test("every wall time that exists survives a round trip through zonedInstant and zonedTime", () => {
  for (const [zone, date, gap] of [
    [NY, "2026-03-08", "02"],
    [LA, "2026-03-08", "02"],
    [LONDON, "2026-03-29", "01"],
    [NY, "2026-11-01", ""],
    [LONDON, "2026-10-25", ""],
    [KOLKATA, "2026-06-15", ""],
  ] as const) {
    for (let m = 0; m < 24 * 60; m += 15) {
      const hhmm = fromMinutes(m);
      if (gap && hhmm.startsWith(gap)) continue;
      const instant = zonedInstant(date, hhmm, zone);
      assert.equal(zonedDate(instant, zone), date, `${zone} ${date} ${hhmm} stayed on its date`);
      assert.equal(zonedTime(instant, zone), hhmm, `${zone} ${date} ${hhmm} round trip`);
    }
  }
});

test("small helpers: weekday, addMinutes and minute arithmetic", () => {
  assert.equal(weekday("2026-11-01"), "sun");
  assert.equal(addMinutes("2026-11-01T05:30:00.000Z", 90), "2026-11-01T07:00:00.000Z");
  assert.equal(minutes("24:00"), 1440);
  assert.equal(fromMinutes(minutes("09:05")), "09:05");
});

async function slotsOn(opts: { now?: string; timezone: string; date: string; day: "sun"; start: string; end: string }) {
  const w = await testWorld(opts.now ? { now: opts.now } : {});
  const host = w.f.user();
  const cal = w.f.calendar({ timezone: opts.timezone, durationMinutes: 60, bufferMinutes: 0, hostIds: [host.id] });
  w.f.availability({
    calendarId: cal.id,
    weekly: { [opts.day]: [{ start: opts.start, end: opts.end }] },
    minNoticeMinutes: 0,
    maxHorizonDays: 60,
  });
  return w.call("M22.A09", { calendarId: cal.id, from: opts.date, to: opts.date, limit: 100 }) as { items: { start: string; end: string }[]; total: number };
}

function assertHourLong(items: { start: string; end: string }[]): void {
  for (const s of items) assert.equal(Date.parse(s.end) - Date.parse(s.start), 3_600_000, `${s.start} lasts an hour`);
}

test("M22.A09 New York fall-back day: six hour-long slots, the repeated hour is offered once", async () => {
  const open = await slotsOn({ timezone: NY, date: "2026-11-01", day: "sun", start: "00:00", end: "06:00" });
  assert.deepEqual(
    open.items.map((s) => s.start),
    ["2026-11-01T04:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z", "2026-11-01T09:00:00.000Z", "2026-11-01T10:00:00.000Z"],
  );
  assertHourLong(open.items);
});

test("M22.A09 New York spring-forward day: five hour-long slots, none inside the missing hour", async () => {
  const open = await slotsOn({ now: "2026-03-01T12:00:00.000Z", timezone: NY, date: "2026-03-08", day: "sun", start: "00:00", end: "06:00" });
  assert.deepEqual(
    open.items.map((s) => s.start),
    ["2026-03-08T05:00:00.000Z", "2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-08T09:00:00.000Z"],
  );
  assertHourLong(open.items);
});

test("M22.A09 London fall-back day: four hour-long slots across the UTC date line", async () => {
  const open = await slotsOn({ timezone: LONDON, date: "2026-10-25", day: "sun", start: "00:00", end: "04:00" });
  assert.deepEqual(
    open.items.map((s) => s.start),
    ["2026-10-24T23:00:00.000Z", "2026-10-25T00:00:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-25T03:00:00.000Z"],
  );
  assertHourLong(open.items);
});

test("M22.A09 Kolkata: half-hour offset, slots start on the half hour in UTC", async () => {
  const open = await slotsOn({ timezone: KOLKATA, date: "2026-10-25", day: "sun", start: "09:00", end: "11:00" });
  assert.deepEqual(
    open.items.map((s) => s.start),
    ["2026-10-25T03:30:00.000Z", "2026-10-25T04:30:00.000Z"],
  );
  assertHourLong(open.items);
});
