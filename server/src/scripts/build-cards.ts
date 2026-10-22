// Builds src/retrieval/cards.json: a search card for every catalog action (description in user language,
// synonyms, entity types, look-alike siblings). Generated once per module through the planner adapter,
// then reviewed and committed. The generator never sees eval/ (see cards.test.ts for the overlap check).
//   npm run cards                 all modules missing from cards.json
//   npm run cards -- M28 M29      regenerate these modules
//   npm run cards -- --all        regenerate everything
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makePlanner } from "../planner/index.js";
import { CATALOG, type CatalogModule } from "../registry/catalog.js";
import { loadRegistry } from "../registry/registry.js";
import { ENTITY_TYPES, type CardFile, type CardMeta } from "../retrieval/cards.js";

const OUT = fileURLToPath(new URL("../retrieval/cards.json", import.meta.url));
const CONCURRENCY = 5;

const SYSTEM = `You write search metadata for the actions of a CRM, so that a keyword search (BM25) can find the right
action from what a user types. You get one module and its 10 actions, plus the whole catalog for context.
For each action return:
- description: one or two plain English sentences in everyday words, 15-35 words. Say what it does and, where a
  look-alike exists, how it differs (e.g. "Cancel" vs "Mark complete"). No API words (endpoint, payload, CRUD).
- synonyms: 8-12 short words or phrases (1-4 words) a user might type for this action: informal verbs,
  everyday nouns, abbreviations and alternative phrasings. Spell them correctly; typos are handled by fuzzy matching. Include the record noun in some of them.
  Avoid words that would equally describe the module's other actions (e.g. don't put "lead" alone in every
  lead action). Don't repeat the action name itself.
- produces: the entity type this action returns or creates, or null. consumes: entity types whose ids it needs.
  Use only these types: ${ENTITY_TYPES.join(", ")}.
- siblings: ids of actions in OTHER modules a user could confuse this with (same verb, different record type),
  e.g. "Assign lead owner" ↔ "Assign contact owner". Usually 0-2. Never the same module.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "synonyms", "produces", "consumes", "siblings"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          synonyms: { type: "array", items: { type: "string" } },
          produces: { anyOf: [{ enum: ENTITY_TYPES }, { type: "null" }] },
          consumes: { type: "array", items: { enum: ENTITY_TYPES } },
          siblings: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const registry = await loadRegistry();
const catalogText = CATALOG.map((m) => `${m.id} ${m.name}: ${m.actions.map((a) => `${a.id} ${a.name}`).join(" | ")}`).join("\n");

function userBlock(m: CatalogModule): string {
  const lines = m.actions.map((a) => {
    const impl = registry.get(a.id);
    return impl ? `${a.id} ${a.name} — current description: ${impl.description}` : `${a.id} ${a.name}`;
  });
  return `<catalog>\n${catalogText}\n</catalog>\n<module>${m.id} ${m.name}: ${m.description}\n${lines.join("\n")}\n</module>`;
}

const existing: CardFile = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { cards: {} };
const args = process.argv.slice(2);
const todo = CATALOG.filter((m) =>
  args.includes("--all") ? true : args.length ? args.includes(m.id) : !m.actions.every((a) => existing.cards[a.id]),
);
console.log(`generating cards for ${todo.length} module(s)`);

const planner = makePlanner("claude-cli"); // Keep the existing Claude provenance stamp accurate.
const ids = new Set(CATALOG.flatMap((m) => m.actions.map((a) => a.id)));
let cost = 0;

async function one(m: CatalogModule): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await planner.plan({ tier: "strong", system: SYSTEM, user: userBlock(m), schema: SCHEMA });
      if (r.usage.costUsd === null) throw new Error("card generation needs an API-equivalent cost estimate");
      cost += r.usage.costUsd;
      const got = (r.json as { actions: (CardMeta & { id: string })[] }).actions;
      const want = m.actions.map((a) => a.id);
      const missing = want.filter((id) => !got.some((c) => c.id === id));
      if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
      for (const c of got) {
        if (!want.includes(c.id)) continue;
        const { id, ...meta } = c;
        meta.siblings = meta.siblings.filter((s) => ids.has(s) && s.slice(0, 3) !== id.slice(0, 3));
        existing.cards[id] = meta;
      }
      console.log(`  ${m.id} ${m.name} ✓ (${Math.round(r.latencyMs / 1000)} s)`);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`  ${m.id} retry ${attempt}: ${(e as Error).message}`);
    }
  }
}

// A module that still fails after its retries is reported, and everything else is written anyway, so a
// rerun only pays for what's missing.
const queue = [...todo];
const failedModules: string[] = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      await one(m).catch((e: Error) => {
        failedModules.push(m!.id);
        console.log(`  ${m!.id} failed: ${e.message}`);
      });
    }
  }),
);

const sorted = Object.fromEntries(Object.entries(existing.cards).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT, JSON.stringify({ generatedBy: "npm run cards (claude-sonnet-5-5)", cards: sorted }, null, 1) + "\n");
console.log(`wrote ${Object.keys(sorted).length} cards to ${OUT} · ~$${cost.toFixed(2)}`);
if (failedModules.length) {
  console.log(`failed: ${failedModules.join(" ")} (rerun: npm run cards -- ${failedModules.join(" ")})`);
  process.exitCode = 1;
}
