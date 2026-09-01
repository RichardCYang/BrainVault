import { createHash } from "node:crypto";

export type PageDeletionSnapshotPage = {
  id: string;
  parent_page_id: string | null;
  edit_version: number;
  content_version: number;
};

export type PageDeletionSnapshotBlock = {
  id: string;
  page_id: string;
  edit_version: number;
};

export type PageDeletionSnapshotShare = {
  page_id: string;
  user_id: string;
  permission: string;
  generation: string;
};

export type PageDeletionSnapshotCollaborationState = {
  page_id: string;
  document_epoch: string;
};

export type PageDeletionSnapshotComment = {
  id: string;
  page_id: string;
  user_id: string;
  body_hash: string;
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createPageDeletionSnapshot(
  pages: readonly PageDeletionSnapshotPage[],
  blocks: readonly PageDeletionSnapshotBlock[],
  shares: readonly PageDeletionSnapshotShare[],
  collaborationStates: readonly PageDeletionSnapshotCollaborationState[],
  comments: readonly PageDeletionSnapshotComment[]
) {
  const hash = createHash("sha256");
  for (const page of [...pages].sort((left, right) => compareText(left.id, right.id))) {
    hash.update(
      `page\0${page.id}\0${page.parent_page_id ?? ""}\0${Number(page.edit_version ?? 1)}\0${Number(page.content_version ?? 1)}\n`
    );
  }
  for (const block of [...blocks].sort((left, right) => compareText(left.id, right.id))) {
    hash.update(`block\0${block.id}\0${block.page_id}\0${Number(block.edit_version ?? 1)}\n`);
  }
  for (const share of [...shares].sort((left, right) =>
    compareText(left.page_id, right.page_id)
      || compareText(left.user_id, right.user_id)
      || compareText(left.permission, right.permission)
      || compareText(left.generation, right.generation)
  )) {
    hash.update(
      `share\0${share.page_id}\0${share.user_id}\0${share.permission}\0${share.generation}\n`
    );
  }
  for (const state of [...collaborationStates].sort((left, right) =>
    compareText(left.page_id, right.page_id)
  )) {
    hash.update(`collaboration\0${state.page_id}\0${state.document_epoch}\n`);
  }
  for (const comment of [...comments].sort((left, right) =>
    compareText(left.page_id, right.page_id) || compareText(left.id, right.id)
  )) {
    // JSON framing keeps row identity unambiguous. The database-side
    // SHA-256 digest avoids transporting every comment body during subtree preview.
    hash.update(
      `comment\0${JSON.stringify([comment.page_id, comment.id, comment.user_id, comment.body_hash])}\n`
    );
  }
  return hash.digest("hex");
}
