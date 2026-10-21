import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { atLeastOne, candidates, contains, fullName, Limit, listOf, page, permissionsOf, requirePermission, sameEmail } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import type { Contact } from "../m01-contacts/schema.js";
import type { Lead } from "../m03-leads/schema.js";
import type { Opportunity } from "../m04-opportunities/schema.js";
import type { Task } from "../m06-tasks/schema.js";
import type { Team } from "../m49-teams/schema.js";
import { ROLES, type Role, User } from "./schema.js";

export { User } from "./schema.js";

// Staff accounts: the people who work in this CRM, not the customers in it (those are contacts and leads).

const UserId = z.string().describe("user id (us_…)");
const Role_ = z.enum(ROLES);

function activeAdmins(store: Store): User[] {
  return store.find<User>("users", (u) => u.status === "active" && u.roles.includes("admin"));
}

/** Blocks changes that would leave the account with no active admin. */
function keepAnAdmin(store: Store, user: User, doing: string): void {
  if (user.roles.includes("admin") && user.status === "active" && activeAdmins(store).length === 1) {
    throw new ActionError("CONFLICT", `${user.name} is the only active admin; can't ${doing}. Give someone else the admin role first.`);
  }
}

const inviteUser = defineAction({
  id: "M48.A01",
  description:
    "Invite a new staff member to the account; they get an invitation email and appear as 'invited' until they accept. Not for customers: use M01.A01 Create contact.",
  risk: "external",
  input: z.strictObject({
    firstName: z.string().min(1),
    lastName: z.string().min(1).optional(),
    email: z.email(),
    roles: z.array(Role_).min(1).describe("e.g. [\"sales\"]; admin can manage users"),
    title: z.string().optional().describe("job title"),
  }),
  output: User,
  siblings: ["M01.A01"],
  entities: { produces: "user" },
  example: () => ({ firstName: "Kim", lastName: "Lopez", email: "kim.lopez@ourco.example", roles: ["support"] }),
  handler: (a, { store, clock, actorId }) => {
    requirePermission(store, actorId, "users.manage");
    const existing = store.find<User>("users", (u) => sameEmail(u.email, a.email))[0];
    if (existing?.status === "deactivated") throw new ActionError("CONFLICT", `${existing.name} (${existing.id}) has a deactivated account with this email; reactivate it with M48.A08 instead`, { existingId: existing.id });
    if (existing) throw new ActionError("DUPLICATE", `${a.email} already belongs to ${existing.name} (${existing.id}, ${existing.status})`, { existingId: existing.id });
    const now = clock.now().toISOString();
    return store.insert("users", "us", {
      firstName: a.firstName,
      lastName: a.lastName ?? null,
      name: fullName(a.firstName, a.lastName),
      email: a.email.toLowerCase(),
      phone: null,
      title: a.title ?? null,
      roles: [...new Set(a.roles)],
      status: "invited" as const,
      available: true,
      createdAt: now,
      deactivatedAt: null,
    });
  },
});

const UserProfile = User.extend({
  permissions: z.array(z.string()),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  openTasks: z.number(),
});

const getUser = defineAction({
  id: "M48.A02",
  description: "Get one staff user's profile: roles, status, availability, teams and open task count.",
  risk: "read",
  input: z.strictObject({ userId: UserId }),
  output: UserProfile,
  entities: { consumes: ["user"] },
  example: () => ({ userId: "us_2" }),
  handler: ({ userId }, { store }) => {
    const u = mustGet<User>(store, "users", userId, "user");
    const teams = store.find<Team>("teams", (t) => t.status === "active" && t.memberIds.includes(u.id)).map((t) => ({ id: t.id, name: t.name }));
    const openTasks = store.find<Task>("tasks", (t) => t.status === "open" && t.assigneeId === u.id).length;
    return { ...u, permissions: permissionsOf(u), teams, openTasks };
  },
});

const listUsers = defineAction({
  id: "M48.A03",
  description:
    "List the people who work in this account (staff users, not contacts or leads). Filter by role, status, availability, team or name.",
  risk: "read",
  input: z.strictObject({
    role: Role_.optional(),
    status: User.shape.status.optional().describe("default: everyone except deactivated"),
    available: z.boolean().optional().describe("true = not on leave"),
    teamId: z.string().optional(),
    query: z.string().optional().describe("part of a name or email"),
    limit: Limit,
  }),
  output: listOf(User),
  entities: { produces: "user" },
  example: () => ({ role: "sales" }),
  handler: (a, { store }) => {
    const team = a.teamId ? mustGet<Team>(store, "teams", a.teamId, "team") : null;
    const items = store.find<User>(
      "users",
      (u) =>
        (a.status ? u.status === a.status : u.status !== "deactivated") &&
        (!a.role || u.roles.includes(a.role)) &&
        (a.available === undefined || u.available === a.available) &&
        (!team || team.memberIds.includes(u.id)) &&
        (!a.query || contains(u.name, a.query) || contains(u.email, a.query)),
    );
    return page(items, a.limit);
  },
});

const updateUser = defineAction({
  id: "M48.A04",
  description:
    "Update a staff user's profile: name, email, phone, job title, or availability (available=false while on leave or out). Roles and deactivation have their own actions.",
  risk: "write",
  input: z.strictObject({
    userId: UserId,
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    email: z.email().optional(),
    phone: z.string().min(5).optional(),
    title: z.string().optional(),
    available: z.boolean().optional(),
  }),
  output: User,
  entities: { consumes: ["user"] },
  example: () => ({ userId: "us_3", available: true }),
  handler: ({ userId, ...patch }, { store }) => {
    atLeastOne(patch, ["firstName", "lastName", "email", "phone", "title", "available"]);
    const u = mustGet<User>(store, "users", userId, "user");
    if (u.status === "deactivated") throw new ActionError("CONFLICT", `${u.name} is deactivated; reactivate them before editing the profile`);
    if (patch.email) {
      const other = store.find<User>("users", (x) => x.id !== u.id && sameEmail(x.email, patch.email))[0];
      if (other) throw new ActionError("DUPLICATE", `${patch.email} already belongs to ${other.name} (${other.id})`, { existingId: other.id });
    }
    const firstName = patch.firstName ?? u.firstName;
    const lastName = patch.lastName ?? u.lastName;
    return store.update<User>("users", userId, { ...patch, ...(patch.email ? { email: patch.email.toLowerCase() } : {}), firstName, lastName, name: fullName(firstName, lastName) });
  },
});

const assignRole = defineAction({
  id: "M48.A05",
  description: "Give a staff user an additional role (admin, manager, sales, support, marketing, billing). Roles decide permissions.",
  risk: "write",
  input: z.strictObject({ userId: UserId, role: Role_ }),
  output: User,
  entities: { consumes: ["user"] },
  example: () => ({ userId: "us_4", role: "manager" }),
  handler: ({ userId, role }, { store, actorId }) => {
    requirePermission(store, actorId, "users.manage");
    const u = mustGet<User>(store, "users", userId, "user");
    if (u.status === "deactivated") throw new ActionError("CONFLICT", `${u.name} is deactivated`);
    if (u.roles.includes(role)) throw new ActionError("CONFLICT", `${u.name} already has the ${role} role`);
    return store.update<User>("users", userId, { roles: [...u.roles, role] });
  },
});

const revokeRole = defineAction({
  id: "M48.A06",
  description: "Take a role away from a staff user. A user keeps at least one role, and the account keeps at least one active admin.",
  risk: "write",
  input: z.strictObject({ userId: UserId, role: Role_ }),
  output: User,
  entities: { consumes: ["user"] },
  example: () => ({ userId: "us_2", role: "manager" }),
  handler: ({ userId, role }, { store, actorId }) => {
    requirePermission(store, actorId, "users.manage");
    const u = mustGet<User>(store, "users", userId, "user");
    if (!u.roles.includes(role)) throw new ActionError("CONFLICT", `${u.name} doesn't have the ${role} role (has ${u.roles.join(", ")})`);
    if (u.roles.length === 1) throw new ActionError("CONFLICT", `${role} is ${u.name}'s only role; assign another role first`);
    if (role === "admin") keepAnAdmin(store, u, "remove admin");
    return store.update<User>("users", userId, { roles: u.roles.filter((r: Role) => r !== role) });
  },
});

const deactivateUser = defineAction({
  id: "M48.A07",
  description:
    "Deactivate a staff user who left: they can no longer sign in and are removed from their teams. Pass reassignTo to hand their open tasks, open leads, contacts and open deals to someone else; otherwise those keep pointing at the deactivated user.",
  risk: "destructive",
  input: z.strictObject({ userId: UserId, reassignTo: z.string().optional().describe("user id to receive their open work") }),
  output: z.object({
    user: User,
    reassigned: z.object({ tasks: z.number(), leads: z.number(), contacts: z.number(), opportunities: z.number() }),
    stillOwned: z.object({ tasks: z.number(), leads: z.number(), contacts: z.number(), opportunities: z.number() }),
    removedFromTeams: z.array(z.string()),
  }),
  entities: { consumes: ["user"] },
  example: (f) => {
    const u = f.user();
    f.task({ assigneeId: u.id });
    return { userId: u.id, reassignTo: "us_2" };
  },
  handler: ({ userId, reassignTo }, { store, clock, actorId }) => {
    requirePermission(store, actorId, "users.manage");
    const u = mustGet<User>(store, "users", userId, "user");
    if (u.status === "deactivated") throw new ActionError("CONFLICT", `${u.name} is already deactivated`);
    if (u.id === actorId) throw new ActionError("CONFLICT", "You can't deactivate your own account");
    keepAnAdmin(store, u, "deactivate them");
    if (reassignTo !== undefined) {
      if (reassignTo === userId) throw new ActionError("INVALID", "reassignTo must be a different user");
      const to = mustGet<User>(store, "users", reassignTo, "user");
      if (to.status !== "active") throw new ActionError("CONFLICT", `${to.name} is ${to.status} and can't take over work`);
    }

    const work = {
      tasks: store.find<Task>("tasks", (t) => t.status === "open" && t.assigneeId === userId).map((t) => ["tasks", t.id, "assigneeId"] as const),
      leads: store.find<Lead>("leads", (l) => ["new", "contacted", "qualified"].includes(l.status) && l.ownerId === userId).map((l) => ["leads", l.id, "ownerId"] as const),
      contacts: store.find<Contact>("contacts", (c) => c.status === "active" && c.ownerId === userId).map((c) => ["contacts", c.id, "ownerId"] as const),
      opportunities: store.find<Opportunity>("opportunities", (o) => o.status === "open" && o.ownerId === userId).map((o) => ["opportunities", o.id, "ownerId"] as const),
    };
    const counts = Object.fromEntries(Object.entries(work).map(([k, v]) => [k, v.length])) as Record<keyof typeof work, number>;
    const none = { tasks: 0, leads: 0, contacts: 0, opportunities: 0 };
    if (reassignTo) for (const [entity, id, field] of Object.values(work).flat()) store.update(entity, id, { [field]: reassignTo });

    const removedFromTeams: string[] = [];
    for (const t of store.find<Team>("teams", (t) => t.memberIds.includes(userId) || t.managerId === userId)) {
      store.update("teams", t.id, { memberIds: t.memberIds.filter((m) => m !== userId), managerId: t.managerId === userId ? null : t.managerId });
      removedFromTeams.push(t.id);
    }
    const user = store.update<User>("users", userId, { status: "deactivated", available: false, deactivatedAt: clock.now().toISOString() });
    return { user, reassigned: reassignTo ? counts : none, stillOwned: reassignTo ? none : counts, removedFromTeams };
  },
});

const reactivateUser = defineAction({
  id: "M48.A08",
  description: "Restore a deactivated staff user so they can sign in and receive work again. Team memberships are not restored.",
  risk: "write",
  input: z.strictObject({ userId: UserId }),
  output: User,
  entities: { consumes: ["user"] },
  example: () => ({ userId: "us_9" }),
  handler: ({ userId }, { store, actorId }) => {
    requirePermission(store, actorId, "users.manage");
    const u = mustGet<User>(store, "users", userId, "user");
    if (u.status !== "deactivated") throw new ActionError("CONFLICT", `${u.name} is ${u.status}, not deactivated`);
    return store.update<User>("users", userId, { status: "active", available: true, deactivatedAt: null });
  },
});

const listPermissions = defineAction({
  id: "M48.A09",
  description: "List what a staff user is allowed to do, and which of their roles grants each permission.",
  risk: "read",
  input: z.strictObject({ userId: UserId }),
  output: z.object({
    userId: z.string(),
    name: z.string(),
    roles: z.array(Role_),
    permissions: z.array(z.object({ permission: z.string(), grantedBy: z.array(Role_) })),
  }),
  entities: { consumes: ["user"] },
  example: () => ({ userId: "us_2" }),
  handler: ({ userId }, { store }) => {
    const u = mustGet<User>(store, "users", userId, "user");
    const permissions = permissionsOf(u).map((p) => ({ permission: p, grantedBy: u.roles.filter((r) => permissionsOf({ roles: [r] }).includes(p)) }));
    return { userId: u.id, name: u.name, roles: u.roles, permissions: u.status === "deactivated" ? [] : permissions };
  },
});

const auditActivity = defineAction({
  id: "M48.A10",
  description: "Show what a staff user changed in the account (their audit log), newest first. Dates are inclusive.",
  risk: "read",
  input: z.strictObject({ userId: UserId, from: z.iso.date().optional(), to: z.iso.date().optional(), limit: Limit }),
  output: listOf(z.object({ at: z.string(), action: z.string(), summary: z.string(), refs: z.array(z.string()) })),
  entities: { consumes: ["user"] },
  example: () => ({ userId: "us_1" }),
  handler: ({ userId, from, to, limit }, { store }) => {
    mustGet<User>(store, "users", userId, "user");
    const items = store
      .audit({ actor: userId })
      .filter((e) => (!from || e.at.slice(0, 10) >= from) && (!to || e.at.slice(0, 10) <= to))
      .map(({ at, action, summary, refs }) => ({ at, action, summary, refs }));
    return page(items, limit);
  },
});

export default {
  actions: [inviteUser, getUser, listUsers, updateUser, assignRole, revokeRole, deactivateUser, reactivateUser, listPermissions, auditActivity],
  resolvers: {
    user: (store, name) => candidates(store.find<User>("users", (u) => u.status !== "deactivated"), name, (u) => u.name, (u) => u.roles.join(", ")),
  },
} satisfies ModuleExports;
