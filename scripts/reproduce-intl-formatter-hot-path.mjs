import { performance } from "node:perf_hooks";
import { isoCountryCodes } from "../public/country-codes.js";
import {
  formatNumber,
  formatRegionName,
  getLocale,
  setLanguage,
  supportedLanguages
} from "../public/i18n.js";

const sizeValues = Array.from(
  { length: 2_000 },
  (_, index) => 1_024 + ((index * 104_729) % (5 * 1_024 ** 3))
);
const regionPasses = 4;
const sampleCount = 7;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function formatSizeWithFreshFormatter(locale, bytes) {
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const maximumFractionDigits = value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value)} ${units[unitIndex]}`;
}

function formatSizeWithSharedCache(bytes) {
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${formatNumber(value, { maximumFractionDigits: value >= 10 ? 0 : 1 })} ${units[unitIndex]}`;
}

function measure(work) {
  const startedAt = performance.now();
  const checksum = work();
  return { milliseconds: performance.now() - startedAt, checksum };
}

function benchmark(work) {
  work();
  const samples = [];
  let checksum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const result = measure(work);
    samples.push(result.milliseconds);
    checksum = result.checksum;
  }
  return {
    medianMs: median(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samplesMs: samples,
    checksum
  };
}

function runFreshNumberFormatting() {
  let checksum = 0;
  for (const { locale } of supportedLanguages) {
    for (const bytes of sizeValues) checksum += formatSizeWithFreshFormatter(locale, bytes).length;
  }
  return checksum;
}

function runCachedNumberFormatting() {
  let checksum = 0;
  for (const { code } of supportedLanguages) {
    setLanguage(code, { persist: false });
    for (const bytes of sizeValues) checksum += formatSizeWithSharedCache(bytes).length;
  }
  return checksum;
}

function runFreshRegionFormatting() {
  let checksum = 0;
  for (const { locale } of supportedLanguages) {
    for (let pass = 0; pass < regionPasses; pass += 1) {
      for (const regionCode of isoCountryCodes) {
        checksum += (new Intl.DisplayNames([locale], { type: "region" }).of(regionCode) ?? regionCode).length;
      }
    }
  }
  return checksum;
}

function runCachedRegionFormatting() {
  let checksum = 0;
  for (const { code } of supportedLanguages) {
    setLanguage(code, { persist: false });
    for (let pass = 0; pass < regionPasses; pass += 1) {
      for (const regionCode of isoCountryCodes) checksum += formatRegionName(regionCode).length;
    }
  }
  return checksum;
}

const numberFresh = benchmark(runFreshNumberFormatting);
const numberCached = benchmark(runCachedNumberFormatting);
const regionFresh = benchmark(runFreshRegionFormatting);
const regionCached = benchmark(runCachedRegionFormatting);

if (numberFresh.checksum !== numberCached.checksum) {
  throw new Error(`Number-format checksum mismatch: ${numberFresh.checksum} !== ${numberCached.checksum}`);
}
if (regionFresh.checksum !== regionCached.checksum) {
  throw new Error(`Region-format checksum mismatch: ${regionFresh.checksum} !== ${regionCached.checksum}`);
}

console.log(JSON.stringify({
  node: process.version,
  sampleCount,
  numberCallsPerSample: supportedLanguages.length * sizeValues.length,
  regionCallsPerSample: supportedLanguages.length * regionPasses * isoCountryCodes.length,
  numberFresh,
  numberCached,
  numberSpeedup: numberFresh.medianMs / numberCached.medianMs,
  regionFresh,
  regionCached,
  regionSpeedup: regionFresh.medianMs / regionCached.medianMs
}, null, 2));
