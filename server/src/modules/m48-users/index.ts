import { z } from "zod";
import { defineAction } from "../../registry/define.js";
import { candidates, contains } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";

export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(["admin", "sales", "support", "marketing"]),
  status: z.enum(["active", "invited", "deactivated"]),
  available: z.boolean(),
});
export type User = z.infer<typeof User>;

const listUsers = defineAction({
  id: "M48.A03",
  description: "List the people who work in this account (staff users, not contacts or leads). Filter by role, status or name.",
  risk: "read",
  input: z.strictObject({
    role: User.shape.role.optional(),
    status: User.shape.status.optional(),
    query: z.string().optional().describe("part of a name or email"),
  }),
  output: z.object({ items: z.array(User), total: z.number() }),
  handler: (args, { store }) => {
    const items = store
      .find<User>("users", (u) => (!args.role || u.role === args.role) && (!args.status || u.status === args.status))
      .filter((u) => !args.query || contains(u.name, args.query) || contains(u.email, args.query));
    return { items, total: items.length };
  },
});

export default {
  actions: [listUsers],
  resolvers: {
    user: (store, name) => candidates(store.find<User>("users", (u) => u.status !== "deactivated"), name, (u) => u.name, (u) => u.role),
  },
} satisfies ModuleExports;
