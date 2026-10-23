import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, candidates, contains, Limit, listOf, Name, page, requirePermission, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import { localDate } from "../../store/clock.js";
import type { Store } from "../../store/db.js";
import type { Lead } from "../m03-leads/schema.js";
import type { Task } from "../m06-tasks/schema.js";
import type { User } from "../m48-users/schema.js";
import { STRATEGIES, Team } from "./schema.js";

export { Team } from "./schema.js";

// Groups of staff users that share work. The strategy says how new work is spread across members.

const TeamId = z.string().describe("team id (tm_…)");
const UserId = z.string().describe("user id (us_…)");

function activeTeam(store: Store, id: string, doing: string): Team {
  const t = mustGet<Team>(store, "teams", id, "team");
  requireState(`Team ${t.name}`, t.status, ["active"], doing);
  return t;
}

function nameTaken(store: Store, name: string, exceptId?: string): Team | undefined {
  return store.find<Team>("teams", (t) => t.id !== exceptId && t.status === "active" && t.name.trim().toLowerCase() === name.trim().toLowerCase())[0];
}

const createTeam = defineAction({
  id: "M49.A01",
  description: "Create a team of staff users (e.g. 'EMEA Sales'), optionally with members, a manager and how work is spread across them.",
  risk: "write",
  input: z.strictObject({
    name: Name,
    description: z.string().optional(),
    memberIds: z.array(UserId).optional(),
    managerId: UserId.optional().describe("added as a member too"),
    strategy: z.enum(STRATEGIES).optional().describe("round_robin (default) = in turn; least_busy = fewest open tasks; manual"),
  }),
  output: Team,
  entities: { produces: "team" },
  example: () => ({ name: "EMEA Sales", memberIds: ["us_4"], managerId: "us_2" }),
  handler: (a, { store, clock, actorId }) => {
    requirePermission(store, actorId, "teams.manage");
    const dup = nameTaken(store, a.name);
    if (dup) throw new ActionError("DUPLICATE", `There's already a team called ${dup.name} (${dup.id})`, { existingId: dup.id });
    const members = [...new Set([...(a.memberIds ?? []), ...(a.managerId ? [a.managerId] : [])])];
    for (const id of members) activeUser(store, id, "join a team");
    return store.insert("teams", "tm", {
      name: a.name.trim(),
      description: a.description ?? null,
      memberIds: members,
      managerId: a.managerId ?? null,
      strategy: a.strategy ?? "round_robin",
      status: "active" as const,
      createdAt: clock.now().toISOString(),
    });
  },
});

const getTeam = defineAction({
  id: "M49.A02",
  description: "Get one team: its members (names, roles, availability), manager and assignment strategy.",
  risk: "read",
  input: z.strictObject({ teamId: TeamId }),
  output: Team.extend({
    members: z.array(z.object({ userId: z.string(), name: z.string(), roles: z.array(z.string()), available: z.boolean() })),
    managerName: z.string().nullable(),
  }),
  entities: { consumes: ["team"] },
  example: () => ({ teamId: "tm_1" }),
  handler: ({ teamId }, { store }) => {
    const t = mustGet<Team>(store, "teams", teamId, "team");
    const members = t.memberIds
      .map((id) => store.get<User>("users", id))
      .filter((u): u is User => !!u)
      .map((u) => ({ userId: u.id, name: u.name, roles: u.roles, available: u.available && u.status === "active" }));
    const managerName = t.managerId ? (store.get<User>("users", t.managerId)?.name ?? null) : null;
    return { ...t, members, managerName };
  },
});

const listTeams = defineAction({
  id: "M49.A03",
  description: "List teams of staff users (e.g. Sales, Support), with their member ids. Archived teams only when asked.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("part of a team name"),
    memberId: UserId.optional().describe("only teams this user is in"),
    includeArchived: z.boolean().optional(),
    limit: Limit,
  }),
  output: listOf(Team),
  entities: { produces: "team" },
  example: () => ({ query: "sales" }),
  handler: (a, { store }) => {
    const items = store.find<Team>(
      "teams",
      (t) =>
        (a.includeArchived || t.status === "active") &&
        (!a.query || contains(t.name, a.query)) &&
        (!a.memberId || t.memberIds.includes(a.memberId)),
    );
    return page(items, a.limit);
  },
});

const renameTeam = defineAction({
  id: "M49.A04",
  description: "Rename a team, and optionally change its description.",
  risk: "write",
  input: z.strictObject({ teamId: TeamId, name: Name, description: z.string().optional() }),
  output: Team,
  entities: { consumes: ["team"] },
  example: () => ({ teamId: "tm_3", name: "Growth Marketing" }),
  handler: ({ teamId, name, description }, { store, actorId }) => {
    requirePermission(store, actorId, "teams.manage");
    const t = activeTeam(store, teamId, "rename it");
    const dup = nameTaken(store, name, teamId);
    if (dup) throw new ActionError("DUPLICATE", `There's already a team called ${dup.name} (${dup.id})`, { existingId: dup.id });
    return store.update<Team>("teams", t.id, { name: name.trim(), ...(description !== undefined ? { description } : {}) });
  },
});

const addMember = defineAction({
  id: "M49.A05",
  description: "Add a staff user to a team.",
  risk: "write",
  input: z.strictObject({ teamId: TeamId, userId: UserId }),
  output: Team,
  entities: { consumes: ["team", "user"] },
  example: () => ({ teamId: "tm_1", userId: "us_6" }),
  handler: ({ teamId, userId }, { store, actorId }) => {
    requirePermission(store, actorId, "teams.manage");
    const t = activeTeam(store, teamId, "add members");
    const u = activeUser(store, userId, "join a team");
    if (t.memberIds.includes(userId)) throw new ActionError("CONFLICT", `${u.name} is already in ${t.name}`);
    return store.update<Team>("teams", t.id, { memberIds: [...t.memberIds, userId] });
  },
});

const removeMember = defineAction({
  id: "M49.A06",
  description: "Take a staff user out of a team. Their records keep their owner; only future team assignment changes.",
  risk: "write",
  input: z.strictObject({ teamId: TeamId, userId: UserId }),
  output: Team,
  entities: { consumes: ["team", "user"] },
  example: () => ({ teamId: "tm_1", userId: "us_4" }),
  handler: ({ teamId, userId }, { store, actorId }) => {
    requirePermission(store, actorId, "teams.manage");
    const t = activeTeam(store, teamId, "remove members");
    const u = mustGet<User>(store, "users", userId, "user");
    if (!t.memberIds.includes(userId)) throw new ActionError("CONFLICT", `${u.name} isn't in ${t.name}`);
    if (t.managerId === userId) throw new ActionError("CONFLICT", `${u.name} manages ${t.name}; assign another manager first (M49.A07)`);
    return store.update<Team>("teams", t.id, { memberIds: t.memberIds.filter((m) => m !== userId) });
  },
});

const assignManager = defineAction({
  id: "M49.A07",
  description: "Make a staff user the team's manager (replacing any current one). They're added as a member if they aren't one.",
  risk: "write",
  input: z.strictObject({ teamId: TeamId, userId: UserId }),
  output: Team,
  entities: { consumes: ["team", "user"] },
  example: (f) => ({ teamId: f.team().id, userId: "us_8" }),
  handler: ({ teamId, userId }, { store, actorId }) => {
    requirePermission(store, actorId, "teams.manage");
    const t = activeTeam(store, teamId, "change the manager");
    const u = activeUser(store, userId, "manage a team");
    if (t.managerId === userId) throw new ActionError("CONFLICT", `${u.name} already manages ${t.name}`);
    return store.update<Team>("teams", t.id, { managerId: userId, memberIds: t.memberIds.includes(userId) ? t.memberIds : [...t.memberIds, userId] });
  },
});

const setStrategy = defineAction({
  id: "M49.A08",
  description: "Choose how new work is spread across a team: round_robin (in turn), least_busy (fewest open tasks) or manual.",
  risk: "write",
  input: z.strictObject({ teamId: TeamId, strategy: z.enum(STRATEGIES) }),
  output: Team,
  entities: { consumes: ["team"] },
  example: () => ({ teamId: "tm_1", strategy: "least_busy" }),
  handler: ({ teamId, strategy }, { store, actorId }) => {
    requirePermission(store, actorId, "teams.manage");
    const t = activeTeam(store, teamId, "change its strategy");
    if (t.strategy === strategy) throw new ActionError("CONFLICT", `${t.name} already uses ${strategy}`);
    return store.update<Team>("teams", t.id, { strategy });
  },
});

const teamWorkload = defineAction({
  id: "M49.A09",
  description:
    "Get each active team member's availability, open and overdue tasks, and open leads they own. Use it to find who is free or least busy before assigning work.",
  risk: "read",
  input: z.strictObject({ teamId: TeamId }),
  output: z.object({
    teamId: z.string(),
    teamName: z.string(),
    strategy: z.enum(STRATEGIES),
    members: z.array(
      z.object({ userId: z.string(), name: z.string(), available: z.boolean(), openTasks: z.number(), overdueTasks: z.number(), openLeads: z.number() }),
    ),
  }),
  entities: { consumes: ["team"] },
  example: () => ({ teamId: "tm_1" }),
  handler: ({ teamId }, { store, clock }) => {
    const team = mustGet<Team>(store, "teams", teamId, "team");
    const today = localDate(clock.now());
    const open = store.find<Task>("tasks", (t) => t.status === "open");
    const leads = store.find<Lead>("leads", (l) => ["new", "contacted", "qualified"].includes(l.status));
    const members = team.memberIds
      .map((id) => store.get<User>("users", id))
      .filter((u): u is User => !!u && u.status === "active")
      .map((u) => {
        const mine = open.filter((t) => t.assigneeId === u.id);
        return {
          userId: u.id,
          name: u.name,
          available: u.available,
          openTasks: mine.length,
          overdueTasks: mine.filter((t) => t.dueDate !== null && t.dueDate < today).length,
          openLeads: leads.filter((l) => l.ownerId === u.id).length,
        };
      });
    return { teamId: team.id, teamName: team.name, strategy: team.strategy, members };
  },
});

const archiveTeam = defineAction({
  id: "M49.A10",
  description: "Archive a team that's no longer used. Members keep their accounts and records; the team just stops receiving work.",
  risk: "destructive",
  input: z.strictObject({ teamId: TeamId }),
  output: Team,
  entities: { consumes: ["team"] },
  example: (f) => ({ teamId: f.team({ name: "Old Pilot Team" }).id }),
  handler: ({ teamId }, { store, actorId }) => {
    requirePermission(store, actorId, "teams.manage");
    const t = activeTeam(store, teamId, "archive it");
    return store.update<Team>("teams", t.id, { status: "archived" });
  },
});

export default {
  actions: [createTeam, getTeam, listTeams, renameTeam, addMember, removeMember, assignManager, setStrategy, teamWorkload, archiveTeam],
  resolvers: {
    // "the Sales team" → "Sales"
    team: (store, name) =>
      candidates(store.all<Team>("teams"), name.replace(/\b(the|team)\b/gi, ""), (t) => t.name, undefined, (t) => (t.status === "active" ? undefined : t.status)),
  },
} satisfies ModuleExports;
