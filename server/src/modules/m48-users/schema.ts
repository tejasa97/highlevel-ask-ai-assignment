import { z } from "zod";

export const ROLES = ["admin", "manager", "sales", "support", "marketing", "billing"] as const;
export type Role = (typeof ROLES)[number];

/** What each role may do. A user's permissions are the union over their roles. */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: ["users.manage", "teams.manage", "contacts.manage", "leads.manage", "opportunities.manage", "tasks.manage", "billing.manage", "messaging.send", "reports.view", "tickets.manage", "reputation.manage"],
  manager: ["teams.manage", "contacts.manage", "leads.manage", "opportunities.manage", "tasks.manage", "messaging.send", "reports.view", "tickets.manage", "reputation.manage"],
  sales: ["contacts.manage", "leads.manage", "opportunities.manage", "tasks.manage", "messaging.send"],
  support: ["contacts.manage", "tasks.manage", "messaging.send", "tickets.manage"],
  marketing: ["contacts.manage", "leads.manage", "messaging.send", "reports.view", "reputation.manage"],
  billing: ["contacts.manage", "billing.manage", "reports.view"],
};

export const User = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  roles: z.array(z.enum(ROLES)),
  status: z.enum(["invited", "active", "deactivated"]),
  /** False while someone is on leave or out; they keep their records but get no new work. */
  available: z.boolean(),
  createdAt: z.string(),
  deactivatedAt: z.string().nullable(),
});
export type User = z.infer<typeof User>;
