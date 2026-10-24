import type { JsonSchema, RegisteredAction } from "./registry.js";

// Action cards: the one-line form the planner reads in <actions>, generated from the Zod schemas.
//   M03.A03 Search leads: <description> args { source?: "facebook_ads"|… } → { items: Lead[] }

export function card(a: RegisteredAction): string {
  const lookups = (a.argumentLookups ? ` named IDs ${JSON.stringify(a.argumentLookups)}` : "") +
    (a.typedIds ? ` named IDs by record type ${JSON.stringify(a.typedIds)}` : "");
  const alternatives = a.inputAlternatives ? ` requires one input group ${JSON.stringify(a.inputAlternatives)}` : "";
  return `${a.id} ${a.name}: ${a.description} args ${sig(a.inputSchema, 0, true)} → ${sig(a.outputSchema, 0, false)}${lookups}${alternatives}`;
}

const MAX_DEPTH = 3;

/** JSON Schema → compact TypeScript-like signature. Field descriptions are kept for inputs only. */
export function sig(s: JsonSchema | undefined, depth = 0, withDocs = false): string {
  if (!s) return "any";
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join("|");
  if ("const" in s) return JSON.stringify(s.const);
  const union = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (union) {
    const parts = union.filter((u) => u.type !== "null").map((u) => sig(u, depth, withDocs));
    const nullable = union.some((u) => u.type === "null");
    return parts.join("|") + (nullable ? "|null" : "");
  }
  const type = s.type;
  if (Array.isArray(type)) return type.map((t) => sig({ ...s, type: t }, depth, withDocs)).join("|");
  switch (type) {
    case "string":
      return s.format === "date" ? "date" : s.format === "date-time" ? "datetime" : s.format === "email" ? "email" : "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const inner = sig(s.items as JsonSchema, depth, withDocs);
      return /[|{ ]/.test(inner) && !inner.startsWith("{") ? `(${inner})[]` : `${inner}[]`;
    }
    case "object": {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const keys = Object.keys(props);
      if (keys.length === 0) return "object";
      if (depth >= MAX_DEPTH) return "{…}";
      const req = new Set((s.required as string[] | undefined) ?? []);
      const fields = keys.map((k) => {
        const p = props[k]!;
        const doc = withDocs && typeof p.description === "string" ? ` /* ${p.description} */` : "";
        return `${k}${req.has(k) ? "" : "?"}: ${sig(p, depth + 1, withDocs)}${doc}`;
      });
      return `{ ${fields.join(", ")} }`;
    }
    default:
      return "any";
  }
}
