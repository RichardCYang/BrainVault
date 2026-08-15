import { emojiValues } from "./emoji-values.js";

export const emojiValueSet = new Set(emojiValues);

let loadedEmojiPickerData = null;
let emojiPickerDataPromise = null;

function buildEmojiPickerData(emojiCategoryDefinitions, emojiRecords) {
  return Object.freeze({
    categoryDefinitions: emojiCategoryDefinitions,
    records: emojiRecords,
    searchIndex: emojiRecords.map((record) =>
      `${record[0]} ${record[2]} ${record[3]} ${record[4]} ${record[5]}`.toLocaleLowerCase()
    ),
    recordByValue: new Map(emojiRecords.map((record, index) => [record[0], { record, index }])),
    categoryById: new Map(emojiCategoryDefinitions.map((category) => [category.id, category]))
  });
}

export function getLoadedEmojiPickerData() {
  return loadedEmojiPickerData;
}

export function loadEmojiPickerData() {
  if (loadedEmojiPickerData) return Promise.resolve(loadedEmojiPickerData);
  if (!emojiPickerDataPromise) {
    emojiPickerDataPromise = import("./emoji-data.js")
      .then(({ emojiCategoryDefinitions, emojiRecords }) => {
        const data = buildEmojiPickerData(emojiCategoryDefinitions, emojiRecords);
        loadedEmojiPickerData = data;
        return data;
      })
      .catch((error) => {
        emojiPickerDataPromise = null;
        throw error;
      });
  }
  return emojiPickerDataPromise;
}
