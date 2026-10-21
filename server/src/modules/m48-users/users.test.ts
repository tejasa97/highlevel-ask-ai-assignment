import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("invite: duplicate email is DUPLICATE, a deactivated match points at reactivate", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M48.A01", { firstName: "X", email: "MAYA.chen@ourco.example", roles: ["sales"] })).code, "DUPLICATE");
  const dan = w.store.get<{ email: string }>("users", "us_9")!;
  const e = failure(() => w.call("M48.A01", { firstName: "Dan", email: dan.email, roles: ["sales"] }));
  assert.equal(e.code, "CONFLICT");
  assert.match(e.message, /M48\.A08/);
});

test("only users.manage holders can invite or change roles", async () => {
  const w = await testWorld();
  const e = failure(() => w.call("M48.A01", { firstName: "X", email: "x@ourco.example", roles: ["sales"] }, "us_4"));
  assert.equal(e.code, "PERMISSION");
  assert.equal(failure(() => w.call("M48.A05", { userId: "us_5", role: "admin" }, "us_2")).code, "PERMISSION", "managers can't grant roles");
});

test("roles: no duplicates, never zero roles, never zero admins", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M48.A05", { userId: "us_2", role: "sales" })).code, "CONFLICT");
  assert.match(failure(() => w.call("M48.A06", { userId: "us_4", role: "sales" })).message, /only role/);
  w.call("M48.A05", { userId: "us_1", role: "sales" });
  assert.match(failure(() => w.call("M48.A06", { userId: "us_1", role: "admin" })).message, /only active admin/);
  w.call("M48.A05", { userId: "us_2", role: "admin" });
  assert.deepEqual(w.call("M48.A06", { userId: "us_1", role: "admin" }).roles, ["sales"]);
});

test("deactivate: not yourself; another admin can do it, a manager can't", async () => {
  const w = await testWorld();
  assert.match(failure(() => w.call("M48.A07", { userId: "us_1" })).message, /own account/);
  const admin2 = w.f.user({ roles: ["admin"] });
  assert.equal(failure(() => w.call("M48.A07", { userId: admin2.id }, "us_2")).code, "PERMISSION");
  assert.equal(w.call("M48.A07", { userId: "us_1" }, admin2.id).user.status, "deactivated");
});

test("deactivate with reassignTo moves open work and leaves teams", async () => {
  const w = await testWorld();
  const lucia = "us_3";
  const r = w.call("M48.A07", { userId: lucia, reassignTo: "us_4" });
  assert.equal(r.user.status, "deactivated");
  assert.ok(r.reassigned.tasks >= 1, "her overdue task moves");
  assert.deepEqual(r.stillOwned, { tasks: 0, leads: 0, contacts: 0, opportunities: 0 });
  assert.ok(r.removedFromTeams.includes("tm_1"));
  assert.equal(w.store.find<{ assigneeId: string; status: string }>("tasks", (t) => t.status === "open" && t.assigneeId === lucia).length, 0);
  assert.equal(failure(() => w.call("M48.A07", { userId: lucia })).code, "CONFLICT", "already deactivated");
});

test("deactivating a team's manager clears the manager", async () => {
  const w = await testWorld();
  w.call("M48.A07", { userId: "us_2", reassignTo: "us_4" });
  assert.equal(w.store.get<{ managerId: string | null }>("teams", "tm_1")!.managerId, null);
});

test("deactivate without reassignTo reports what's left behind; can't hand work to an inactive user", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M48.A07", { userId: "us_3", reassignTo: "us_9" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M48.A07", { userId: "us_3", reassignTo: "us_3" })).code, "INVALID");
  const r = w.call("M48.A07", { userId: "us_3" });
  assert.ok(r.stillOwned.tasks >= 1);
});

test("reactivate only deactivated users; deactivated users have no permissions", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M48.A08", { userId: "us_2" })).code, "CONFLICT");
  assert.deepEqual(w.call("M48.A09", { userId: "us_9" }).permissions, []);
  assert.equal(w.call("M48.A08", { userId: "us_9" }).status, "active");
});

test("permissions say which role grants them", async () => {
  const w = await testWorld();
  const p = w.call("M48.A09", { userId: "us_2" }).permissions as { permission: string; grantedBy: string[] }[];
  assert.deepEqual(p.find((x) => x.permission === "leads.manage")!.grantedBy.sort(), ["manager", "sales"]);
  assert.ok(!p.some((x) => x.permission === "users.manage"));
});

test("list users hides deactivated by default; filters by role, availability and team", async () => {
  const w = await testWorld();
  assert.ok(!w.call("M48.A03", {}).items.some((u: { id: string }) => u.id === "us_9"));
  const freeSales = w.call("M48.A03", { role: "sales", available: true, teamId: "tm_1" }).items.map((u: { id: string }) => u.id);
  assert.ok(!freeSales.includes("us_3"));
  assert.equal(failure(() => w.call("M48.A03", { teamId: "tm_404" })).code, "NOT_FOUND");
});

test("update profile: nothing to change is INVALID; email clash is DUPLICATE; deactivated is read-only", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M48.A04", { userId: "us_2" })).code, "INVALID");
  assert.equal(failure(() => w.call("M48.A04", { userId: "us_2", email: w.store.get<{ email: string }>("users", "us_1")!.email })).code, "DUPLICATE");
  assert.equal(failure(() => w.call("M48.A04", { userId: "us_9", available: true })).code, "CONFLICT");
  assert.equal(w.call("M48.A04", { userId: "us_2", lastName: "Iyengar" }).name, "Raj Iyengar");
});

test("audit activity lists what a user changed, newest first", async () => {
  const w = await testWorld();
  w.call("M48.A04", { userId: "us_3", available: true }, "us_2");
  w.call("M01.A07", { contactId: "ct_1", ownerId: "us_4" }, "us_2");
  const items = w.call("M48.A10", { userId: "us_2" }).items;
  assert.deepEqual(items.map((i: { action: string }) => i.action), ["M01.A07", "M48.A04"]);
  assert.ok(items[0].refs.includes("ct_1"));
});
