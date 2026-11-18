// Bidi formatting controls can disguise identifiers. Preserve ordinary RTL
// letters and combining characters; only remove explicit direction controls.
// Keep the live-title display boundary in public/app.js aligned with this.
export function sanitizeDisplayLabel(value: string): string {
  return value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
