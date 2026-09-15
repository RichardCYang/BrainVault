import { isPublicCountryLookupIp, normalizeCountryLookupIp } from "./geo-country.js";

function addTorExitAddressLine(addresses: Set<string>, line: string) {
  if (!line.startsWith("ExitAddress ")) return;
  const rawIp = line.split(/\s+/)[1] ?? "";
  const normalizedIp = normalizeCountryLookupIp(rawIp);
  if (normalizedIp && isPublicCountryLookupIp(normalizedIp)) addresses.add(normalizedIp);
}

function pushTorExitDecodedChunk(addresses: Set<string>, pendingText: string, decodedText: string) {
  const text = pendingText + decodedText;
  let lineStart = 0;
  while (true) {
    const newlineIndex = text.indexOf("\n", lineStart);
    if (newlineIndex < 0) break;
    const lineEnd = newlineIndex > lineStart && text.charCodeAt(newlineIndex - 1) === 13
      ? newlineIndex - 1
      : newlineIndex;
    addTorExitAddressLine(addresses, text.slice(lineStart, lineEnd));
    lineStart = newlineIndex + 1;
  }
  return text.slice(lineStart);
}

export async function readTorExitAddresses(response: Response, maxBytes: number) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const contentLength = Number(declaredLength);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      throw new Error("Tor exit list exceeded the configured size limit");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Tor exit list did not contain a body");

  const addresses = new Set<string>();
  const decoder = new TextDecoder();
  let pendingText = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Tor exit list exceeded the configured size limit");
      }
      pendingText = pushTorExitDecodedChunk(
        addresses,
        pendingText,
        decoder.decode(value, { stream: true })
      );
    }
  } finally {
    reader.releaseLock();
  }

  pendingText = pushTorExitDecodedChunk(addresses, pendingText, decoder.decode());
  if (pendingText) addTorExitAddressLine(addresses, pendingText);
  return addresses;
}
