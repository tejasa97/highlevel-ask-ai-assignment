import type { ArgumentLookup } from "./define.js";
import type { JsonSchema, RegisteredAction } from "./registry.js";
import { parseRef, unwrap } from "../core/refs.js";

const ALIASES: Record<string, string[]> = {
  ownerId: ["user"], assigneeId: ["user"], accountManagerId: ["user"], authorId: ["user"], instructorId: ["user"],
  fieldId: ["custom_field"], assetId: ["media_asset"], planId: ["membership_plan"],
  postId: ["blog_post", "community_post"], pageId: ["landing_page"],
};

export function argumentEntities(action: RegisteredAction, path: string): string[] {
  const binding = action.argumentLookups?.[path.replace(/\[\d+\]/g, "[]")];
  if (binding) return [binding.entity];
  const key = path.split(".").at(-1)!;
  return key.endsWith("Id") ? ALIASES[key] ?? [key.replace(/Id$/, "").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] : [];
}

/** A concrete schema/argument path, never JSONPath expressions or prototype properties. */
export function argumentAt(action: RegisteredAction, args: Record<string, unknown>, path: string): { schema: JsonSchema; value: unknown; required: boolean } {
  const ref = parseRef(`$args.${path}`);
  if (!ref || !ref.path.length) throw new Error(`Invalid argument path ${path}`);
  let schema = action.inputSchema, value: unknown = args, required = false;
  for (const seg of ref.path) {
    schema = unwrap(schema);
    if ("field" in seg) {
      if (value === undefined) throw new Error(`Provide the parent argument before asking about ${path}`);
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      if (!Object.hasOwn(props, seg.field)) throw new Error(`Unknown argument ${path}`);
      required = ((schema.required ?? []) as string[]).includes(seg.field);
      schema = props[seg.field]!;
      value = value && typeof value === "object" && Object.hasOwn(value, seg.field) ? (value as Record<string, unknown>)[seg.field] : undefined;
    } else if ("index" in seg && schema.type === "array") {
      schema = schema.items as JsonSchema;
      if (!Array.isArray(value) || !Object.hasOwn(value, seg.index)) throw new Error(`Argument item ${path} does not exist`);
      value = value[seg.index];
    } else throw new Error(`Use a concrete argument path, not ${path}`);
  }
  return { schema: unwrap(schema), value, required };
}

/** Attach authoritative parent IDs. Conflicting explicit scope is rejected, not silently overwritten. */
export function scopedWhere(binding: ArgumentLookup | undefined, where: Record<string, string>, readParent: (path: string) => string): Record<string, string> {
  const result = { ...where };
  for (const [qualifier, parent] of Object.entries(binding?.scope ?? {})) {
    const value = readParent(parent);
    if (Object.hasOwn(result, qualifier) && result[qualifier] !== value) throw new Error(`Lookup ${qualifier} conflicts with parent argument ${parent}`);
    result[qualifier] = value;
  }
  return result;
}
