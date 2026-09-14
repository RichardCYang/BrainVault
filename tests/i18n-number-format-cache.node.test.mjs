import assert from "node:assert/strict";
import test from "node:test";

test("localized number formatting preserves output while reusing one formatter per locale", async () => {
  const OriginalNumberFormat = Intl.NumberFormat;
  let constructions = 0;

  function CountingNumberFormat(...args) {
    constructions += 1;
    return new OriginalNumberFormat(...args);
  }
  Object.setPrototypeOf(CountingNumberFormat, OriginalNumberFormat);
  CountingNumberFormat.prototype = OriginalNumberFormat.prototype;

  Intl.NumberFormat = CountingNumberFormat;
  try {
    const moduleUrl = new URL("../public/i18n.js", import.meta.url);
    moduleUrl.searchParams.set("number-format-cache-test", `${Date.now()}-${Math.random()}`);
    const { formatNumber, getLocale, setLanguage, supportedLanguages } = await import(moduleUrl.href);
    const values = [0, 1, 12.34, 1234, -9876543.21, Number.MAX_SAFE_INTEGER];

    for (const { code } of supportedLanguages) {
      setLanguage(code, { persist: false });
      const locale = getLocale();
      const expectedFormatter = new OriginalNumberFormat(locale);

      for (let pass = 0; pass < 3; pass += 1) {
        for (const value of values) {
          assert.equal(formatNumber(value), expectedFormatter.format(value));
        }
      }
    }

    assert.equal(
      constructions,
      supportedLanguages.length,
      "formatNumber should construct at most one Intl.NumberFormat for each supported locale"
    );

    setLanguage("ko", { persist: false });
    assert.equal(formatNumber(1234567.89), new OriginalNumberFormat("ko-KR").format(1234567.89));
    assert.equal(constructions, supportedLanguages.length, "switching back to a locale should reuse its cached formatter");
  } finally {
    Intl.NumberFormat = OriginalNumberFormat;
  }
});


test("custom number options and region names preserve output while reusing Intl formatters", async () => {
  const OriginalNumberFormat = Intl.NumberFormat;
  const OriginalDisplayNames = Intl.DisplayNames;
  let numberConstructions = 0;
  let displayNameConstructions = 0;

  function CountingNumberFormat(...args) {
    numberConstructions += 1;
    return new OriginalNumberFormat(...args);
  }
  Object.setPrototypeOf(CountingNumberFormat, OriginalNumberFormat);
  CountingNumberFormat.prototype = OriginalNumberFormat.prototype;

  function CountingDisplayNames(...args) {
    displayNameConstructions += 1;
    return new OriginalDisplayNames(...args);
  }
  Object.setPrototypeOf(CountingDisplayNames, OriginalDisplayNames);
  CountingDisplayNames.prototype = OriginalDisplayNames.prototype;

  Intl.NumberFormat = CountingNumberFormat;
  Intl.DisplayNames = CountingDisplayNames;
  try {
    const moduleUrl = new URL("../public/i18n.js", import.meta.url);
    moduleUrl.searchParams.set("intl-format-cache-options-test", `${Date.now()}-${Math.random()}`);
    const { formatNumber, formatRegionName, getLocale, setLanguage, supportedLanguages } = await import(moduleUrl.href);
    const optionSets = [{ maximumFractionDigits: 0 }, { maximumFractionDigits: 1 }];
    const regionCodes = ["KR", "US", "JP", "DE", "FR"];

    for (const { code } of supportedLanguages) {
      setLanguage(code, { persist: false });
      const locale = getLocale();
      for (const options of optionSets) {
        const expectedFormatter = new OriginalNumberFormat(locale, options);
        for (let pass = 0; pass < 4; pass += 1) {
          assert.equal(formatNumber(12345.678, options), expectedFormatter.format(12345.678));
        }
      }

      const expectedRegions = new OriginalDisplayNames([locale], { type: "region" });
      for (let pass = 0; pass < 4; pass += 1) {
        for (const regionCode of regionCodes) {
          assert.equal(formatRegionName(regionCode), expectedRegions.of(regionCode) ?? regionCode);
        }
      }
    }

    assert.equal(
      numberConstructions,
      supportedLanguages.length * optionSets.length,
      "custom number formatting should construct one formatter per locale/options pair"
    );
    assert.equal(
      displayNameConstructions,
      supportedLanguages.length,
      "region display names should construct one formatter per locale"
    );

    setLanguage("ko", { persist: false });
    assert.equal(formatRegionName("not-a-region"), "NOT-A-REGION");
    assert.equal(displayNameConstructions, supportedLanguages.length);
  } finally {
    Intl.NumberFormat = OriginalNumberFormat;
    Intl.DisplayNames = OriginalDisplayNames;
  }
});
