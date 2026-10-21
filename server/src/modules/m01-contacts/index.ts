import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { candidates, contains } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { User } from "../m48-users/index.js";

export const Contact = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  ownerId: z.string().nullable(),
  tags: z.array(z.string()),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
});
export type Contact = z.infer<typeof Contact>;

const createContact = defineAction({
  id: "M01.A01",
  description: "Add a person to contacts (an existing customer or person you deal with). For a new prospect, use M03.A01 Create lead.",
  risk: "write",
  input: z.strictObject({
    firstName: z.string().min(1),
    lastName: z.string().min(1).optional(),
    email: z.email().optional(),
    phone: z.string().min(5).optional(),
    ownerId: z.string().optional().describe("user id"),
  }),
  output: Contact,
  entities: { produces: "contact" },
  handler: (args, { store, clock }) => {
    if (args.email) {
      const dup = store.find<Contact>("contacts", (c) => c.status === "active" && c.email?.toLowerCase() === args.email!.toLowerCase());
      if (dup[0]) throw new ActionError("DUPLICATE", `A contact with ${args.email} already exists: ${dup[0].name} (${dup[0].id})`, { existingId: dup[0].id });
    }
    if (args.ownerId) mustGet<User>(store, "users", args.ownerId, "user");
    return store.insert("contacts", "ct", {
      firstName: args.firstName,
      lastName: args.lastName ?? null,
      name: [args.firstName, args.lastName].filter(Boolean).join(" "),
      email: args.email ?? null,
      phone: args.phone ?? null,
      ownerId: args.ownerId ?? null,
      tags: [],
      status: "active" as const,
      createdAt: clock.now().toISOString(),
    });
  },
});

const searchContacts = defineAction({
  id: "M01.A03",
  description: "Find contacts by name, email, owner or tag. Leads are separate: use M03.A03 Search leads for prospects.",
  risk: "read",
  input: z.strictObject({
    query: z.string().optional().describe("part of a name, email or phone"),
    ownerId: z.string().optional(),
    tag: z.string().optional(),
  }),
  output: z.object({ items: z.array(Contact), total: z.number() }),
  handler: (args, { store }) => {
    const items = store.find<Contact>(
      "contacts",
      (c) =>
        c.status === "active" &&
        (!args.ownerId || c.ownerId === args.ownerId) &&
        (!args.tag || c.tags.includes(args.tag)) &&
        (!args.query || contains(c.name, args.query) || contains(c.email, args.query) || contains(c.phone, args.query)),
    );
    return { items, total: items.length };
  },
});

const assignContactOwner = defineAction({
  id: "M01.A07",
  description: "Make a staff user the owner of a contact. For leads, use M03.A05 Assign lead owner.",
  risk: "write",
  input: z.strictObject({ contactId: z.string(), ownerId: z.string().describe("user id") }),
  output: Contact,
  siblings: ["M03.A05"],
  handler: ({ contactId, ownerId }, { store }) => {
    mustGet<Contact>(store, "contacts", contactId, "contact");
    const user = mustGet<User>(store, "users", ownerId, "user");
    if (user.status !== "active") throw new ActionError("CONFLICT", `${user.name} is ${user.status} and can't own records`);
    return store.update<Contact>("contacts", contactId, { ownerId });
  },
});

export default {
  actions: [createContact, searchContacts, assignContactOwner],
  resolvers: {
    contact: (store, name) =>
      candidates(store.find<Contact>("contacts", (c) => c.status === "active"), name, (c) => c.name, (c) => c.email ?? ""),
  },
} satisfies ModuleExports;
