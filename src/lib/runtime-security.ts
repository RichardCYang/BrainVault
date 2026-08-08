export const nodeRuntimeSecurityFloor = "^22.23.2 || ^24.18.1 || >=26.5.1";

type ParsedNodeVersion = readonly [major: number, minor: number, patch: number];

const minimumNode22: ParsedNodeVersion = [22, 23, 2];
const minimumNode24: ParsedNodeVersion = [24, 18, 1];
const minimumNode26: ParsedNodeVersion = [26, 5, 1];

function parseStableNodeVersion(version: string): ParsedNodeVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return null;

  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : null;
}

function compareNodeVersions(left: ParsedNodeVersion, right: ParsedNodeVersion) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

export function isNodeRuntimeSupported(version: string) {
  const parsed = parseStableNodeVersion(version);
  if (!parsed) return false;

  const minimum = parsed[0] === 22
    ? minimumNode22
    : parsed[0] === 24
      ? minimumNode24
      : minimumNode26;

  return compareNodeVersions(parsed, minimum) >= 0;
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  if (isNodeRuntimeSupported(version)) return;

  throw new Error(
    `Unsupported Node.js runtime ${JSON.stringify(version)}. ` +
    `BrainVault requires a patched runtime satisfying ${nodeRuntimeSecurityFloor}. Refusing to start.`
  );
}
