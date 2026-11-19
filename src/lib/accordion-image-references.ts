type AccordionItem = { id: string; icon?: string };

// Both inputs have already passed the structured metadata validator. Match on
// item identity so legacy inline images remain readable and editable in place.
export function changedAccordionImages(type: string, metadata: unknown, previous?: unknown) {
  if (type !== "ACCORDION") return [];
  const items = (value: unknown): AccordionItem[] => {
    const model = typeof value === "string" ? JSON.parse(value) : value;
    return model?.accordion?.items ?? [];
  };
  const old = new Map(items(previous).map((item) => [item.id, item.icon?.trim()]));
  return items(metadata).flatMap((item) => {
    const icon = item.icon?.trim();
    if (!icon?.startsWith("image:") || old.get(item.id) === icon) return [];
    const source = icon.slice(6).trim();
    return /^(?:data:image\/|\/upload\/icons\/)/i.test(source) ? [`image:${source}`] : [];
  });
}
