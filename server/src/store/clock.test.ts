import assert from "node:assert/strict";
import { test } from "node:test";
import { atLocal, frozenClock, nowBlock, weekdayDates, zonedInstant } from "./clock.js";

test("atLocal follows New York across both daylight-saving changes", () => {
  assert.equal(atLocal("2026-01-15", "09:00:00").toISOString(), "2026-01-15T14:00:00.000Z");
  assert.equal(atLocal("2026-07-04", "09:00:00").toISOString(), "2026-07-04T13:00:00.000Z");
});

test("atLocal: a time that happens twice is its first occurrence", () => {
  // 01:30 on 1 Nov 2026 happens in EDT (05:30Z) and again in EST (06:30Z).
  assert.equal(atLocal("2026-11-01", "01:30:00").toISOString(), "2026-11-01T05:30:00.000Z");
});

test("atLocal: a time that never happens lands after the gap, not before it", () => {
  // Clocks jump from 02:00 to 03:00 on 8 Mar 2026, so 02:30 does not exist. It lands at 03:30 EDT, not 01:30 EST.
  assert.equal(atLocal("2026-03-08", "02:30:00").toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(atLocal("2026-03-08", "01:59:00").toISOString(), "2026-03-08T06:59:00.000Z");
  assert.equal(atLocal("2026-03-08", "03:00:00").toISOString(), "2026-03-08T07:00:00.000Z");
});

test("zonedInstant takes HH:MM and HH:MM:SS, in any zone", () => {
  assert.equal(zonedInstant("2026-07-04", "09:00", "Europe/London"), "2026-07-04T08:00:00.000Z");
  assert.equal(zonedInstant("2026-07-04", "09:00:30", "Europe/London"), "2026-07-04T08:00:30.000Z");
  assert.equal(zonedInstant("2026-01-15", "09:00", "Asia/Kolkata"), "2026-01-15T03:30:00.000Z");
});

test("bare weekdays use the upcoming date; an explicit next weekday is strictly future", () => {
  assert.deepEqual(weekdayDates(frozenClock()).Friday, { upcoming: "2026-10-23", next: "2026-10-23" });
  assert.deepEqual(weekdayDates(frozenClock("2026-10-23T14:00:00Z")).Friday, { upcoming: "2026-10-23", next: "2026-10-30" });
  assert.deepEqual(weekdayDates(frozenClock("2026-10-24T14:00:00Z")).Friday, { upcoming: "2026-10-30", next: "2026-10-30" });
});

test("weekday dates follow the account's local date, not UTC or client timezone", () => {
  assert.deepEqual(weekdayDates(frozenClock("2026-10-24T02:00:00Z")).Friday, { upcoming: "2026-10-23", next: "2026-10-30" });
  assert.deepEqual(weekdayDates(frozenClock("2026-11-01T06:30:00Z")).Monday, { upcoming: "2026-11-02", next: "2026-11-02" });
  assert.match(nowBlock(frozenClock()), /Friday.*2026-10-23/);
});

test("nowBlock snapshots one instant so a midnight rollover cannot disagree with its weekday table", () => {
  let calls = 0;
  const block = nowBlock({ now: () => new Date(calls++ ? "2026-10-24T04:00:00Z" : "2026-10-24T03:59:59Z") });
  assert.equal(calls, 1);
  assert.match(block, /today = 2026-10-23/);
  assert.match(block, /Friday.*upcoming.*2026-10-23/);
});
