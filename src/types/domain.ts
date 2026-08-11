export type UserRow = {
  id: string;
  username: string;
  name: string | null;
  avatar_data: string | null;
  preferred_language: string | null;
  default_collection_icon: string | null;
  theme: "light" | "dark" | null;
  country_login_mode?: "OFF" | "ALLOWLIST" | "BLOCKLIST";
  password_hash: string;
  vpn_block_enabled?: 0 | 1 | boolean | number | string;
  auth_version?: number;
  failed_login_attempts?: number | bigint | string;
  last_failed_login_at?: string | Date | null;
  login_locked_until?: string | Date | null;
  created_at: string;
  updated_at: string;
};

export type PageRow = {
  id: string;
  title: string;
  icon: string | null;
  cover_url: string | null;
  cover_position_x: number;
  cover_position_y: number;
  is_archived: 0 | 1;
  is_collection: 0 | 1;
  owner_id: string;
  parent_page_id: string | null;
  edit_version?: number;
  content_version?: number;
  last_mutation_id?: string | null;
  last_mutation_hash?: string | null;
  created_at: string;
  updated_at: string;
};

export type BlockType =
  | "MARKDOWN"
  | "HEADING_1"
  | "HEADING_2"
  | "HEADING_3"
  | "TODO"
  | "UNORDERED_LIST"
  | "ORDERED_LIST"
  | "QUOTE"
  | "CALLOUT"
  | "TOGGLE"
  | "TABLE"
  | "KANBAN"
  | "DATABASE"
  | "TIMETABLE"
  | "GANTT"
  | "BOOKMARK"
  | "AI_CHAT"
  | "MATH"
  | "CODE"
  | "DIVIDER"
  | "IMAGE"
  | "VIDEO"
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
  last_mutation_hash?: string | null;
  created_at: string;
  updated_at: string;
};

export type TagRow = {
  id: string;
  name: string;
  created_at: string;
};
