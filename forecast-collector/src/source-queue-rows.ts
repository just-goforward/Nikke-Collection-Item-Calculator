import type { NaverSourceKind, SourceQueueItem } from "./types";

export type PollStateRow = {
  page_size: number;
  committed_item_id: string | null;
  committed_published_at: string | null;
  scan_head_item_id: string | null;
  scan_head_published_at: string | null;
  next_offset: number;
  updated_at: string;
};

export type SourceQueueRow = {
  source: NaverSourceKind;
  item_id: string;
  url: string;
  title: string;
  published_at: string;
  official: number;
  status: SourceQueueItem["status"];
  attempts: number;
  error_code: string | null;
};
