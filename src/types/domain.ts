export type UserRow = {
  id: string;
  username: string;
  name: string | null;
  avatar_data: string | null;
  preferred_language: string | null;
  default_collection_icon: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
};

export type PageRow = {
  id: string;
  title: string;
  icon: string | null;
  cover_url: string | null;
  is_archived: 0 | 1;
  is_collection: 0 | 1;
  owner_id: string;
  parent_page_id: string | null;
  edit_version?: number;
  content_version?: number;
  last_mutation_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type BlockType =
  | "MARKDOWN"
  | "HEADING_1"
  | "HEADING_2"
  | "HEADING_3"
  | "TODO"
  | "QUOTE"
  | "CALLOUT"
  | "TABLE"
  | "KANBAN"
  | "DATABASE"
  | "BOOKMARK"
  | "AI_CHAT"
  | "MATH"
  | "CODE"
  | "DIVIDER"
  | "IMAGE"
  | "ATTACHMENT";

export type BlockRow = {
  id: string;
  page_id: string;
  parent_block_id: string | null;
  type: BlockType;
  markdown: string;
  html_cache: string | null;
  checked: 0 | 1;
  sort_order: number;
  metadata: string | Record<string, unknown> | null;
  edit_version?: number;
  last_mutation_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type TagRow = {
  id: string;
  name: string;
  created_at: string;
};
