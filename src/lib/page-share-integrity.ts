export type PageShareRestoreTarget = {
  is_collection: number | boolean;
};

/**
 * A page share can be persisted for any ordinary page, including an archived
 * page. Archiving suspends live collaboration but does not delete the grant;
 * preserving the row lets an unarchived page resume its original access list.
 */
export function isRestorablePageShareTarget(
  page: PageShareRestoreTarget | null | undefined
): boolean {
  return Boolean(page && !page.is_collection);
}
