import type { JsonSchema } from "../registry/registry.js";

// $refs: how plan steps point at earlier results without the data passing through the model.
//   "$s1.items"              a step's output field
//   "$s1.items[*].contactId" the field of every item (a list)
//   "$s2.members[0]"         one item
//   "$item.id" / "$rr.userId" the current forEach item / round-robin pick
//   "Follow up with {{$item.name}}"  interpolated into a string
// The same path walks a JSON Schema at compile time (static check) and a value at run time.

export type Seg = { field: string } | { all: true } | { index: number };
export interface Ref {
  root: string;
  path: Seg[];
  raw: string;
}

const REF = /^\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\])*)$/;
const TEMPLATE = /\{\{\s*(\$[^}\s]+)\s*\}\}/g;
export const RESERVED_ROOTS = new Set(["item", "rr", "ctx"]);

export function parseRef(s: string): Ref | null {
  const m = REF.exec(s);
  if (!m) return null;
  const path: Seg[] = [];
  for (const part of m[2]!.match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\]/g) ?? []) {
    if (part === "[*]") path.push({ all: true });
    else if (part.startsWith("[")) path.push({ index: Number(part.slice(1, -1)) });
    else path.push({ field: part.slice(1) });
  }
  return { root: m[1]!, path, raw: s };
}

/** Looks like a ref but doesn't parse, e.g. "$s1.items[*]userId". Literal text like "$5 off" doesn't count. */
export function looksLikeBrokenRef(s: string): boolean {
  return /^\$[A-Za-z_]/.test(s) && !parseRef(s);
}

export function templateRefs(s: string): string[] {
  return [...s.matchAll(TEMPLATE)].map((m) => m[1]!);
}

/** Every ref in a JSON value, with the JSON path where it sits (for matching to arg schemas). */
export function collectRefs(v: unknown, at: (string | number)[] = []): { at: (string | number)[]; ref: string; template: boolean }[] {
  if (typeof v === "string") {
    if (parseRef(v) || looksLikeBrokenRef(v)) return [{ at, ref: v, template: false }];
    return templateRefs(v).map((ref) => ({ at, ref, template: true }));
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => collectRefs(x, [...at, i]));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => collectRefs(x, [...at, k]));
  return [];
}

// ---------- static types (JSON Schema) ----------

export const ANY: JsonSchema = {};

/** Drops a `| null` so nullable fields can still be walked. */
export function unwrap(s: JsonSchema): JsonSchema {
  const u = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (u) {
    const nonNull = u.filter((x) => x.type !== "null");
    if (nonNull.length === 1) return unwrap(nonNull[0]!);
  }
  if (Array.isArray(s.type)) {
    const t = s.type.filter((x) => x !== "null");
    if (t.length === 1) return { ...s, type: t[0] };
  }
  return s;
}

export type Kind = "array" | "object" | "scalar" | "any";
export function kindOf(s: JsonSchema): Kind {
  const u = unwrap(s);
  if (u.type === "array") return "array";
  if (u.type === "object") return "object";
  if (typeof u.type === "string" || u.enum || "const" in u) return "scalar";
  return "any";
}

export function fieldsOf(s: JsonSchema): string[] {
  const u = unwrap(s);
  return u.type === "object" ? Object.keys((u.properties ?? {}) as object) : [];
}

export function arrayOf(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}

/** Walks a path over a schema. Returns the resulting type, or an error a planner can act on. */
export function typeAt(schema: JsonSchema, path: Seg[], label: string): { type: JsonSchema } | { error: string } {
  let cur = schema;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const here = label + fmt(path.slice(0, i));
    const s = unwrap(cur);
    const kind = kindOf(s);
    if (kind === "any") return { type: ANY };
    if ("field" in seg) {
      if (kind === "array") {
        // A filter or exclude step's result is the list itself; ".items" belongs to a search action's {items, total}.
        const itemFields = fieldsOf((s.items ?? ANY) as JsonSchema);
        if (itemFields.length && !itemFields.includes(seg.field)) {
          return { error: `${here} is already the list of records, with no ".${seg.field}"; use ${here}[*].<field> for a field of every item (fields: ${itemFields.join(", ")})` };
        }
        return { error: `${here} is a list; use ${here}[*].${seg.field} for that field of every item` };
      }
      if (kind !== "object") return { error: `${here} is a ${String(s.type)}, it has no field "${seg.field}"` };
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      if (Object.keys(props).length === 0) return { type: ANY }; // open object
      const next = props[seg.field];
      if (!next) return { error: `${here} has no field "${seg.field}"; fields: ${Object.keys(props).join(", ")}` };
      cur = next;
    } else {
      if (kind !== "array") return { error: `${here} is not a list, so ${"all" in seg ? "[*]" : `[${seg.index}]`} doesn't apply` };
      const items = (s.items ?? ANY) as JsonSchema;
      if ("index" in seg) {
        cur = items;
        continue;
      }
      const rest = typeAt(items, path.slice(i + 1), `${here}[*]`);
      return "error" in rest ? rest : { type: arrayOf(rest.type) };
    }
  }
  return { type: cur };
}

export function fmt(path: Seg[]): string {
  return path.map((s) => ("field" in s ? `.${s.field}` : "all" in s ? "[*]" : `[${s.index}]`)).join("");
}

// ---------- runtime values ----------

export class RefError extends Error {}

export function valueAt(value: unknown, path: Seg[], label: string): unknown {
  let cur = value;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const here = label + fmt(path.slice(0, i));
    if ("field" in seg) {
      if (cur === null || cur === undefined) throw new RefError(`${here} is empty, so .${seg.field} has no value`);
      if (typeof cur !== "object" || Array.isArray(cur)) throw new RefError(`${here} has no field "${seg.field}"`);
      cur = (cur as Record<string, unknown>)[seg.field];
    } else {
      if (!Array.isArray(cur)) throw new RefError(`${here} is not a list`);
      if ("index" in seg) {
        if (seg.index >= cur.length) throw new RefError(`${here} has ${cur.length} items, no [${seg.index}]`);
        cur = cur[seg.index];
        continue;
      }
      const rest = path.slice(i + 1);
      return cur.map((x) => valueAt(x, rest, `${here}[*]`));
    }
  }
  return cur;
}

/** Replaces every ref in a JSON value with its runtime value. */
export function substitute(v: unknown, lookup: (ref: Ref) => unknown): unknown {
  if (typeof v === "string") {
    const r = parseRef(v);
    if (r) return lookup(r);
    if (!v.includes("{{")) return v;
    return v.replace(TEMPLATE, (_, raw: string) => {
      const ref = parseRef(raw);
      if (!ref) throw new RefError(`bad ref in template: ${raw}`);
      const x = lookup(ref);
      return x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : String(x);
    });
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, lookup));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, lookup)]));
  return v;
}
