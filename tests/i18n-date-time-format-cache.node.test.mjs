import assert from "node:assert/strict";
import test from "node:test";

test("localized date/time formatting preserves output while reusing formatters by locale and options", async () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let constructions = 0;

  function CountingDateTimeFormat(...args) {
    constructions += 1;
    return new OriginalDateTimeFormat(...args);
  }
  Object.setPrototypeOf(CountingDateTimeFormat, OriginalDateTimeFormat);
  CountingDateTimeFormat.prototype = OriginalDateTimeFormat.prototype;

  Intl.DateTimeFormat = CountingDateTimeFormat;
  try {
    const moduleUrl = new URL("../public/i18n.js", import.meta.url);
    moduleUrl.searchParams.set("date-time-format-cache-test", `${Date.now()}-${Math.random()}`);
    const { formatDateTime, getLocale, setLanguage, supportedLanguages } = await import(moduleUrl.href);
    const values = [
      new Date("2026-01-02T03:04:05.000Z"),
      new Date("2026-08-15T14:19:00.000Z"),
      new Date("2030-12-31T23:59:59.000Z")
    ];
    const optionSets = [
      { dateStyle: "medium", timeStyle: "short" },
      { timeZone: "UTC", month: "short", day: "numeric" },
      { timeZone: "UTC", weekday: "narrow", day: "numeric" },
      { timeZone: "UTC", month: "long", year: "numeric" },
      { timeZone: "UTC", weekday: "short", year: "numeric", month: "short", day: "numeric" }
    ];

    for (const { code } of supportedLanguages) {
      setLanguage(code, { persist: false });
      const locale = getLocale();
      for (const options of optionSets) {
        const expectedFormatter = new OriginalDateTimeFormat(locale, options);
        for (let pass = 0; pass < 3; pass += 1) {
          for (const value of values) {
            assert.equal(formatDateTime(value, options), expectedFormatter.format(value));
          }
        }
      }
    }

    assert.equal(
      constructions,
      supportedLanguages.length * optionSets.length,
      "formatDateTime should construct at most one Intl.DateTimeFormat for each locale/options pair"
    );

    setLanguage("ko", { persist: false });
    const reorderedOptions = { day: "numeric", month: "short", timeZone: "UTC" };
    assert.equal(
      formatDateTime(values[0], reorderedOptions),
      new OriginalDateTimeFormat("ko-KR", reorderedOptions).format(values[0])
    );
    assert.equal(
      constructions,
      supportedLanguages.length * optionSets.length,
      "equivalent option objects with different property order should reuse the same cached formatter"
    );
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
});
