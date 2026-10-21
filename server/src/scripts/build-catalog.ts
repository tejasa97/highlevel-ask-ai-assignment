// Builds src/registry/catalog.json from HighLevel's catalog PDF. The JSON is gitignored, like the PDF's
// content in general, so it's regenerated locally: npm run catalog [-- path/to/catalog.pdf]
// Layout per module: "M01 / 10 ACTIONS", the name, a description (may wrap), then "A01 Create contact" × 10.
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const pdfPath = process.argv[2] ?? `${ROOT}docs/assignment/ask-ai-50-modules-500-actions.pdf`;
const outPath = fileURLToPath(new URL("../registry/catalog.json", import.meta.url));

interface Module {
  id: string;
  name: string;
  description: string;
  actions: { id: string; name: string }[];
}

let bytes: Buffer;
try {
  bytes = readFileSync(pdfPath);
} catch {
  console.error(`Catalog PDF not found at ${pdfPath}. Put it there or pass its path: npm run catalog -- <pdf>`);
  process.exit(1);
}
const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false });
const lines = text.flatMap((page) => page.split("\n")).map((l) => l.trim());

const modules: Module[] = [];
let cur: Module | null = null;
let state: "name" | "description" | "actions" | "none" = "none";
for (const line of lines) {
  const head = /^M(\d{2}) \/ 10 ACTIONS$/.exec(line);
  if (head) {
    cur = { id: `M${head[1]}`, name: "", description: "", actions: [] };
    modules.push(cur);
    state = "name";
    continue;
  }
  if (!cur || state === "none") continue;
  const action = /^A(\d{2}) (.+)$/.exec(line);
  if (state === "name") {
    cur.name = line;
    state = "description";
  } else if (state === "description" && !action) {
    cur.description = cur.description ? `${cur.description} ${line}` : line; // wrapped description
  } else if (action) {
    cur.actions.push({ id: `${cur.id}.A${action[1]}`, name: action[2]! });
    state = "actions";
    if (cur.actions.length === 10) state = "none";
  } else {
    state = "none"; // page footer or a heading between modules
  }
}

// The PDF promises 50 × 10 with sequential ids; refuse to write anything else.
const problems: string[] = [];
if (modules.length !== 50) problems.push(`expected 50 modules, found ${modules.length}`);
modules.forEach((m, i) => {
  if (m.id !== `M${String(i + 1).padStart(2, "0")}`) problems.push(`module ${i + 1} has id ${m.id}`);
  if (!m.name || !m.description) problems.push(`${m.id} is missing its name or description`);
  if (m.actions.length !== 10) problems.push(`${m.id} has ${m.actions.length} actions`);
  m.actions.forEach((a, j) => {
    if (a.id !== `${m.id}.A${String(j + 1).padStart(2, "0")}`) problems.push(`${m.id} action ${j + 1} has id ${a.id}`);
  });
});
if (problems.length) {
  console.error(`Not writing catalog.json:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const source = `${relative(ROOT, pdfPath)} (HighLevel, 2026-10-19)`;
writeFileSync(outPath, `${JSON.stringify({ source, modules }, null, 1)}\n`);
console.log(`Wrote ${relative(ROOT, outPath)}: ${modules.length} modules, ${modules.reduce((n, m) => n + m.actions.length, 0)} actions.`);
