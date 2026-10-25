import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { world } from "../store/world.js";
import { loadRegistry, type Registry } from "./registry.js";
import { tableResolver } from "./lookup.js";
import { mentions } from "../retrieval/mentions.js";

let registry: Registry;
before(async () => { registry = await loadRegistry(); });

describe("named record lookup", () => {
  test("partial title words do not become noisy record mentions, but full labels still link", () => {
    const ctx = world({ base: false });
    ctx.f.product({ name: "Agency Plan" });
    assert.ok(!mentions("Tell me about Agency", registry, ctx.store).some((m) => m.entity === "product"));
    assert.ok(mentions("Tell me about Agency Plan", registry, ctx.store).some((m) => m.entity === "product"));
    assert.equal(registry.resolver("product")!(ctx.store, "Agency").length, 1, "an explicit typed lookup can still use a partial name");
  });
  const fixtures: [string, string, string?][] = [
    ["company", "company"], ["pipeline", "pipeline"], ["smart_list", "smartList"], ["custom_field", "customField", "label"],
    ["template", "messageTemplate"], ["workflow", "workflow"], ["trigger", "eventTrigger"], ["form", "form"], ["survey", "survey"],
    ["calendar", "calendar"], ["booking_page", "bookingPage", "title"], ["event", "event", "title"], ["product", "product"],
    ["price", "price", "label"], ["coupon", "coupon", "code"], ["tax_rule", "taxRule"], ["website", "website"], ["funnel", "funnel"],
    ["landing_page", "landingPage", "title"], ["blog_post", "blogPost", "title"], ["media_asset", "mediaAsset"],
    ["course", "course", "title"], ["lesson", "lesson", "title"], ["community", "community"], ["membership_plan", "membershipPlan"], ["report", "savedReport"],
  ];
  for (const [entity, fixture, label = "name"] of fixtures) test(`${entity} resolves from its real module fixture`, () => {
    const ctx = world({ base: false });
    try {
      const make = (ctx.f as unknown as Record<string, () => Record<string, string>>)[fixture]!;
      const record = make.call(ctx.f);
      const matches = registry.resolver(entity)!(ctx.store, record[label]!);
      assert.ok(matches.some((c) => c.id === record.id), `${entity} did not find ${fixture} ${record[label]}`);
    } finally { ctx.store.close(); }
  });

  test("qualifiers filter before choosing the best name tier, and unknown keys are rejected", () => {
    const ctx = world({ base: false });
    const one = ctx.f.contact({ name: "Alex", company: "Acme" });
    ctx.f.contact({ name: "Alex Morgan", company: "Other" });
    const resolve = registry.resolver("contact")!;
    assert.deepEqual(resolve(ctx.store, "Alex Morgan", { company: "Acme" }), []);
    assert.equal(resolve(ctx.store, "Alex", { company: " ACME " })[0]?.id, one.id);
    assert.throws(() => resolve(ctx.store, "Alex", { invented: "Acme" }), /qualifier/);
  });

  test("the same listing name across directories stays ambiguous until directory is given", () => {
    const ctx = world({ base: false });
    const one = ctx.f.listing({ name: "Acme Dental", directory: "google" });
    ctx.f.listing({ name: "Acme Dental", directory: "yelp" });
    const resolve = registry.resolver("listing")!;
    assert.equal(resolve(ctx.store, "Acme Dental").length, 2);
    assert.equal(resolve(ctx.store, "Acme Dental", { directory: "google" })[0]?.id, one.id);
    assert.equal(resolve(ctx.store, "Acme Dental", { directory: "unknown" }).length, 0);
  });

  test("empty and unsupported qualifiers never silently widen a lookup", () => {
    const ctx = world({ base: false });
    const resolve = tableResolver("calendars");
    assert.throws(() => resolve(ctx.store, "Sales", { timezone: "UTC" }), /qualifier/);
    assert.throws(() => registry.resolver("contact")!(ctx.store, "Alex", { email: " " }), /qualifier/);
  });
});
