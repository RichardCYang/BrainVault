import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  emojiValueSet,
  getLoadedEmojiPickerData,
  loadEmojiPickerData
} from "../public/emoji-data-loader.js";
import { emojiValues } from "../public/emoji-values.js";
import { emojiCategoryDefinitions, emojiRecords } from "../public/emoji-data.js";

const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("the compact emoji value list exactly matches the authoritative searchable dataset", () => {
  assert.equal(emojiValues.length, emojiRecords.length);
  assert.deepEqual(emojiValues, emojiRecords.map((record) => record[0]));
  assert.equal(emojiValueSet.size, emojiValues.length);
  for (const value of emojiValues) assert.equal(emojiValueSet.has(value), true);
});

test("localized emoji search metadata loads lazily and preserves the original lookup semantics", async () => {
  const before = getLoadedEmojiPickerData();
  if (before) {
    assert.equal(before.records, emojiRecords);
  }

  const first = await loadEmojiPickerData();
  const second = await loadEmojiPickerData();

  assert.equal(first, second);
  assert.equal(first.records, emojiRecords);
  assert.equal(first.categoryDefinitions, emojiCategoryDefinitions);
  assert.equal(first.searchIndex.length, emojiRecords.length);
  assert.equal(first.recordByValue.size, emojiRecords.length);
  assert.equal(first.categoryById.size, emojiCategoryDefinitions.length);

  for (const [index, record] of emojiRecords.entries()) {
    assert.equal(first.recordByValue.get(record[0])?.index, index);
    assert.equal(first.recordByValue.get(record[0])?.record, record);
    assert.equal(
      first.searchIndex[index],
      `${record[0]} ${record[2]} ${record[3]} ${record[4]} ${record[5]}`.toLocaleLowerCase()
    );
  }
});

test("the workspace no longer eagerly imports the large searchable dataset and handles lazy-load races", () => {
  assert.doesNotMatch(app, /^import\s+\{[^}]*emojiRecords[^}]*\}\s+from\s+"\.\/emoji-data\.js";/m);
  assert.match(app, /from "\.\/emoji-data-loader\.js";/);
  assert.match(app, /const renderGeneration = \+\+emojiPickerRenderGeneration;/);
  assert.match(app, /void loadEmojiPickerData\(\)[\s\S]*?renderGeneration !== emojiPickerRenderGeneration/);
  assert.match(app, /emojiPickerRenderGeneration \+= 1;[\s\S]*?if \(elements\.emojiPickerLayer\.classList\.contains\("hidden"\)\) return;/);
  assert.match(app, /emojiValueSet\.has\(emojiValue\)/);
  assert.match(app, /emojiValueSet\.has\(value\)/);
});
