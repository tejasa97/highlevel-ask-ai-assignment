import { Fixtures, type Input } from "../../store/fixtures.js";
import { Calendar } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    calendar(o?: Input<Calendar>): Calendar;
  }
}

Fixtures.prototype.calendar = function (this: Fixtures, o: Input<Calendar> = {}): Calendar {
  const n = this.seq();
  return this.make("calendars", "cal", Calendar, {
    name: `Calendar ${n}`,
    description: null,
    timezone: "America/New_York",
    hostIds: [],
    durationMinutes: 30,
    bufferMinutes: 0,
    visibility: "private",
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
