import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, registry, testWorld } from "../../testkit.js";
import { mentions } from "../../retrieval/mentions.js";

test("listing identity includes normalized name, address and directory; updates recheck collisions", async () => {
  const w = await testWorld();
  const args = {
    name: "Cedar Clinic",
    address: "1 Cedar Rd",
    phone: "+15550123456",
    directory: "google",
  };
  const l = w.call("M46.A01", args);
  assert.equal(l.publishedVersion, null);
  assert.equal(
    failure(() => w.call("M46.A01", { ...args, name: "cedar CLINIC" })).code,
    "DUPLICATE",
  );
  w.call("M46.A01", { ...args, directory: "yelp" });
  const branch = w.call("M46.A01", { ...args, address: "2 Cedar Rd" });
  assert.equal(
    failure(() =>
      w.call("M46.A05", { listingId: branch.id, address: "1 Cedar Rd" }),
    ).code,
    "DUPLICATE",
  );
  assert.equal(w.call("M46.A03", { query: "Cedar Clinic", limit: 1 }).total, 3);
});
test("name/address/phone/categories edits increment version and reject no-ops", async () => {
  const w = await testWorld(),
    l = w.f.listing();
  const changes = [
    ["M46.A04", { name: "Changed" }],
    ["M46.A05", { address: "9 Other Road" }],
    ["M46.A06", { phone: "+15550999999" }],
    ["M46.A08", { categories: ["dentist", "dentist"] }],
  ] as const;
  for (const [i, [id, args]] of changes.entries()) {
    const r = w.call(id, { listingId: l.id, ...args });
    assert.equal(r.version, i + 2);
    assert.equal(
      failure(() => w.call(id, { listingId: l.id, ...args })).code,
      "CONFLICT",
    );
  }
  assert.deepEqual(w.call("M46.A02", { listingId: l.id }).categories, [
    "dentist",
  ]);
  assert.equal(
    failure(() => w.call("M46.A06", { listingId: l.id, phone: "123" })).code,
    "INVALID",
  );
  assert.equal(
    failure(() => w.call("M46.A08", { listingId: l.id, categories: [] })).code,
    "INVALID",
  );
});
test("hours validate whole week, explicit closed days, invalid times and overnight intervals", async () => {
  const w = await testWorld(),
    l = w.f.listing(),
    hours = { ...l.hours, monday: { open: "09:00", close: "17:00" } };
  const r = w.call("M46.A07", { listingId: l.id, hours });
  assert.equal(r.timezone, "America/New_York");
  assert.equal(r.hours.sunday, null);
  for (const interval of [
    { open: "18:00", close: "09:00" },
    { open: "09:00", close: "09:00" },
    { open: "25:00", close: "26:00" },
  ])
    assert.equal(
      failure(() =>
        w.call("M46.A07", {
          listingId: l.id,
          hours: { ...hours, monday: interval },
        }),
      ).code,
      "INVALID",
    );
  assert.equal(
    failure(() =>
      w.call("M46.A07", { listingId: l.id, hours: { monday: null } }),
    ).code,
    "INVALID",
  );
});
test("publication/sync derive state from versions, preserve publication across draft changes", async () => {
  const w = await testWorld(),
    l = w.f.listing();
  assert.equal(
    w.call("M46.A10", { listingId: l.id }).status,
    "never_published",
  );
  const p = w.call("M46.A09", { listingId: l.id });
  assert.equal(p.publishedVersion, 1);
  assert.equal(w.call("M46.A10", { listingId: l.id }).status, "synced");
  assert.equal(
    failure(() => w.call("M46.A09", { listingId: l.id })).code,
    "CONFLICT",
  );
  w.call("M46.A04", { listingId: l.id, name: "New name" });
  assert.equal(w.call("M46.A10", { listingId: l.id }).status, "pending");
  assert.equal(w.call("M46.A09", { listingId: l.id }).publishedVersion, 2);
  const failed = w.f.listing({ failureReason: "Directory down" });
  assert.equal(w.call("M46.A10", { listingId: failed.id }).status, "failed");
});
test("publishing to a directory that is down records the failure, keeps what was published, and a retry clears it", async () => {
  const w = await testWorld(),
    ok = w.f.listing({ directory: "google" });
  w.call("M46.A09", { listingId: ok.id });
  w.call("M46.A04", { listingId: ok.id, name: "Renamed" });
  const l = w.f.listing({ directory: "yelp-down", version: 2, publishedVersion: 1, publishedAt: w.f.at(-1) });
  const audit = w.store.audit().length;
  const r = w.call("M46.A09", { listingId: l.id });
  assert.equal(r.publishedVersion, 1, "the earlier publication is untouched");
  assert.equal(r.publishedAt, l.publishedAt);
  assert.equal(r.lastSyncAt, w.clock.now().toISOString());
  assert.match(r.failureReason, /yelp-down is not responding/);
  assert.equal(w.store.audit().length, audit + 1, "the failed attempt is on the audit trail");
  const s = w.call("M46.A10", { listingId: l.id });
  assert.equal(s.status, "failed");
  assert.equal(s.failureReason, r.failureReason);
  // Trying again fails the same way, and an edit starts a fresh attempt (pending, no stale failure).
  assert.equal(w.call("M46.A09", { listingId: l.id }).publishedVersion, 1);
  w.call("M46.A04", { listingId: l.id, name: "Edited while down" });
  assert.equal(w.call("M46.A10", { listingId: l.id }).status, "pending");
  // The directory comes back: the same listing moves to another working directory's behaviour by being republished.
  w.store.update("listings", l.id, { directory: "yelp" });
  const fixed = w.call("M46.A09", { listingId: l.id });
  assert.equal(fixed.publishedVersion, fixed.version);
  assert.equal(fixed.failureReason, null);
  assert.equal(w.call("M46.A10", { listingId: l.id }).status, "synced");
});
test("injected publication failure and denied permission do not change the listing or audit", async () => {
  const w = await testWorld(),
    l = w.f.listing(),
    u = w.f.user({ roles: ["support"] });
  const before = w.store.audit().length;
  assert.equal(
    failure(() => w.call("M46.A09", { listingId: l.id }, u.id)).code,
    "PERMISSION",
  );
  w.f.fault("M46.A09", { code: "UNAVAILABLE", times: 1 });
  assert.equal(
    failure(() => w.call("M46.A09", { listingId: l.id })).code,
    "UNAVAILABLE",
  );
  assert.deepEqual(w.store.get("listings", l.id), l);
  assert.equal(w.store.audit().length, before);
  w.call("M46.A09", { listingId: l.id }, w.f.user({ roles: ["marketing"] }).id);
});
test("same business across directories is ambiguous; location narrows; a person's name stays a contact", async () => {
  const w = await testWorld(),
    reg = await registry();
  assert.equal(reg.resolver("listing")!(w.store, "Maple Dental").length, 2);
  assert.equal(
    reg.resolver("listing")!(w.store, "Maple Dental google").length,
    1,
  );
  assert.deepEqual(
    mentions("What is Elodie Mercer's email?", reg, w.store).map(
      (x) => x.entity,
    ),
    ["contact"],
  );
});
