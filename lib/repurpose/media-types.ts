export type VideoRole = "face" | "screen" | "overlay" | "library";

export interface UploadedVideo {
  originalPath: string;
  contentHash: string;
  size: number;
  name: string;
}
