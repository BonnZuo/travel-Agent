import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemasDirectory = join(root, "schemas");

for (const fileName of await readdir(schemasDirectory)) {
  if (extname(fileName) !== ".json") continue;
  const schema = JSON.parse(await readFile(join(schemasDirectory, fileName), "utf8"));
  assert.equal(typeof schema, "object", `${fileName} must contain a JSON object`);
}

const html = await readFile(join(root, "index.html"), "utf8");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, "index.html must contain an inline script");
new Script(inlineScript, { filename: "index.html:inline-script" });

const requiredElementIds = [
  "landing", "app", "makePlan", "brief", "confirmPlan", "itinerary", "savedTrips",
  "checklist", "checklistList", "album", "albumGrid", "recommendationsPanel"
];
for (const id of requiredElementIds) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);

console.log(`Validated ${requiredElementIds.length} UI anchors and all JSON schemas.`);
