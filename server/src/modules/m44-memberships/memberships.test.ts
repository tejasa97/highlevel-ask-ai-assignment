import assert from "node:assert/strict";
import { test } from "node:test";
import { failure, testWorld } from "../../testkit.js";
import type { CommunityMember } from "../m43-communities/schema.js";
import type { Enrollment } from "../m42-enrollments/schema.js";
import "../m42-enrollments/fixtures.js";
import "./fixtures.js";

test("M44.A01 duplicate plan name is DUPLICATE", async () => {
  const w = await testWorld();
  w.call("M44.A01", { name: "Gold" });
  assert.equal(failure(() => w.call("M44.A01", { name: "gold" })).code, "DUPLICATE");
});

test("M44.A04 same description is CONFLICT", async () => {
  const w = await testWorld();
  const p = w.f.membershipPlan({ description: "Same" });
  assert.equal(failure(() => w.call("M44.A04", { planId: p.id, description: "Same" })).code, "CONFLICT");
});

test("M44.A05 adding the same entitlement is DUPLICATE", async () => {
  const w = await testWorld();
  const course = w.f.course();
  const p = w.f.membershipPlan({ entitlements: [{ type: "course", targetId: course.id }] });
  assert.equal(failure(() => w.call("M44.A05", { planId: p.id, type: "course", targetId: course.id })).code, "DUPLICATE");
});

test("M44.A06 missing entitlement is CONFLICT", async () => {
  const w = await testWorld();
  const p = w.f.membershipPlan();
  const course = w.f.course();
  assert.equal(failure(() => w.call("M44.A06", { planId: p.id, type: "course", targetId: course.id })).code, "CONFLICT");
});

test("M44.A07 a second active grant is CONFLICT", async () => {
  const w = await testWorld();
  const plan = w.f.membershipPlan();
  const contact = w.f.contact();
  w.call("M44.A07", { planId: plan.id, contactId: contact.id });
  assert.equal(failure(() => w.call("M44.A07", { planId: plan.id, contactId: contact.id })).code, "CONFLICT");
});

test("M44.A08 same expiry is CONFLICT", async () => {
  const w = await testWorld();
  const m = w.f.membership({ expiresAt: w.f.at(4) });
  assert.equal(failure(() => w.call("M44.A08", { membershipId: m.id, expiresAt: m.expiresAt })).code, "CONFLICT");
});

test("M44.A09 revoking twice is CONFLICT", async () => {
  const w = await testWorld();
  const m = w.f.membership();
  w.call("M44.A09", { membershipId: m.id, reason: "Done" });
  assert.equal(failure(() => w.call("M44.A09", { membershipId: m.id, reason: "Again" })).code, "CONFLICT");
});

test("unknown field is INVALID", async () => {
  const w = await testWorld();
  assert.equal(failure(() => w.call("M44.A02", { planId: w.f.membershipPlan().id, madeUp: 1 })).code, "INVALID");
});

test("grant writes an enrollment and a member; revoke reverses both", async () => {
  const w = await testWorld();
  const course = w.f.course({ status: "published" });
  const community = w.f.community();
  const contact = w.f.contact();
  const plan = w.f.membershipPlan({
    entitlements: [
      { type: "course", targetId: course.id },
      { type: "community", targetId: community.id },
    ],
  });
  const granted = w.call("M44.A07", { planId: plan.id, contactId: contact.id });
  const enrollments = w.store.find<Enrollment>("enrollments", (e) => e.contactId === contact.id && e.courseId === course.id);
  assert.equal(enrollments.length, 1);
  assert.equal(enrollments[0]!.membershipId, granted.id);
  assert.equal(enrollments[0]!.status, "active");
  assert.deepEqual(enrollments[0]!.completions, []);
  assert.equal(enrollments[0]!.certificate, null);
  const members = w.store.find<CommunityMember>("community_members", (m) => m.communityId === community.id && m.contactId === contact.id);
  assert.equal(members.length, 1);
  assert.equal(members[0]!.role, "member");
  assert.equal(members[0]!.leftAt, null);
  const courseAccess = w.call("M44.A10", { contactId: contact.id, courseId: course.id });
  const communityAccess = w.call("M44.A10", { contactId: contact.id, communityId: community.id });
  assert.equal(courseAccess.allowed, true);
  assert.equal(communityAccess.allowed, true);
  w.call("M44.A09", { membershipId: granted.id, reason: "Ended" });
  assert.equal(w.store.get<Enrollment>("enrollments", enrollments[0]!.id)?.status, "revoked");
  assert.ok(w.store.get<CommunityMember>("community_members", members[0]!.id)?.leftAt);
  assert.equal(w.call("M44.A10", { contactId: contact.id, courseId: course.id }).allowed, false);
});

test("grant stamps an existing enrollment and clears leftAt", async () => {
  const w = await testWorld();
  const course = w.f.course({ status: "published" });
  const community = w.f.community();
  const contact = w.f.contact();
  const existing = w.f.enrollment({ courseId: course.id, contactId: contact.id });
  const left = w.f.communityMember({ communityId: community.id, contactId: contact.id, leftAt: w.f.at(-2) });
  const plan = w.f.membershipPlan({
    entitlements: [
      { type: "course", targetId: course.id },
      { type: "community", targetId: community.id },
    ],
  });
  const granted = w.call("M44.A07", { planId: plan.id, contactId: contact.id });
  const enrollments = w.store.find<Enrollment>("enrollments", (e) => e.courseId === course.id && e.contactId === contact.id);
  assert.equal(enrollments.length, 1);
  assert.equal(enrollments[0]!.id, existing.id);
  assert.equal(enrollments[0]!.membershipId, granted.id);
  const member = w.store.get<CommunityMember>("community_members", left.id);
  assert.equal(member?.leftAt, null);
  assert.equal(w.store.find<CommunityMember>("community_members", (m) => m.communityId === community.id && m.contactId === contact.id).length, 1);
});

test("check access denies an expired membership", async () => {
  const w = await testWorld();
  const course = w.f.course();
  const contact = w.f.contact();
  const plan = w.f.membershipPlan({ entitlements: [{ type: "course", targetId: course.id }] });
  w.f.membership({ planId: plan.id, contactId: contact.id, expiresAt: w.f.at(-1) });
  const access = w.call("M44.A10", { contactId: contact.id, courseId: course.id });
  assert.equal(access.allowed, false);
  assert.match(access.reason, /expired/);
});
