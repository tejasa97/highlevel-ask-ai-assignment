import { tableResolver } from "../../registry/lookup.js";
import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { cents, contains, inDateRange, Limit, listOf, Name, page, requirePermission } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import type { Lead } from "../m03-leads/schema.js";
import type { Opportunity } from "../m04-opportunities/schema.js";
import type { Appointment } from "../m21-appointments/schema.js";
import type { Payment } from "../m29-payments/schema.js";
import type { Order } from "../m32-orders/schema.js";
import { previousWindow, weekMonday } from "./clock-local.js";
import { REPORT_GROUPINGS, REPORT_METRICS, SavedReport, type DateRange } from "./schema.js";

export { SavedReport } from "./schema.js";

// Saved reports store a definition only. Every run, compare and export computes rows live.
// pipeline_value ignores the date range and sums open opportunity value.

const ReportId = z.string().describe("saved report id (rpt_…)");
const Filters = z.strictObject({
  ownerId: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  pipelineId: z.string().trim().min(1).optional(),
});
const Range = z.strictObject({ from: z.iso.date(), to: z.iso.date() });

type Metric = (typeof REPORT_METRICS)[number];
type Group = (typeof REPORT_GROUPINGS)[number];
type FilterMap = Record<string, string>;

const Rows = z.object({
  rows: z.array(z.object({ key: z.string(), value: z.number() })),
  total: z.number(),
});

const reportOf = (store: Store, id: string) => mustGet<SavedReport>(store, "saved_reports", id, "saved report");

function cleanFilters(f: z.infer<typeof Filters> | undefined): FilterMap {
  const out: FilterMap = {};
  if (f?.ownerId) out.ownerId = f.ownerId;
  if (f?.source) out.source = f.source;
  if (f?.pipelineId) out.pipelineId = f.pipelineId;
  return out;
}

function sameFilters(a: FilterMap, b: FilterMap): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

function assertRange(range: DateRange): void {
  if (range.from > range.to) throw new ActionError("INVALID", `from ${range.from} is after to ${range.to}`);
}

function nameTaken(store: Store, name: string, exceptId?: string): SavedReport | undefined {
  const n = name.trim().toLowerCase();
  return store.find<SavedReport>("saved_reports", (r) => r.id !== exceptId && r.name.toLowerCase() === n)[0];
}

interface Hit {
  at: string;
  owner: string | null;
  source: string | null;
  amount: number;
}

function collect(store: Store, metric: Metric, filters: FilterMap, range: DateRange): Hit[] {
  const owner = filters.ownerId;
  const source = filters.source;
  const pipeline = filters.pipelineId;
  const hits: Hit[] = [];
  if (metric === "new_contacts") {
    for (const c of store.all<Contact>("contacts")) {
      if (owner && c.ownerId !== owner) continue;
      if (!inDateRange(c.createdAt, range.from, range.to)) continue;
      hits.push({ at: c.createdAt, owner: c.ownerId, source: null, amount: 1 });
    }
  } else if (metric === "new_leads") {
    for (const l of store.all<Lead>("leads")) {
      if (owner && l.ownerId !== owner) continue;
      if (source && l.source !== source) continue;
      if (!inDateRange(l.createdAt, range.from, range.to)) continue;
      hits.push({ at: l.createdAt, owner: l.ownerId, source: l.source, amount: 1 });
    }
  } else if (metric === "won_deals") {
    for (const o of store.all<Opportunity>("opportunities")) {
      if (o.status !== "won" || !o.closedAt) continue;
      if (owner && o.ownerId !== owner) continue;
      if (pipeline && o.pipelineId !== pipeline) continue;
      if (!inDateRange(o.closedAt, range.from, range.to)) continue;
      hits.push({ at: o.closedAt, owner: o.ownerId, source: null, amount: 1 });
    }
  } else if (metric === "pipeline_value") {
    for (const o of store.all<Opportunity>("opportunities")) {
      if (o.status !== "open") continue;
      if (owner && o.ownerId !== owner) continue;
      if (pipeline && o.pipelineId !== pipeline) continue;
      hits.push({ at: o.createdAt, owner: o.ownerId, source: null, amount: o.value });
    }
  } else if (metric === "revenue") {
    for (const p of store.all<Payment>("payments")) {
      if (p.status !== "succeeded") continue;
      if (owner && p.recordedBy !== owner) continue;
      if (!inDateRange(p.createdAt, range.from, range.to)) continue;
      hits.push({ at: p.createdAt, owner: p.recordedBy, source: null, amount: p.amount });
    }
  } else if (metric === "appointments_booked") {
    for (const a of store.all<Appointment>("appointments")) {
      if (owner && a.hostId !== owner) continue;
      if (!inDateRange(a.createdAt, range.from, range.to)) continue;
      hits.push({ at: a.createdAt, owner: a.hostId, source: null, amount: 1 });
    }
  } else {
    for (const o of store.all<Order>("orders")) {
      if (o.status !== "submitted" && o.status !== "fulfilled") continue;
      if (!o.submittedAt || !inDateRange(o.submittedAt, range.from, range.to)) continue;
      hits.push({ at: o.submittedAt, owner: null, source: null, amount: 1 });
    }
  }
  return hits;
}

function bucket(group: Group, hit: Hit): string {
  if (group === "day") return hit.at.slice(0, 10);
  if (group === "week") return weekMonday(hit.at);
  if (group === "month") return hit.at.slice(0, 7);
  if (group === "owner") return hit.owner ?? "(none)";
  return hit.source ?? "(none)";
}

function compute(store: Store, report: SavedReport, range: DateRange): z.infer<typeof Rows> {
  assertRange(range);
  const money = report.metric === "pipeline_value" || report.metric === "revenue";
  const round = (n: number) => (money ? cents(n) : n);
  const hits = collect(store, report.metric, report.filters, range);
  const raw = hits.reduce((s, h) => s + h.amount, 0);
  if (!report.groupBy) return { rows: [{ key: "all", value: round(raw) }], total: round(raw) };
  const grouped = new Map<string, number>();
  for (const hit of hits) {
    const key = bucket(report.groupBy, hit);
    grouped.set(key, (grouped.get(key) ?? 0) + hit.amount);
  }
  const rows = [...grouped.entries()]
    .map(([key, value]) => ({ key, value: round(value) }))
    .sort((a, b) => a.key.localeCompare(b.key) || 0);
  return { rows, total: round(raw) };
}

function csvOf(rows: { key: string; value: number }[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll("\"", "\"\"")}"` : s);
  return ["key,value", ...rows.map((r) => `${esc(r.key)},${r.value}`)].join("\n");
}

const createReport = defineAction({
  id: "M50.A01",
  description: "Save a report definition: a metric, exact-match filters, an inclusive date range and optional grouping. Results are not stored. pipeline_value ignores the date range and sums open opportunity value. Unlike Update report filters, this creates the report.",
  risk: "write",
  input: z.strictObject({
    name: Name,
    metric: z.enum(REPORT_METRICS),
    filters: Filters.optional(),
    dateRange: Range,
    groupBy: z.enum(REPORT_GROUPINGS).nullable().optional(),
  }),
  output: SavedReport,
  entities: { produces: "report" },
  example: () => ({ name: "New contacts this month", metric: "new_contacts", dateRange: { from: "2026-10-01", to: "2026-10-21" } }),
  handler: (a, { store, clock, actorId }) => {
    const name = a.name.trim();
    const dup = nameTaken(store, name);
    if (dup) throw new ActionError("DUPLICATE", `A report called "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    assertRange(a.dateRange);
    const now = clock.now().toISOString();
    return store.insert("saved_reports", "rpt", {
      name,
      metric: a.metric,
      filters: cleanFilters(a.filters),
      dateRange: a.dateRange,
      groupBy: a.groupBy ?? null,
      schedule: null,
      lastRunAt: null,
      createdBy: actorId ?? "us_1",
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getReport = defineAction({
  id: "M50.A02",
  description: "Get one saved report definition: metric, filters, date range, grouping, schedule and last run. Unlike List saved reports, this loads a single report by id and does not compute rows.",
  risk: "read",
  input: z.strictObject({ reportId: ReportId }),
  output: SavedReport,
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id }),
  handler: ({ reportId }, { store }) => reportOf(store, reportId),
});

const listReports = defineAction({
  id: "M50.A03",
  description: "List saved report definitions by metric or name, sorted by name then id. This is discovery only: it does not answer questions about totals, rankings or metric values. For those, select a definition then use M50.A07 Run report. Unlike Get report definition, this returns a page.",
  risk: "read",
  input: z.strictObject({ metric: z.enum(REPORT_METRICS).optional(), query: z.string().optional(), limit: Limit }),
  output: listOf(SavedReport),
  entities: { produces: "report" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<SavedReport>(
      "saved_reports",
      (r) => (!a.metric || r.metric === a.metric) && (!a.query || contains(r.name, a.query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateFilters = defineAction({
  id: "M50.A04",
  description: "Replace a report's exact-match filters. ownerId matches a contact, lead or opportunity owner, a payment's recordedBy, or an appointment host. source applies to leads only. pipelineId applies to opportunities only. Other metrics ignore filters that don't apply to them. Unlike Set report date range, this does not change the window. The same filters are refused.",
  risk: "write",
  input: z.strictObject({ reportId: ReportId, filters: Filters }),
  output: SavedReport,
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id, filters: { ownerId: "us_1" } }),
  handler: (a, { store, clock }) => {
    const r = reportOf(store, a.reportId);
    const filters = cleanFilters(a.filters);
    if (sameFilters(filters, r.filters)) throw new ActionError("CONFLICT", "The report already has that value");
    return store.update<SavedReport>("saved_reports", r.id, { filters, updatedAt: clock.now().toISOString() });
  },
});

const setRange = defineAction({
  id: "M50.A05",
  description: "Replace a report's inclusive YYYY-MM-DD date range. pipeline_value ignores the date range even after this change. Unlike Update report filters, this does not change owner, source or pipeline filters. The same range is refused.",
  risk: "write",
  input: z.strictObject({ reportId: ReportId, from: z.iso.date(), to: z.iso.date() }),
  output: SavedReport,
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id, from: "2026-10-01", to: "2026-10-21" }),
  handler: (a, { store, clock }) => {
    const r = reportOf(store, a.reportId);
    const dateRange = { from: a.from, to: a.to };
    assertRange(dateRange);
    if (r.dateRange.from === a.from && r.dateRange.to === a.to) throw new ActionError("CONFLICT", "The report already has that value");
    return store.update<SavedReport>("saved_reports", r.id, { dateRange, updatedAt: clock.now().toISOString() });
  },
});

const setGrouping = defineAction({
  id: "M50.A06",
  description: "Set or clear how rows are grouped: day, week (Monday via UTC), month, owner or source. A missing owner or source key is (none). Unlike Set report date range, this does not change which records qualify. The same grouping is refused.",
  risk: "write",
  input: z.strictObject({ reportId: ReportId, groupBy: z.enum(REPORT_GROUPINGS).nullable() }),
  output: SavedReport,
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id, groupBy: "day" }),
  handler: (a, { store, clock }) => {
    const r = reportOf(store, a.reportId);
    if (r.groupBy === a.groupBy) throw new ActionError("CONFLICT", "The report already has that value");
    return store.update<SavedReport>("saved_reports", r.id, { groupBy: a.groupBy, updatedAt: clock.now().toISOString() });
  },
});

const runReport = defineAction({
  id: "M50.A07",
  description: "Run a saved report and return live rows plus a total. With no grouping, rows is a single key all. This writes lastRunAt. pipeline_value ignores the date range and sums the value of every open opportunity. Unlike Compare report periods, this uses only the saved range. Unlike M09.A06 Preview matching records, this runs a saved report, not a smart list's filter. Requires reports.view.",
  risk: "write",
  query: true, // Only lastRunAt/updatedAt bookkeeping; the execution risk and reports.view check stay unchanged.
  input: z.strictObject({ reportId: ReportId }),
  output: Rows,
  siblings: ["M09.A06"],
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id }),
  handler: ({ reportId }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "reports.view");
    const r = reportOf(store, reportId);
    const result = compute(store, r, r.dateRange);
    store.update<SavedReport>("saved_reports", r.id, { lastRunAt: clock.now().toISOString(), updatedAt: clock.now().toISOString() });
    return result;
  },
});

const compare = defineAction({
  id: "M50.A08",
  description: "Compare a saved report with the previous window of the same length immediately before from. Both sides are computed live and nothing is saved. pipeline_value ignores the date range, so both windows show the same open-pipeline sum. Unlike Run report, this does not set lastRunAt. Requires reports.view.",
  risk: "read",
  input: z.strictObject({ reportId: ReportId }),
  output: z.object({ current: Rows, previous: Rows }),
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id }),
  handler: ({ reportId }, { store, actorId }) => {
    requirePermission(store, actorId, "reports.view");
    const r = reportOf(store, reportId);
    const previous = previousWindow(r.dateRange.from, r.dateRange.to);
    return { current: compute(store, r, r.dateRange), previous: compute(store, r, previous) };
  },
});

const exportReport = defineAction({
  id: "M50.A09",
  description: "Export the same live rows as running the report, plus a csv string of key and value. Nothing is saved and lastRunAt is left unchanged. pipeline_value ignores the date range and sums every open opportunity. Unlike Run report, this does not record a run. Unlike M09.A08 Export matching records, this exports a saved report's rows, not a smart list's records. Requires reports.view.",
  risk: "read",
  input: z.strictObject({ reportId: ReportId }),
  output: Rows.extend({ csv: z.string() }),
  siblings: ["M09.A08"],
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id }),
  handler: ({ reportId }, { store, actorId }) => {
    requirePermission(store, actorId, "reports.view");
    const r = reportOf(store, reportId);
    const result = compute(store, r, r.dateRange);
    return { ...result, csv: csvOf(result.rows) };
  },
});

const schedule = defineAction({
  id: "M50.A10",
  description: "Schedule a saved report for daily, weekly or monthly delivery to the given addresses. This stores the schedule only and does not send mail or insert an email. Unlike Run report, nothing is calculated. Requires reports.view and messaging.send.",
  risk: "external",
  input: z.strictObject({
    reportId: ReportId,
    frequency: z.enum(["daily", "weekly", "monthly"]),
    recipients: z.array(z.email()).min(1),
  }),
  output: SavedReport,
  entities: { consumes: ["report"] },
  example: (f) => ({ reportId: f.savedReport().id, frequency: "weekly", recipients: ["ops@ourco.example"] }),
  handler: (a, { store, clock, actorId }) => {
    requirePermission(store, actorId, "reports.view");
    requirePermission(store, actorId, "messaging.send");
    const r = reportOf(store, a.reportId);
    const next = { frequency: a.frequency, recipients: a.recipients };
    if (r.schedule && r.schedule.frequency === next.frequency && r.schedule.recipients.join("\n") === next.recipients.join("\n")) {
      throw new ActionError("CONFLICT", "The report already has that delivery schedule");
    }
    return store.update<SavedReport>("saved_reports", r.id, { schedule: next, updatedAt: clock.now().toISOString() });
  },
});

export default {
  resolvers: {
    report: tableResolver("saved_reports", "name", {"metric":"metric"}),
  },
  actions: [createReport, getReport, listReports, updateFilters, setRange, setGrouping, runReport, compare, exportReport, schedule],
} satisfies ModuleExports;
