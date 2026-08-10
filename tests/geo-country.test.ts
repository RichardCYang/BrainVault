import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCountryDatasetUpdatedAt,
  isPublicCountryLookupIp,
  lookupCountryCodes,
  normalizeCountryCode,
  normalizeCountryLookupIp,
  resetCountryInfoCacheForTests
} from "../src/lib/geo-country.js";

beforeEach(() => {
  resetCountryInfoCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeoIP country lookup", () => {
  it("normalizes mapped IPv4 and excludes addresses that cannot have a public country", () => {
    expect(normalizeCountryLookupIp("::ffff:8.8.8.8")).toBe("8.8.8.8");
    expect(isPublicCountryLookupIp("8.8.8.8")).toBe(true);
    expect(isPublicCountryLookupIp("127.0.0.1")).toBe(false);
    expect(isPublicCountryLookupIp("10.0.0.1")).toBe(false);
    expect(isPublicCountryLookupIp("::1")).toBe(false);
    expect(isPublicCountryLookupIp("fd00::1")).toBe(false);
    expect(normalizeCountryCode("kr")).toBe("KR");
    expect(normalizeCountryCode("unknown")).toBeNull();
  });

  it("uses the no-key batch endpoint and treats omitted public IPs as unresolved countries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ ip: "8.8.8.8", country: "US" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupCountryCodes(["8.8.8.8", "1.1.1.1", "127.0.0.1"]);

    expect(result.get("8.8.8.8")).toBe("US");
    expect(result.get("1.1.1.1")).toBeNull();
    expect(result.has("127.0.0.1")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.country.is/");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("checks provider dataset freshness and caches the metadata briefly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ lastUpdated: "2026-08-10T01:02:03.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCountryDatasetUpdatedAt()).resolves.toEqual(new Date("2026-08-10T01:02:03.000Z"));
    await expect(getCountryDatasetUpdatedAt()).resolves.toEqual(new Date("2026-08-10T01:02:03.000Z"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.country.is/info");
  });

  it("fails open when the GeoIP provider is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(lookupCountryCodes(["8.8.8.8"])).resolves.toEqual(new Map());
    await expect(getCountryDatasetUpdatedAt()).resolves.toBeNull();
  });
});
