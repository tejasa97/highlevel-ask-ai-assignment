import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ENTITIES, INTERNAL_PREFIXES, RESERVED } from "./entities.js";

const catalog = JSON.parse(readFileSync(new URL("../registry/catalog.json", import.meta.url), "utf8")) as { modules: { id: string }[] };
const moduleIds = new Set(catalog.modules.map((m) => m.id));

test("no two tables share an id prefix, and none collides with a reserved or internal one", () => {
  const seen = new Map<string, string>();
  const all = [
    ...Object.entries(ENTITIES).map(([name, d]) => [name, d.prefix] as const),
    ...Object.entries(RESERVED),
    ...INTERNAL_PREFIXES.map((p) => [`(internal ${p})`, p] as const),
  ];
  for (const [name, prefix] of all) {
    assert.match(prefix, /^[a-z]{2,3}$/, `${name}: prefix ${prefix}`);
    assert.equal(seen.get(prefix), undefined, `prefix ${prefix} is used by both ${seen.get(prefix)} and ${name}`);
    seen.set(prefix, name);
  }
  for (const name of Object.keys(RESERVED)) assert.equal((ENTITIES as Record<string, unknown>)[name], undefined, `${name} is reserved`);
});

test("every table belongs to a catalog module", () => {
  for (const [name, d] of Object.entries(ENTITIES)) assert.ok(moduleIds.has(d.module), `${name} → ${d.module}`);
});

// insert()/make() calls spell out the table and prefix; they must agree with the map above.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

test("every insert/make call in the code uses the table's registered prefix", () => {
  const re = /\b(?:insert|make)(?:<[^>]*>)?\(\s*"([a-z_]+)",\s*"([a-z]+)"/g;
  let checked = 0;
  for (const file of sources(new URL("..", import.meta.url).pathname)) {
    for (const m of readFileSync(file, "utf8").matchAll(re)) {
      const def = (ENTITIES as Record<string, { prefix: string }>)[m[1]!];
      assert.ok(def, `${file}: table ${m[1]} is not in ENTITIES`);
      assert.equal(def.prefix, m[2], `${file}: ${m[1]} uses prefix ${m[2]}`);
      checked++;
    }
  }
  assert.ok(checked > 20, "the scan found the existing call sites");
});
