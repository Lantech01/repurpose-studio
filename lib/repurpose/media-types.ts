export type VideoRole = "face" | "screen" | "overlay" | "library";

export interface UploadedVideo {
  originalPath: string;
  contentHash: string;
  size: number;
  name: string;
}

export interface MediaInspection {
  fingerprint: string;
  container: string;
  extension: string;
  size: number;
  durationSec: number;
  video: {
    codec: string;
    codecTag: string;
    profile: string;
    pixelFormat: string;
    width: number;
    height: number;
    fps: number;
    rotationDeg?: number;
  };
  audio: null | {
    codec: string;
    channels: number;
    sampleRate: number;
  };
}

export interface BrowserMediaProbe {
  decodable: boolean;
  durationSec: number;
  width: number;
  height: number;
  reason?: string;
}

export type CompatibilityStatus =
  | "none"
  | "queued"
  | "building"
  | "ready"
  | "failed"
  | "cancelled"
  | "unavailable";

export interface CompatibilityState {
  status: CompatibilityStatus;
  progress: number | null;
  workingPath?: string;
  error?: { code: string; message: string };
}
