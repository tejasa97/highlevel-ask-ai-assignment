import { ActionError } from "./define.js";
import { candidates } from "./helpers.js";
import type { Candidate, LookupWhere, Resolver } from "./registry.js";
import type { Doc, Store } from "../store/db.js";

const exact = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

/** Read-only, module-owned name lookup. Qualifiers filter BEFORE matching/ranking names. */
export function namedResolver<T extends { id: string }>(options: {
  records: (store: Store) => T[];
  name: (row: T) => string;
  detail?: (row: T) => string;
  inactive?: (row: T) => string | undefined;
  qualifiers?: Record<string, (row: T) => string | null | undefined>;
}): Resolver {
  const qualifiers = options.qualifiers ?? {};
  return Object.assign((store: Store, name: string, where: LookupWhere = {}): Candidate[] => {
    for (const [key, value] of Object.entries(where)) {
      if (!Object.hasOwn(qualifiers, key) || typeof value !== "string" || !value.trim())
        throw new ActionError("INVALID", `Unsupported or empty lookup qualifier ${key}; allowed: ${Object.keys(qualifiers).join(", ") || "none"}`);
    }
    const rows = options.records(store).filter((row) => Object.entries(where).every(([key, value]) => {
      const actual = qualifiers[key]!(row);
      return typeof actual === "string" && exact(actual) === exact(value);
    }));
    return candidates(rows, name, options.name, options.detail, options.inactive);
  }, { qualifiers: Object.keys(qualifiers) });
}

/** Most named catalog objects only need a table, a label, and optional exact qualifier fields. */
export function tableResolver(table: string, label = "name", fields: Record<string, string> = {}): Resolver {
  return namedResolver<Doc>({
    records: (store) => store.all(table),
    name: (row) => typeof row[label] === "string" ? row[label] as string : "",
    detail: (row) => Object.values(fields).map((key) => row[key]).filter((v) => typeof v === "string").join(", "),
    qualifiers: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, (row: Doc) => typeof row[field] === "string" ? row[field] as string : null])),
  });
}
