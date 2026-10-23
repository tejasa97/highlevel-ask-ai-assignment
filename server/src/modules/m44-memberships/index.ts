import { tableResolver } from "../../registry/lookup.js";
import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { contains, Limit, listOf, page, person, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Course } from "../m40-courses/schema.js";
import type { Community } from "../m43-communities/schema.js";
import type { CommunityMember } from "../m43-communities/schema.js";
import type { Enrollment } from "../m42-enrollments/schema.js";
import { stillOpen } from "../m42-enrollments/clock-local.js";
import { ENTITLEMENT_TYPES, Membership, MembershipPlan } from "./schema.js";

export { Membership, MembershipPlan } from "./schema.js";

// A plan lists course and community entitlements. Granting it enrolls the contact and joins
// the communities. Revoking reverses those rows. Check access reads the live plan.

const PlanId = z.string().describe("membership plan id (mpl_…)");
const MembershipId = z.string().describe("membership id (mbr_…)");
const ContactId = z.string().describe("contact id (ct_…)");
const Name = z.string().trim().min(1);
const When = z.string().refine((s) => !Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00.000Z` : s)), "expected an ISO date or timestamp");

const planOf = (store: Store, id: string) => mustGet<MembershipPlan>(store, "membership_plans", id, "membership plan");
const membershipOf = (store: Store, id: string) => mustGet<Membership>(store, "memberships", id, "membership");

function editablePlan(store: Store, id: string): MembershipPlan {
  const p = planOf(store, id);
  requireState(`Plan "${p.name}"`, p.status, ["active"], "be changed");
  return p;
}

function nameTaken(store: Store, name: string, exceptId?: string): MembershipPlan | undefined {
  const n = name.trim().toLowerCase();
  return store.find<MembershipPlan>("membership_plans", (p) => p.id !== exceptId && p.name.toLowerCase() === n)[0];
}

function targetExists(store: Store, type: "course" | "community", targetId: string): void {
  if (type === "course") {
    const c = mustGet<Course>(store, "courses", targetId, "course");
    if (c.status === "archived") throw new ActionError("CONFLICT", `${c.title} is archived; pick another course`);
    return;
  }
  const c = mustGet<Community>(store, "communities", targetId, "community");
  if (c.status === "archived") throw new ActionError("CONFLICT", `${c.name} is archived; pick another community`);
}

const PlanView = MembershipPlan.extend({
  members: z.array(z.object({ membershipId: z.string(), contactId: z.string(), name: z.string(), status: z.string(), expiresAt: z.string().nullable() })),
});

const Holder = {
  membershipId: MembershipId.optional(),
  planId: PlanId.optional(),
  contactId: ContactId.optional(),
};

/** The membership a caller means: by its own id, or by plan and contact, since people say "take Priya's Gold membership away". */
function membershipFor(store: Store, a: { membershipId?: string; planId?: string; contactId?: string }): Membership {
  if (a.membershipId) {
    const m = membershipOf(store, a.membershipId);
    if ((a.planId && a.planId !== m.planId) || (a.contactId && a.contactId !== m.contactId)) {
      throw new ActionError("INVALID", "membershipId belongs to a different plan or contact than the one given");
    }
    return m;
  }
  if (!a.planId || !a.contactId) throw new ActionError("INVALID", "Give membershipId, or both planId and contactId");
  const rows = store.find<Membership>("memberships", (m) => m.planId === a.planId && m.contactId === a.contactId && m.status === "active");
  const m = rows[0];
  if (!m) throw new ActionError("NOT_FOUND", `That contact has no active membership on plan ${a.planId}`, { planId: a.planId, contactId: a.contactId });
  return m;
}

const Access = z.object({ allowed: z.boolean(), reason: z.string().nullable() });

const createPlan = defineAction({
  id: "M44.A01",
  description: "Create an active membership plan with a name and optional entitlements. Unlike Grant membership to contact, this defines the package and does not give anyone access yet.",
  risk: "write",
  input: z.strictObject({
    name: Name,
    description: z.string().trim().min(1).nullable().optional(),
    entitlements: z.array(z.strictObject({ type: z.enum(ENTITLEMENT_TYPES), targetId: z.string() })).optional(),
  }),
  output: MembershipPlan,
  entities: { produces: "membership_plan" },
  example: () => ({ name: "Gold membership" }),
  handler: (a, { store, clock }) => {
    const name = a.name.trim();
    const dup = nameTaken(store, name);
    if (dup) throw new ActionError("DUPLICATE", `A plan called "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    const entitlements = a.entitlements ?? [];
    const seen = new Set<string>();
    for (const e of entitlements) {
      const key = `${e.type}:${e.targetId}`;
      if (seen.has(key)) throw new ActionError("DUPLICATE", `The plan lists ${e.type} ${e.targetId} more than once`);
      seen.add(key);
      targetExists(store, e.type, e.targetId);
    }
    const now = clock.now().toISOString();
    return store.insert("membership_plans", "mpl", {
      name,
      description: a.description ?? null,
      entitlements,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getPlan = defineAction({
  id: "M44.A02",
  description: "Get one membership plan: its description, entitlements and status, and who holds it (members, with each membership's status and expiry). Unlike List membership plans, this loads a single plan by id.",
  risk: "read",
  input: z.strictObject({ planId: PlanId }),
  output: PlanView,
  entities: { consumes: ["membership_plan"] },
  example: (f) => ({ planId: f.membershipPlan().id }),
  handler: ({ planId }, { store }) => {
    const plan = planOf(store, planId);
    const held = store.find<Membership>("memberships", (m) => m.planId === plan.id);
    held.sort((a, b) => a.id.localeCompare(b.id, "en"));
    const members = held.map((m) => ({
      membershipId: m.id,
      contactId: m.contactId,
      name: store.get<{ name: string }>("contacts", m.contactId)?.name ?? m.contactId,
      status: m.status,
      expiresAt: m.expiresAt,
    }));
    return { ...plan, members };
  },
});

const listPlans = defineAction({
  id: "M44.A03",
  description: "List membership plans by status or by words in the name. Results are sorted by name, then id. Unlike Get membership plan, this returns a page of matches.",
  risk: "read",
  input: z.strictObject({ status: z.enum(["active", "archived"]).optional(), query: z.string().optional(), limit: Limit }),
  output: listOf(MembershipPlan),
  entities: { produces: "membership_plan" },
  example: () => ({}),
  handler: (a, { store }) => {
    const items = store.find<MembershipPlan>(
      "membership_plans",
      (p) => (!a.status || p.status === a.status) && (!a.query || contains(p.name, a.query) || contains(p.description, a.query)),
    );
    items.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
    return page(items, a.limit);
  },
});

const updateDescription = defineAction({
  id: "M44.A04",
  description: "Replace an active plan's description. Unlike Add plan entitlement, this changes the text, not what the plan grants. The same description is refused.",
  risk: "write",
  input: z.strictObject({ planId: PlanId, description: z.string().trim().min(1) }),
  output: MembershipPlan,
  entities: { consumes: ["membership_plan"] },
  example: (f) => ({ planId: f.membershipPlan().id, description: "Includes every current course." }),
  handler: (a, { store, clock }) => {
    const p = editablePlan(store, a.planId);
    const description = a.description.trim();
    if (p.description === description) throw new ActionError("CONFLICT", "The plan already has that value");
    return store.update<MembershipPlan>("membership_plans", p.id, { description, updatedAt: clock.now().toISOString() });
  },
});

const addEntitlement = defineAction({
  id: "M44.A05",
  description: "Add a course or community to an active plan. The target must exist and not be archived. Unlike Remove plan entitlement, this grants more access. Adding the same target again is refused.",
  risk: "write",
  input: z.strictObject({ planId: PlanId, type: z.enum(ENTITLEMENT_TYPES), targetId: z.string() }),
  output: MembershipPlan,
  entities: { consumes: ["membership_plan"] },
  example: (f) => ({ planId: f.membershipPlan().id, type: "course", targetId: f.course().id }),
  handler: (a, { store, clock }) => {
    const p = editablePlan(store, a.planId);
    targetExists(store, a.type, a.targetId);
    if (p.entitlements.some((e) => e.type === a.type && e.targetId === a.targetId)) {
      throw new ActionError("DUPLICATE", `The plan already includes this ${a.type}`);
    }
    return store.update<MembershipPlan>("membership_plans", p.id, {
      entitlements: [...p.entitlements, { type: a.type, targetId: a.targetId }],
      updatedAt: clock.now().toISOString(),
    });
  },
});

const removeEntitlement = defineAction({
  id: "M44.A06",
  description: "Remove one course or community from an active plan. Existing memberships keep their rows until the membership is revoked. Unlike Add plan entitlement, this takes access off the plan.",
  risk: "destructive",
  input: z.strictObject({ planId: PlanId, type: z.enum(ENTITLEMENT_TYPES), targetId: z.string() }),
  output: MembershipPlan,
  entities: { consumes: ["membership_plan"] },
  example: (f) => {
    const course = f.course();
    const plan = f.membershipPlan({ entitlements: [{ type: "course", targetId: course.id }] });
    return { planId: plan.id, type: "course", targetId: course.id };
  },
  handler: (a, { store, clock }) => {
    const p = editablePlan(store, a.planId);
    if (!p.entitlements.some((e) => e.type === a.type && e.targetId === a.targetId)) {
      throw new ActionError("CONFLICT", `The plan doesn't include that ${a.type}`);
    }
    return store.update<MembershipPlan>("membership_plans", p.id, {
      entitlements: p.entitlements.filter((e) => !(e.type === a.type && e.targetId === a.targetId)),
      updatedAt: clock.now().toISOString(),
    });
  },
});

function grantCourse(store: Store, courseId: string, contactId: string, membershipId: string, now: string): void {
  const rows = store.find<Enrollment>(
    "enrollments",
    (e) => e.courseId === courseId && e.contactId === contactId && (e.status === "active" || e.status === "suspended"),
  );
  const existing = rows.find((e) => e.status === "active") ?? rows[0];
  if (existing) {
    if (existing.membershipId !== membershipId) store.update<Enrollment>("enrollments", existing.id, { membershipId });
    return;
  }
  store.insert("enrollments", "enr", {
    courseId,
    contactId,
    status: "active" as const,
    enrolledAt: now,
    expiresAt: null,
    completions: [],
    certificate: null,
    membershipId,
    suspendedAt: null,
    revokedAt: null,
    revokeReason: null,
  });
}

/** Returns the member row this grant created or brought back. An already-active member is left alone. */
function grantCommunity(store: Store, communityId: string, contactId: string, now: string): string | null {
  const rows = store.find<CommunityMember>("community_members", (m) => m.communityId === communityId && m.contactId === contactId);
  if (rows.some((m) => m.leftAt == null)) return null;
  const prior = rows.at(-1);
  if (prior) {
    store.update<CommunityMember>("community_members", prior.id, { leftAt: null });
    return prior.id;
  }
  return store.insert("community_members", "cmm", { communityId, contactId, role: "member" as const, joinedAt: now, leftAt: null }).id;
}

const grant = defineAction({
  id: "M44.A07",
  description: "Grant an active contact an active membership and every entitlement on the plan. A course enrolls them with membershipId set (or stamps an existing active or suspended enrollment). A community adds a member or clears leftAt, and that row is remembered so revoke can undo it. Someone already in the community is not recorded. Unlike M42.A01, this can open several courses and communities at once. A second active membership on the same plan is refused.",
  risk: "write",
  input: z.strictObject({ planId: PlanId, contactId: ContactId, expiresAt: When.nullable().optional() }),
  output: Membership,
  siblings: ["M42.A01", "M43.A05"],
  entities: { produces: "enrollment", consumes: ["membership_plan", "contact"] },
  example: (f) => {
    const course = f.course({ status: "published" });
    const community = f.community();
    const plan = f.membershipPlan({
      entitlements: [
        { type: "course", targetId: course.id },
        { type: "community", targetId: community.id },
      ],
    });
    return { planId: plan.id, contactId: f.contact().id };
  },
  handler: (a, { store, clock, actorId }) => {
    const plan = planOf(store, a.planId);
    requireState(`Plan "${plan.name}"`, plan.status, ["active"], "be granted");
    const who = person(store, { contactId: a.contactId }, "receive a membership");
    const already = store.find<Membership>("memberships", (m) => m.planId === plan.id && m.contactId === who.id && m.status === "active");
    if (already[0]) throw new ActionError("CONFLICT", `${who.name} already has an active membership on this plan (${already[0].id})`);
    const now = clock.now().toISOString();
    const membership = store.insert("memberships", "mbr", {
      planId: plan.id,
      contactId: who.id,
      status: "active" as const,
      grantedAt: now,
      expiresAt: a.expiresAt ?? null,
      revokedAt: null,
      revokeReason: null,
      grantedBy: actorId ?? "us_1",
      grantedCommunityMemberIds: [],
    });
    const grantedCommunityMemberIds: string[] = [];
    for (const e of plan.entitlements) {
      if (e.type === "course") grantCourse(store, e.targetId, who.id, membership.id, now);
      else {
        const memberId = grantCommunity(store, e.targetId, who.id, now);
        if (memberId) grantedCommunityMemberIds.push(memberId);
      }
    }
    return store.update<Membership>("memberships", membership.id, { grantedCommunityMemberIds });
  },
});

const setExpiry = defineAction({
  id: "M44.A08",
  description: "Set or clear when an active membership expires. Name the membership with membershipId, or with planId plus contactId. Access checks treat a past expiry as closed, but the status stays active until revoke. Unlike Revoke membership, this does not take away enrollments. The same expiry is refused.",
  risk: "write",
  input: z.strictObject({ ...Holder, expiresAt: When.nullable() }),
  output: Membership,
  entities: { consumes: ["membership_plan", "contact"] },
  example: (f) => ({ membershipId: f.membership().id, expiresAt: f.at(20) }),
  handler: (a, { store }) => {
    const m = membershipFor(store, a);
    requireState("Membership", m.status, ["active"], "have its expiry changed");
    if (a.expiresAt === m.expiresAt) throw new ActionError("CONFLICT", "The membership already has that value");
    return store.update<Membership>("memberships", m.id, { expiresAt: a.expiresAt });
  },
});

const revoke = defineAction({
  id: "M44.A09",
  description: "Revoke an active membership. Name it with membershipId, or with planId plus contactId. Enrollments with this membershipId become revoked, and community members this grant created or reactivated get leftAt set. A member who was already active is left in the community. Unlike M42.A01 or M43.A05, this removes access a plan granted instead of adding it.",
  risk: "destructive",
  input: z.strictObject({ ...Holder, reason: z.string().trim().min(1) }),
  output: Membership,
  siblings: ["M42.A01", "M43.A05"],
  entities: { consumes: ["membership_plan", "contact"] },
  example: (f) => ({ membershipId: f.membership().id, reason: "Requested by the contact" }),
  handler: (a, { store, clock }) => {
    const m = membershipFor(store, a);
    requireState("Membership", m.status, ["active"], "be revoked");
    const now = clock.now().toISOString();
    const reason = a.reason.trim();
    const updated = store.update<Membership>("memberships", m.id, { status: "revoked", revokedAt: now, revokeReason: reason });
    for (const e of store.find<Enrollment>("enrollments", (row) => row.membershipId === m.id && row.status !== "revoked")) {
      store.update<Enrollment>("enrollments", e.id, { status: "revoked", revokedAt: now, revokeReason: reason });
    }
    for (const memberId of m.grantedCommunityMemberIds) {
      const member = store.get<CommunityMember>("community_members", memberId);
      if (member && member.leftAt == null) store.update<CommunityMember>("community_members", member.id, { leftAt: now });
    }
    return updated;
  },
});

const checkAccess = defineAction({
  id: "M44.A10",
  description: "Check whether a contact may use a course or a community through an active membership whose plan lists that entitlement and whose expiry is unset or still ahead. Unlike Grant membership, this only reads and returns allowed plus a reason.",
  risk: "read",
  input: z.strictObject({
    contactId: ContactId,
    courseId: z.string().optional().describe("course id (crs_…); give this or communityId"),
    communityId: z.string().optional().describe("community id (com_…); give this or courseId"),
  }),
  output: Access,
  entities: { consumes: ["membership_plan"] },
  example: (f) => {
    const course = f.course();
    const plan = f.membershipPlan({ entitlements: [{ type: "course", targetId: course.id }] });
    const contact = f.contact();
    f.membership({ planId: plan.id, contactId: contact.id });
    return { contactId: contact.id, courseId: course.id };
  },
  handler: (a, { store, clock }) => {
    if (!!a.courseId === !!a.communityId) throw new ActionError("INVALID", "Give exactly one of courseId or communityId");
    const who = person(store, { contactId: a.contactId }, "check access");
    const kind = a.courseId ? "course" : "community";
    const targetId = a.courseId ?? a.communityId!;
    if (kind === "course") mustGet<Course>(store, "courses", targetId, "course");
    else mustGet<Community>(store, "communities", targetId, "community");
    const now = clock.now().toISOString();
    const mine = store.find<Membership>("memberships", (m) => m.contactId === who.id);
    const related = mine.filter((m) => {
      const plan = store.get<MembershipPlan>("membership_plans", m.planId);
      return !!plan && plan.entitlements.some((e) => e.type === kind && e.targetId === targetId);
    });
    const open = related.find((m) => m.status === "active" && stillOpen(m.expiresAt, now));
    if (open) return { allowed: true, reason: null };
    const expired = related.find((m) => m.status === "active" && !stillOpen(m.expiresAt, now));
    if (expired) return { allowed: false, reason: `Membership ${expired.id} expired ${expired.expiresAt}` };
    const revoked = related.find((m) => m.status === "revoked");
    if (revoked) return { allowed: false, reason: `Membership ${revoked.id} was revoked` };
    return { allowed: false, reason: `No membership for ${who.name} includes this ${kind}` };
  },
});

export default {
  resolvers: {
    membership_plan: tableResolver("membership_plans"),
  },
  actions: [createPlan, getPlan, listPlans, updateDescription, addEntitlement, removeEntitlement, grant, setExpiry, revoke, checkAccess],
} satisfies ModuleExports;
