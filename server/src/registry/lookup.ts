import { ActionError } from "./define.js";
import { candidates } from "./helpers.js";
import type { Candidate, LookupWhere, Resolver } from "./registry.js";
import type { Doc, Store } from "../store/db.js";

type Qualified = string | (string | null | undefined)[] | null | undefined;

const exact = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

/** Read-only, module-owned name lookup. Qualifiers filter BEFORE matching/ranking names. */
export function namedResolver<T extends { id: string }>(options: {
  records: (store: Store) => T[];
  name: (row: T) => string;
  detail?: (row: T) => string;
  inactive?: (row: T) => string | undefined;
  /** What a qualifier matches: one value, or several ways to name the same thing (an id and a title). */
  qualifiers?: Record<string, (row: T) => Qualified>;
  exactMention?: boolean;
  parentQualifiers?: string[];
}): Resolver {
  const qualifiers = options.qualifiers ?? {};
  return Object.assign((store: Store, name: string, where: LookupWhere = {}): Candidate[] => {
    for (const [key, value] of Object.entries(where)) {
      if (!Object.hasOwn(qualifiers, key) || typeof value !== "string" || !value.trim())
        throw new ActionError("INVALID", `Unsupported or empty lookup qualifier ${key}; allowed: ${Object.keys(qualifiers).join(", ") || "none"}`);
    }
    if (options.parentQualifiers?.length && !options.parentQualifiers.some((key) => where[key]))
      throw new ActionError("INVALID", `Child lookup requires a parent qualifier: ${options.parentQualifiers.join(" or ")}`);
    const rows = options.records(store).filter((row) => Object.entries(where).every(([key, value]) => {
      const actual = qualifiers[key]!(row);
      return (Array.isArray(actual) ? actual : [actual]).some((a) => typeof a === "string" && exact(a) === exact(value));
    }));
    return candidates(rows, name, options.name, options.detail, options.inactive);
  }, { qualifiers: Object.keys(qualifiers), exactMention: options.exactMention ?? false, parentQualifiers: options.parentQualifiers });
}

/**
 * Most named catalog objects only need a table, a label, and optional exact qualifier fields.
 * A field in `parents` ("courseId": courses by title) also matches the parent's name, under its own key
 * and under the key without "Id" ("course"), since a user names the course, not its id.
 */
export function tableResolver(table: string, label = "name", fields: Record<string, string> = {}, parents: Record<string, { table: string; label: string }> = {}): Resolver {
  type Row = Doc & { parentNames: Record<string, string | undefined> };
  const named = Object.entries(parents);
  const value = (row: Row, field: string) => typeof row[field] === "string" ? row[field] as string : null;
  return namedResolver<Row>({
    exactMention: true,
    records: (store) => store.all(table).map((row) => ({
      ...row,
      parentNames: Object.fromEntries(named.map(([key, p]) => {
        const parent = typeof row[fields[key]!] === "string" ? store.get<Doc>(p.table, row[fields[key]!] as string) : undefined;
        return [key, typeof parent?.[p.label] === "string" ? parent[p.label] as string : undefined];
      })),
    })),
    name: (row) => typeof row[label] === "string" ? row[label] as string : "",
    detail: (row) => Object.values(fields).map((key) => row[key]).filter((v) => typeof v === "string").join(", "),
    qualifiers: {
      ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, (row: Row) => parents[key] ? [value(row, field), row.parentNames[key]] : value(row, field)])),
      ...Object.fromEntries(named.filter(([key]) => /Id$/.test(key) && !fields[key.slice(0, -2)]).map(([key]) => [key.slice(0, -2), (row: Row) => row.parentNames[key]])),
    },
  });
}

/** Records that belong to a contact and have no name of their own (quotes, orders, subscriptions, enrollments).
 *  They are named by whose they are, what they are and their own label: "Elena Costa's quote QT-1001", so
 *  "QT-1001", "Elena Costa's quote" and "the quote" with a contact qualifier all find it.
 *  The contact qualifier narrows to one person's records, by name or id. */
export function ownedResolver<T extends { id: string; contactId: string }>(options: {
  table: string;
  /** The record type's word: "quote". */
  noun: string;
  label: (store: Store, row: T) => string;
  detail?: (row: T) => string;
  inactive?: (row: T) => string | undefined;
  /** More qualifiers, e.g. the course an enrollment is in, by id or title. */
  qualifiers?: Record<string, (store: Store, row: T) => Qualified>;
}): Resolver {
  type Owned = T & { owner: string; named: string; more: Record<string, Qualified> };
  const more = Object.entries(options.qualifiers ?? {});
  return namedResolver<Owned>({
    exactMention: true,
    records: (store) => store.all<T>(options.table).map((row) => {
      const owner = store.get<{ name: string }>("contacts", row.contactId)?.name ?? "";
      const named = [owner && `${owner}'s`, options.noun, options.label(store, row)].filter(Boolean).join(" ");
      return { ...row, owner, named, more: Object.fromEntries(more.map(([key, value]) => [key, value(store, row)])) };
    }),
    name: (row) => row.named,
    detail: options.detail,
    inactive: options.inactive,
    qualifiers: {
      contact: (row) => row.owner,
      contactId: (row) => [row.contactId, row.owner],
      ...Object.fromEntries(more.map(([key]) => [key, (row: Owned) => row.more[key]])),
    },
  });
}
