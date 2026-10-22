import { Fixtures, type Input } from "../../store/fixtures.js";
import { SavedReport } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    savedReport(o?: Input<SavedReport>): SavedReport;
  }
}

Fixtures.prototype.savedReport = function (this: Fixtures, o: Input<SavedReport> = {}): SavedReport {
  const n = this.seq();
  return this.make("saved_reports", "rpt", SavedReport, {
    name: `Report ${n}`,
    metric: "new_contacts",
    filters: {},
    dateRange: { from: this.day(-30), to: this.today },
    groupBy: null,
    schedule: null,
    lastRunAt: null,
    createdBy: "us_1",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
