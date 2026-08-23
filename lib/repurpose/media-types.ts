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
