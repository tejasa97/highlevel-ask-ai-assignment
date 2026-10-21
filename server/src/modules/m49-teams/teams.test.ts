import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";

test("create: duplicate name (any case) is DUPLICATE; manager joins as a member; inactive members are refused", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M49.A01", { name: " sales " })).code, "DUPLICATE");
  const t = w.call("M49.A01", { name: "EMEA", memberIds: ["us_4"], managerId: "us_5" });
  assert.deepEqual(t.memberIds, ["us_4", "us_5"]);
  assert.equal(failure(() => w.call("M49.A01", { name: "Ghosts", memberIds: ["us_9"] })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M49.A01", { name: "Nobody", memberIds: ["us_404"] })).code, "NOT_FOUND");
});

test("sales reps can't manage teams", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M49.A05", { teamId: "tm_1", userId: "us_6" }, "us_4")).code, "PERMISSION");
  assert.equal(w.call("M49.A05", { teamId: "tm_1", userId: "us_6" }, "us_2").memberIds.includes("us_6"), true, "managers can");
});

test("membership: no double adds, no removing non-members or the manager, no deactivated users", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M49.A05", { teamId: "tm_1", userId: "us_4" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M49.A05", { teamId: "tm_1", userId: "us_9" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M49.A06", { teamId: "tm_1", userId: "us_8" })).code, "CONFLICT");
  assert.match(failure(() => w.call("M49.A06", { teamId: "tm_1", userId: "us_2" })).message, /M49\.A07/);
  w.call("M49.A07", { teamId: "tm_1", userId: "us_4" });
  assert.ok(!w.call("M49.A06", { teamId: "tm_1", userId: "us_2" }).memberIds.includes("us_2"), "after a new manager, the old one can leave");
});

test("rename: same name elsewhere is DUPLICATE; renaming to itself is fine", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M49.A04", { teamId: "tm_1", name: "Support" })).code, "DUPLICATE");
  assert.equal(w.call("M49.A04", { teamId: "tm_1", name: "SALES", description: "Closers" }).name, "SALES");
});

test("archived teams are read-only and drop out of lists and resolution", async () => {
  const w = await testWorld();
  w.call("M49.A10", { teamId: "tm_3" });
  assert.equal(failure(() => w.call("M49.A10", { teamId: "tm_3" })).code, "CONFLICT");
  assert.equal(failure(() => w.call("M49.A05", { teamId: "tm_3", userId: "us_4" })).code, "CONFLICT");
  assert.ok(!w.call("M49.A03", {}).items.some((t: { id: string }) => t.id === "tm_3"));
  assert.ok(w.call("M49.A03", { includeArchived: true }).items.some((t: { id: string }) => t.id === "tm_3"));
  assert.equal(w.call("M49.A01", { name: "Marketing" }).name, "Marketing", "an archived team's name is free again");
});

test("strategy: setting the current one is CONFLICT", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M49.A08", { teamId: "tm_1", strategy: "round_robin" })).code, "CONFLICT");
  assert.equal(w.call("M49.A08", { teamId: "tm_1", strategy: "least_busy" }).strategy, "least_busy");
});

test("workload: active members only, with overdue tasks and open leads", async () => {
  const w = await testWorld();
  const wl = w.call("M49.A09", { teamId: "tm_1" });
  const ids = wl.members.map((m: { userId: string }) => m.userId);
  assert.ok(!ids.includes("us_9"), "Dan is deactivated");
  const lucia = wl.members.find((m: { userId: string }) => m.userId === "us_3");
  assert.equal(lucia.available, false);
  assert.ok(lucia.overdueTasks >= 1);
  const extra = w.f.user();
  w.call("M49.A05", { teamId: "tm_1", userId: extra.id });
  w.f.task({ assigneeId: extra.id, dueDate: w.f.day(-2) });
  w.f.lead({ ownerId: extra.id });
  w.f.lead({ ownerId: extra.id, status: "converted" });
  const mine = w.call("M49.A09", { teamId: "tm_1" }).members.find((m: { userId: string }) => m.userId === extra.id);
  assert.deepEqual({ ...mine, name: undefined }, { userId: extra.id, name: undefined, available: true, openTasks: 1, overdueTasks: 1, openLeads: 1 });
});

test("team details name the manager and members", async () => {
  const w = await testWorld();
  const t = w.call("M49.A02", { teamId: "tm_1" });
  assert.equal(t.managerName, "Raj Iyer");
  assert.ok(t.members.some((m: { name: string }) => m.name === "Lucia Gomez"));
});
