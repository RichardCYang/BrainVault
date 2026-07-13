export const calloutTypes = ["idea", "info", "success", "warning", "danger"] as const;

export type CalloutType = (typeof calloutTypes)[number];

const calloutTypeSet = new Set<string>(calloutTypes);

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

export function getCalloutType(metadata: unknown): CalloutType {
  const value = parseMetadata(metadata)?.calloutType;
  return typeof value === "string" && calloutTypeSet.has(value) ? (value as CalloutType) : "idea";
}
