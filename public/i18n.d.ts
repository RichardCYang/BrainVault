export type TranslationCatalog = {
  sharing: Record<string, string>;
  status: Record<string, string>;
  [section: string]: Record<string, string>;
};

export const translationCatalogs: Record<string, TranslationCatalog>;
