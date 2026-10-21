import { z } from "zod";
import { defineAction, mustGet } from "../../registry/define.js";
import { candidates, contains } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { User } from "../m48-users/index.js";

export const Team = z.object({
  id: z.string(),
  name: z.string(),
  memberIds: z.array(z.string()),
  managerId: z.string().nullable(),
  strategy: z.enum(["round_robin", "least_busy", "manual"]),
  status: z.enum(["active", "archived"]),
});
export type Team = z.infer<typeof Team>;

const listTeams = defineAction({
  id: "M49.A03",
  description: "List teams of staff users (e.g. Sales, Support), with their member ids.",
  risk: "read",
  input: z.strictObject({ query: z.string().optional().describe("part of a team name") }),
  output: z.object({ items: z.array(Team), total: z.number() }),
  handler: (args, { store }) => {
    const items = store.find<Team>("teams", (t) => t.status === "active" && (!args.query || contains(t.name, args.query)));
    return { items, total: items.length };
  },
});

const teamWorkload = defineAction({
  id: "M49.A09",
  description:
    "Get each team member's availability and number of open tasks. Use it to find who is free or least busy before assigning work.",
  risk: "read",
  input: z.strictObject({ teamId: z.string() }),
  output: z.object({
    teamId: z.string(),
    teamName: z.string(),
    members: z.array(z.object({ userId: z.string(), name: z.string(), available: z.boolean(), openTasks: z.number() })),
  }),
  entities: { consumes: ["team"] },
  handler: ({ teamId }, { store }) => {
    const team = mustGet<Team>(store, "teams", teamId, "team");
    const open = store.find<{ assigneeId: string | null; status: string }>("tasks", (t) => t.status === "open");
    const members = team.memberIds
      .map((id) => store.get<User>("users", id))
      .filter((u): u is User => !!u && u.status === "active")
      .map((u) => ({ userId: u.id, name: u.name, available: u.available, openTasks: open.filter((t) => t.assigneeId === u.id).length }));
    return { teamId: team.id, teamName: team.name, members };
  },
});

export default {
  actions: [listTeams, teamWorkload],
  resolvers: {
    // "the Sales team" → "Sales"
    team: (store, name) =>
      candidates(store.find<Team>("teams", (t) => t.status === "active"), name.replace(/\b(the|team)\b/gi, ""), (t) => t.name),
  },
} satisfies ModuleExports;
