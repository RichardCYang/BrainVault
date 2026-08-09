export type YouTubeVideo = {
  videoId: string;
  startSeconds: number;
  embedUrl: string;
  watchUrl: string;
};

export const youtubeVideoUrlMaxLength: number;

export function parseYouTubeVideoUrl(value: unknown): YouTubeVideo | null;
export function updateYouTubeVideoPreview(root: unknown, value: unknown): void;
export function createYouTubeVideoEditor(block: { markdown?: string | null } | null | undefined): unknown;
