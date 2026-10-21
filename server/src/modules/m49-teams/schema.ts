import { z } from "zod";

export const STRATEGIES = ["round_robin", "least_busy", "manual"] as const;

export const Team = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberIds: z.array(z.string()),
  managerId: z.string().nullable(),
  /** How new work is spread over members: in turn, to whoever has fewest open tasks, or by hand. */
  strategy: z.enum(STRATEGIES),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
});
export type Team = z.infer<typeof Team>;
