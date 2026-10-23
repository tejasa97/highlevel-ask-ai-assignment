import { readFileSync } from "node:fs";
import { z } from "zod";
import { Contact } from "../modules/m01-contacts/schema.js";
import { Appointment } from "../modules/m21-appointments/schema.js";
import { Review, ReviewRequest } from "../modules/m45-reviews/schema.js";
import { Listing } from "../modules/m46-business-listings/schema.js";
import { Ticket } from "../modules/m47-support-tickets/schema.js";
import type { Store } from "./db.js";

const schemas: Record<string, z.ZodType<{ id: string }>> = {
  contacts: Contact,
  appointments: Appointment,
  review_requests: ReviewRequest,
  reviews: Review,
  listings: Listing,
  tickets: Ticket,
};
/** The manifest is frozen and predates the null-until-linked seam fields, so they are filled in as they load. */
const SEAM_DEFAULTS: Record<string, Record<string, null>> = {
  contacts: { companyId: null },
  appointments: { calendarId: null },
};
export const MODULE_SEED_URL = new URL(
  "../../../eval/module-scenarios/m45-m47/seed-manifest.json",
  import.meta.url,
);
/** Append the frozen manifest after the old seed. Explicit counter checks protect all old record identities. */
export function appendModuleSeed(store: Store): void {
  const manifest = JSON.parse(readFileSync(MODULE_SEED_URL, "utf8")) as {
    records: { table: string; prefix: string; record: unknown }[];
  };
  for (const entry of manifest.records) {
    const schema = schemas[entry.table];
    if (!schema) throw Error(`Unknown manifest table ${entry.table}`);
    const record = schema.parse({ ...SEAM_DEFAULTS[entry.table], ...(entry.record as object) });
    const id = store.nextId(entry.table, entry.prefix);
    if (id !== record.id)
      throw Error(
        `Seed identity changed: expected ${record.id}, allocated ${id}`,
      );
    store.put(entry.table, record);
  }
}
