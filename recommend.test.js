import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recommendConcepts } from "./recommend.js";

const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
const concepts = catalog.concepts;

test("family separate photos is relevant", () => {
  const [first] = recommendConcepts("family portrait from separate photos with grandparents", concepts, 3);
  assert.match(first.concept, /Family/i);
});

test("pet memorial is relevant", () => {
  const [first] = recommendConcepts("memorial portrait for my dog", concepts, 3);
  assert.equal(first.category, "Memorial");
});

test("results are minimized and contain no commerce/internal fields", () => {
  const results = recommendConcepts("couple wedding", concepts, 3);
  for (const item of results) {
    assert.deepEqual(Object.keys(item).sort(), ["category", "concept", "photo_guidance", "summary", "why_it_fits"].sort());
    assert.equal("listing_id" in item, false);
    assert.equal("etsy_url" in item, false);
    assert.equal("timestamp" in item, false);
  }
});
