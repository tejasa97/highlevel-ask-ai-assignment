import assert from "node:assert/strict";
import { test } from "node:test";
import { cents } from "../../registry/helpers.js";
import { failure, registry, testWorld } from "../../testkit.js";
import type { Order } from "../m32-orders/schema.js";
import { Order as OrderSchema } from "../m32-orders/schema.js";
import "./fixtures.js";

test("M50.A01 duplicate name is DUPLICATE", async () => {
  const w = await testWorld();
  w.call("M50.A01", { name: "Weekly pipeline", metric: "pipeline_value", dateRange: { from: "2026-10-01", to: "2026-10-21" } });
  assert.equal(failure(() => w.call("M50.A01", { name: "weekly pipeline", metric: "revenue", dateRange: { from: "2026-10-01", to: "2026-10-21" } })).code, "DUPLICATE");
});

test("M50.A04 same filters is CONFLICT", async () => {
  const w = await testWorld();
  const r = w.f.savedReport({ filters: { ownerId: "us_2" } });
  assert.equal(failure(() => w.call("M50.A04", { reportId: r.id, filters: { ownerId: "us_2" } })).code, "CONFLICT");
});

test("M50.A05 same date range is CONFLICT", async () => {
  const w = await testWorld();
  const r = w.f.savedReport({ dateRange: { from: "2026-10-01", to: "2026-10-21" } });
  assert.equal(failure(() => w.call("M50.A05", { reportId: r.id, from: "2026-10-01", to: "2026-10-21" })).code, "CONFLICT");
});

test("M50.A06 same grouping is CONFLICT", async () => {
  const w = await testWorld();
  const r = w.f.savedReport({ groupBy: "day" });
  assert.equal(failure(() => w.call("M50.A06", { reportId: r.id, groupBy: "day" })).code, "CONFLICT");
});

test("M50.A07 run requires reports.view", async () => {
  const w = await testWorld();
  const r = w.f.savedReport();
  assert.equal(failure(() => w.call("M50.A07", { reportId: r.id }, "us_4")).code, "PERMISSION");
});

test("M50.A10 schedule requires reports.view", async () => {
  const w = await testWorld();
  const r = w.f.savedReport();
  assert.equal(failure(() => w.call("M50.A10", { reportId: r.id, frequency: "daily", recipients: ["a@ourco.example"] }, "us_4")).code, "PERMISSION");
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M50.A02", { reportId: w.f.savedReport().id, madeUp: 1 })).code, "INVALID");
});

test("run description says pipeline_value ignores the date range", async () => {
  const reg = await registry();
  const text = reg.get("M50.A07")?.description ?? "";
  assert.match(text, /pipeline_value ignores the date range/);
});

test("pipeline_value ignores the date range and sums open opportunity value", async () => {
  const w = await testWorld();
  const owner = w.f.user();
  w.f.opportunity({ ownerId: owner.id, value: 10.1, status: "open", createdAt: "2026-01-02T12:00:00.000Z" });
  w.f.opportunity({ ownerId: owner.id, value: 20.2, status: "open", createdAt: "2026-06-01T12:00:00.000Z" });
  w.f.opportunity({ ownerId: owner.id, value: 99, status: "won", closedAt: "2030-01-15T12:00:00.000Z" });
  w.f.opportunity({ value: 50, status: "open" });
  const report = w.f.savedReport({
    metric: "pipeline_value",
    filters: { ownerId: owner.id },
    dateRange: { from: "2030-01-01", to: "2030-01-31" },
    groupBy: "day",
  });
  const ran = w.call("M50.A07", { reportId: report.id });
  assert.equal(ran.total, cents(30.3));
  assert.equal(ran.rows.length, 2);
  assert.equal(w.store.get<{ lastRunAt: string }>("saved_reports", report.id)?.lastRunAt, w.clock.now().toISOString());
  const compared = w.call("M50.A08", { reportId: report.id });
  assert.equal(compared.current.total, compared.previous.total);
  assert.equal(w.store.get<{ lastRunAt: string }>("saved_reports", report.id)?.lastRunAt, w.clock.now().toISOString());
});

test("compare uses the previous window; export is a read; schedule does not insert email", async () => {
  const w = await testWorld();
  const owner = w.f.user();
  const stamp = (day: string) => w.f.contact({ ownerId: owner.id, createdAt: `${day}T15:00:00.000Z` });
  stamp("2026-10-21");
  stamp("2026-10-18");
  stamp("2026-10-17");
  const report = w.f.savedReport({
    metric: "new_contacts",
    filters: { ownerId: owner.id, source: "facebook_ads" },
    dateRange: { from: "2026-10-20", to: "2026-10-21" },
  });
  const compared = w.call("M50.A08", { reportId: report.id });
  assert.equal(compared.current.total, 1);
  assert.equal(compared.previous.total, 1);
  assert.equal(w.store.get<{ lastRunAt: string | null }>("saved_reports", report.id)?.lastRunAt, null);
  const emails = w.store.all("emails").length;
  const exported = w.call("M50.A09", { reportId: report.id });
  assert.equal(exported.total, 1);
  assert.match(exported.csv, /^key,value\n/);
  assert.equal(w.store.all("emails").length, emails);
  assert.equal(failure(() => w.call("M50.A08", { reportId: report.id }, "us_4")).code, "PERMISSION");
  assert.equal(failure(() => w.call("M50.A09", { reportId: report.id }, "us_4")).code, "PERMISSION");
  const billing = w.f.user({ roles: ["billing"] });
  assert.equal(failure(() => w.call("M50.A10", { reportId: report.id, frequency: "weekly", recipients: ["ops@ourco.example"] }, billing.id)).code, "PERMISSION");
  const scheduled = w.call("M50.A10", { reportId: report.id, frequency: "weekly", recipients: ["ops@ourco.example"] }, "us_8");
  assert.deepEqual(scheduled.schedule, { frequency: "weekly", recipients: ["ops@ourco.example"] });
  assert.equal(w.store.all("emails").length, emails);
});

test("filters and order status follow the metric", async () => {
  const w = await testWorld();
  const owner = w.f.user();
  const other = w.f.user();
  const day = "2026-10-21T16:00:00.000Z";
  w.f.lead({ ownerId: owner.id, source: "website", createdAt: day });
  w.f.lead({ ownerId: owner.id, source: "referral", createdAt: day });
  w.f.payment({ recordedBy: owner.id, amount: 40, createdAt: day, status: "succeeded" });
  w.f.payment({ recordedBy: owner.id, amount: 15, createdAt: day, status: "failed" });
  w.f.payment({ recordedBy: other.id, amount: 80, createdAt: day, status: "succeeded" });
  w.f.appointment({ hostId: owner.id, createdAt: day });
  w.f.appointment({ hostId: other.id, createdAt: day });
  const pipeline = w.f.pipeline();
  const otherPipe = w.f.pipeline();
  w.f.opportunity({ ownerId: owner.id, pipelineId: pipeline.id, status: "won", closedAt: day, value: 5 });
  w.f.opportunity({ ownerId: owner.id, pipelineId: otherPipe.id, status: "won", closedAt: day, value: 9 });
  w.f.opportunity({ ownerId: owner.id, pipelineId: pipeline.id, status: "open", value: 7 });
  const contact = w.f.contact();
  const order = (status: Order["status"], submittedAt: string | null) =>
    w.f.make("orders", "ord", OrderSchema, {
      number: `ORD-${w.f.seq()}`,
      contactId: contact.id,
      status,
      lines: [],
      shippingAddress: null,
      couponId: null,
      subtotal: 0,
      discountTotal: 0,
      taxTotal: 0,
      total: 0,
      currency: "USD",
      invoiceId: null,
      submittedAt,
      fulfilledAt: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: day,
      updatedAt: day,
    });
  order("submitted", day);
  order("fulfilled", day);
  order("cancelled", day);
  order("draft", null);
  order("submitted", "2026-01-01T00:00:00.000Z");
  const range = { from: "2026-10-21", to: "2026-10-21" };
  const run = (metric: "new_leads" | "revenue" | "appointments_booked" | "won_deals" | "orders_submitted" | "pipeline_value", filters: Record<string, string>) => {
    const report = w.f.savedReport({ metric, filters, dateRange: range, groupBy: null });
    return w.call("M50.A07", { reportId: report.id }).total as number;
  };
  assert.equal(run("new_leads", { ownerId: owner.id, source: "website" }), 1);
  assert.equal(run("revenue", { ownerId: owner.id }), cents(40));
  assert.equal(run("appointments_booked", { ownerId: owner.id }), 1);
  assert.equal(run("won_deals", { ownerId: owner.id, pipelineId: pipeline.id }), 1);
  assert.equal(run("orders_submitted", { ownerId: owner.id }), 2);
  assert.equal(run("pipeline_value", { ownerId: owner.id, pipelineId: pipeline.id }), cents(7));
});

test("week grouping uses the Monday date", async () => {
  const w = await testWorld();
  const owner = w.f.user();
  w.f.contact({ ownerId: owner.id, createdAt: "2026-10-21T15:00:00.000Z" });
  w.f.contact({ ownerId: owner.id, createdAt: "2026-10-18T15:00:00.000Z" });
  const report = w.f.savedReport({
    metric: "new_contacts",
    filters: { ownerId: owner.id },
    dateRange: { from: "2026-10-01", to: "2026-10-21" },
    groupBy: "week",
  });
  const ran = w.call("M50.A07", { reportId: report.id });
  const keys = (ran.rows as { key: string }[]).map((r) => r.key);
  assert.deepEqual(keys, ["2026-10-12", "2026-10-19"]);
});
