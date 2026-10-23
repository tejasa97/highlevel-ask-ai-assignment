import { z } from "zod";

export const Company = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable().describe("website domain, lowercase, no scheme (acme.example)"),
  industry: z.string().nullable(),
  size: z.enum(["1-10", "11-50", "51-200", "201-1000", "1000+"]).nullable(),
  phone: z.string().nullable(),
  address: z.object({ line1: z.string(), city: z.string(), region: z.string(), postalCode: z.string(), country: z.string() }).nullable(),
  /** The user who owns the relationship. */
  accountManagerId: z.string().nullable(),
  status: z.enum(["active", "archived", "merged"]),
  mergedInto: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Company = z.infer<typeof Company>;

// Which contacts belong to a company is `contacts.companyId` (M01); `contacts.company` keeps the company's name in step.
// Linking, unlinking and merging therefore write to contacts, not to a list on the company.
