import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source section: ${start}`);
  return source.slice(startIndex, endIndex);
}

test("browser network headers reuse the resolved local time zone inside a bounded refresh window", async () => {
  const source = await read("public/app.js");
  const section = sourceSection(
    source,
    "const browserTimeZoneCacheMs =",
    "async function applyClientNetworkVerificationHeaders("
  );

  assert.match(section, /const browserTimeZoneCacheMs = 5 \* 60_000;/);
  assert.match(section, /if \(now < browserTimeZoneCacheExpiresAt\) return browserTimeZoneCache;/);
  assert.match(section, /browserTimeZoneCacheExpiresAt = now \+ browserTimeZoneCacheMs;/);

  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let constructions = 0;
  let now = 1_000_000;

  function CountingDateTimeFormat(...args) {
    constructions += 1;
    return new OriginalDateTimeFormat(...args);
  }

  const sandbox = {
    Date: { now: () => now },
    Intl: { DateTimeFormat: CountingDateTimeFormat },
    result: null
  };
  vm.runInNewContext(`${section}\nresult = { getBrowserTimeZone };`, sandbox);

  const first = sandbox.result.getBrowserTimeZone();
  for (let index = 0; index < 100; index += 1) {
    assert.equal(sandbox.result.getBrowserTimeZone(), first);
  }
  assert.equal(constructions, 1, "repeated API requests inside the cache window should not rebuild Intl.DateTimeFormat");

  now += 4 * 60_000;
  assert.equal(sandbox.result.getBrowserTimeZone(), first);
  assert.equal(constructions, 1);

  now += 2 * 60_000;
  assert.equal(sandbox.result.getBrowserTimeZone(), first);
  assert.equal(constructions, 2, "the local time zone should be re-resolved after the bounded cache expires");
});

test("VPN time-zone mismatch evaluation reuses a bounded formatter cache without freezing DST offsets", async () => {
  const source = await read("src/lib/vpn-access-policy.ts");
  assert.match(source, /const maxTimeZoneFormatterCacheEntries = 512;/);
  assert.match(source, /const timeZoneOffsetFormatters = new Map<string, Intl\.DateTimeFormat>\(\);/);
  assert.match(source, /if \(timeZoneOffsetFormatters\.size >= maxTimeZoneFormatterCacheEntries\)/);
  assert.match(source, /timeZoneOffsetFormatters\.clear\(\);/);

  let section = sourceSection(
    source,
    "function getTimeZoneOffsetFormatter(",
    "export function getClientTimeZone("
  );
  assert.equal(
    (section.match(/new Intl\.DateTimeFormat/g) ?? []).length,
    1,
    "time-zone validation and offset reads should share the same formatter constructor site"
  );
  section = section
    .replace("function getTimeZoneOffsetFormatter(timeZone: string)", "function getTimeZoneOffsetFormatter(timeZone)")
    .replace(
      "function isValidTimeZone(value: string | null | undefined): value is string",
      "function isValidTimeZone(value)"
    )
    .replace(
      "function getTimeZoneOffsetMinutes(timeZone: string, date = new Date())",
      "function getTimeZoneOffsetMinutes(timeZone, date = new Date())"
    );

  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let constructions = 0;
  function CountingDateTimeFormat(...args) {
    constructions += 1;
    return new OriginalDateTimeFormat(...args);
  }

  const sandbox = {
    Intl: { DateTimeFormat: CountingDateTimeFormat },
    Date,
    Map,
    result: null
  };
  vm.runInNewContext(
    `const maxTimeZoneFormatterCacheEntries = 512;\n` +
      `const timeZoneOffsetFormatters = new Map();\n` +
      `${section}\n` +
      `result = { isValidTimeZone, getTimeZoneOffsetMinutes };`,
    sandbox
  );

  assert.equal(sandbox.result.isValidTimeZone("Asia/Seoul"), true);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      sandbox.result.getTimeZoneOffsetMinutes("Asia/Seoul", new Date("2026-09-14T12:00:00.000Z")),
      540
    );
  }
  assert.equal(constructions, 1, "validation and repeated offset reads should reuse one formatter for a time zone");

  assert.equal(
    sandbox.result.getTimeZoneOffsetMinutes("America/New_York", new Date("2026-01-15T12:00:00.000Z")),
    -300
  );
  assert.equal(
    sandbox.result.getTimeZoneOffsetMinutes("America/New_York", new Date("2026-07-15T12:00:00.000Z")),
    -240
  );
  assert.equal(constructions, 2, "the cached formatter must still evaluate the supplied date, including DST changes");
});
