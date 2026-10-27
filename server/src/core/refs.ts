import type { JsonSchema } from "../registry/registry.js";

// $refs: how plan steps point at earlier results without the data passing through the model.
//   "$s1.items"              a step's output field
//   "$s1.items[*].contactId" the field of every item (a list)
//   "$s2.members[0]"         one item; [-1] is the last, e.g. the page an add action just appended
//   "$item.id" / "$rr.userId" the current forEach item / round-robin pick
//   "Follow up with {{$item.name}}"  interpolated into a string
// The same path walks a JSON Schema at compile time (static check) and a value at run time.

export type Seg = { field: string } | { all: true } | { index: number };
export interface Ref {
  root: string;
  path: Seg[];
  raw: string;
}

const REF = /^\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[-?\d+\])*)$/;
const TEMPLATE = /\{\{\s*(\$[^}\s]+)\s*\}\}/g;
export const RESERVED_ROOTS = new Set(["item", "rr", "prev", "ctx"]);

/**
 * A written-out forEach input (array or JSON array string), undefined for a ref, null after an error. Elements are
 * literal strings or $refs to single values (["$s1", "$s2.id"]); the caller types the refs.
 */
export function literalList(raw: string | string[], err: (m: string) => void, field = "in"): string[] | null | undefined {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim().startsWith("[")) return undefined;
    try {
      value = JSON.parse(raw);
    } catch {
      err(`"${field}" ${raw.slice(0, 80)} looks like a list but is not valid JSON; write a JSON array of strings, e.g. ["id_1","id_2"]`);
      return null;
    }
  }
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x.length)) {
    err(`"${field}" must be a JSON array of non-empty strings, e.g. ["id_1","id_2"]`);
    return null;
  }
  return value as string[];
}

export function parseRef(s: string): Ref | null {
  // "$s2.items[0].invoiceId}": a weaker model closes a ref like a {{template}}. With no "{" to open it, the brace
  // can only be that slip, so it reads as the ref it closes.
  const m = REF.exec(s) ?? (s.endsWith("}") && !s.includes("{") ? REF.exec(s.slice(0, -1)) : null);
  if (!m) return null;
  const path: Seg[] = [];
  for (const part of m[2]!.match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[-?\d+\]/g) ?? []) {
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

/**
 * "{{$item.id === 'ld_41' ? 'tk_21' : 'tk_24'}}": a {{template}} that holds more than one ref. Nothing in it is
 * evaluated, so it would reach the call as that literal text. Returns each such template with where it sits.
 */
export function templateSlips(v: unknown, at: (string | number)[] = []): { at: (string | number)[]; text: string }[] {
  if (typeof v === "string") {
    return [...v.matchAll(/\{\{([^{}]*)\}\}/g)].filter((m) => m[1]!.includes("$") && !parseRef(m[1]!.trim())).map((m) => ({ at, text: m[0] }));
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => templateSlips(x, [...at, i]));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => templateSlips(x, [...at, k]));
  return [];
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

/** "relatedTo.id", or with list positions, "results[0].total" on a forEach's items. */
export function pathOf(field: string): string[] {
  return field.replace(/\[(\d+)\]/g, ".$1").split(".");
}

export function arrayOf(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}

/** Walks a path over a schema. Returns the resulting type, or an error a planner can act on. */
export function typeAt(schema: JsonSchema, path: Seg[], label: string): { type: JsonSchema } | { error: string } {
  const r = walkType(schema, path, label);
  return "error" in r ? r : { type: r.type };
}

/** "many": the path went through a "[*]", so the type is already one list of what it reached. */
function walkType(schema: JsonSchema, path: Seg[], label: string): { type: JsonSchema; many: boolean } | { error: string } {
  let cur = schema;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const here = label + fmt(path.slice(0, i));
    const s = unwrap(cur);
    const kind = kindOf(s);
    if (kind === "any") return { type: ANY, many: false };
    if ("field" in seg) {
      if (kind === "array") {
        // A filter or exclude step's result is the list itself; ".items" belongs to a search action's {items, total}.
        // Writing ".items" on a list anyway can only mean the list, so it is read as that: a refused plan costs a
        // repair round, and a repair rewrites more than the one slip.
        const itemFields = fieldsOf((s.items ?? ANY) as JsonSchema);
        if (seg.field === "items" && !itemFields.includes("items")) continue;
        // "$s2.results" on a loop's list: a list has no fields of its own, so it is that field of every entry.
        if (isLoopEntry((s.items ?? ANY) as JsonSchema) && (seg.field === "results" || seg.field === "item")) return walkType(cur, [{ all: true }, ...path.slice(i)], here);
        if (itemFields.length && !itemFields.includes(seg.field)) {
          return { error: `${here} is already the list of records, with no ".${seg.field}"; use ${here}[*].<field> for a field of every item (fields: ${itemFields.join(", ")})` };
        }
        return { error: `${here} is a list; use ${here}[*].${seg.field} for that field of every item` };
      }
      if (kind !== "object") return { error: `${here} is a ${String(s.type)}, it has no field "${seg.field}"` };
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      if (Object.keys(props).length === 0) return { type: ANY, many: false }; // open object
      const next = props[seg.field];
      if (!next) {
        // A forEach's output is [{item, results}]: what each "do" call returned sits under results[k], not on the item.
        const loop = isLoopEntry(s);
        const through = loop ? loopSegs(props, seg.field) : null;
        if (through) return walkType(cur, [...through, ...path.slice(i + 1)], here);
        // ".items" on the loop's list was read as the list itself, so the path shown leaves it out.
        const at = here.replace(/\.items(?=\[\*\])/g, "");
        const tip = loop ? ` (a forEach step's output: "item" is the looped value and results[k] what its do[k] call returned, so a field of what do[0] returned is ${at}.results[0].${seg.field}, or ${at}.results[0].items[*].${seg.field} when it returned a list)` : "";
        return { error: `${here} has no field "${seg.field}"; fields: ${Object.keys(props).join(", ")}${tip}` };
      }
      cur = next;
    } else {
      if (kind !== "array") return { error: `${here} is not a list, so ${"all" in seg ? "[*]" : `[${seg.index}]`} doesn't apply` };
      const items = (s.items ?? ANY) as JsonSchema;
      if ("index" in seg) {
        // A loop's results list what each "do" call returned, in order.
        cur = ((s.prefixItems as JsonSchema[] | undefined)?.[seg.index] ?? items) as JsonSchema;
        continue;
      }
      const rest = walkType(items, path.slice(i + 1), `${here}[*]`);
      if ("error" in rest) return rest;
      // "[*]" twice ("$s2[*].results[0].items[*].leadId") is one flat list, not a list per item.
      return { type: rest.many ? rest.type : arrayOf(rest.type), many: true };
    }
  }
  return { type: cur, many: false };
}

/** One entry of a forEach step's output: {item, results}. */
export function isLoopEntry(s: JsonSchema): boolean {
  const props = (unwrap(s).properties ?? {}) as Record<string, JsonSchema>;
  return "item" in props && "results" in props && Object.keys(props).length === 2;
}

/**
 * "$s4[*].leadId" on a loop that ran one call: a field the entry doesn't have can only be one of what that call
 * returned, or of each record it found ("$s4[*].results[0].items[*].leadId"). Not with more calls, nor a field
 * neither has.
 */
function loopSegs(props: Record<string, JsonSchema>, field: string): Seg[] | null {
  if (field === "item" || field === "results") return null;
  const calls = (unwrap(props.results!).prefixItems ?? []) as JsonSchema[];
  if (calls.length !== 1) return null;
  const fields = fieldsOf(calls[0]!);
  if (fields.includes(field)) return [{ field: "results" }, { index: 0 }, { field }];
  const found = ((unwrap(calls[0]!).properties ?? {}) as Record<string, JsonSchema>).items;
  if (found && kindOf(found) === "array" && fieldsOf((unwrap(found).items ?? ANY) as JsonSchema).includes(field)) {
    return [{ field: "results" }, { index: 0 }, { field: "items" }, { all: true }, { field }];
  }
  return null;
}

/** The same reading at run time: the plan compiled only where it is the one reading there is. */
export function loopRead(entry: Record<string, unknown>, field: string): { path: Seg[] } | null {
  if (field === "item" || field === "results" || !("item" in entry) || !Array.isArray(entry.results) || entry.results.length !== 1 || Object.keys(entry).length !== 2) return null;
  const r0 = entry.results[0];
  if (!r0 || typeof r0 !== "object" || Array.isArray(r0)) return null;
  if (!(field in r0) && Array.isArray((r0 as Record<string, unknown>).items)) return { path: [{ field: "results" }, { index: 0 }, { field: "items" }, { all: true }, { field }] };
  return { path: [{ field: "results" }, { index: 0 }, { field }] };
}

export function fmt(path: Seg[]): string {
  return path.map((s) => ("field" in s ? `.${s.field}` : "all" in s ? "[*]" : `[${s.index}]`)).join("");
}

// ---------- runtime values ----------

export class RefError extends Error {}

export function valueAt(value: unknown, path: Seg[], label: string): unknown {
  return walkValue(value, path, label).value;
}

function walkValue(value: unknown, path: Seg[], label: string): { value: unknown; many: boolean } {
  let cur = value;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const here = label + fmt(path.slice(0, i));
    if ("field" in seg) {
      if (cur === null || cur === undefined) throw new RefError(`${here} is empty, so .${seg.field} has no value`);
      if (Array.isArray(cur) && seg.field === "items" && !cur.some((x) => x && typeof x === "object" && "items" in x)) continue;
      if (Array.isArray(cur) && (seg.field === "results" || seg.field === "item") && cur.length && cur.every((x) => x && typeof x === "object" && "item" in x && "results" in x)) {
        return walkValue(cur, [{ all: true }, ...path.slice(i)], here);
      }
      if (typeof cur !== "object" || Array.isArray(cur)) throw new RefError(`${here} has no field "${seg.field}"`);
      const through = !(seg.field in cur) ? loopRead(cur as Record<string, unknown>, seg.field) : null;
      if (through) return walkValue(cur, [...through.path, ...path.slice(i + 1)], here);
      cur = (cur as Record<string, unknown>)[seg.field];
    } else {
      if (!Array.isArray(cur)) throw new RefError(`${here} is not a list`);
      if ("index" in seg) {
        const at = seg.index < 0 ? cur.length + seg.index : seg.index;
        if (at < 0 || at >= cur.length) throw new RefError(`${here} has ${cur.length} items, no [${seg.index}]`);
        cur = cur[at];
        continue;
      }
      const each = cur.map((x) => walkValue(x, path.slice(i + 1), `${here}[*]`));
      // "[*]" twice is one flat list, as its type says.
      return { value: each.flatMap((e) => (e.many ? (e.value as unknown[]) : [e.value])), many: true };
    }
  }
  return { value: cur, many: false };
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
