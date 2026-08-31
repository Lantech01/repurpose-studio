import { SFX_CATALOG } from "./sfx-effects";
import type { SfxAsset, SfxClipSource } from "./types";

export type ResolvedSfxSource = {
  kind: SfxClipSource["kind"];
  identity: string;
  url: string | null;
  sourceDuration: number;
  targetAmplitude: number;
  missing: boolean;
};

export function resolveSfxSource(
  source: SfxClipSource,
  assets: readonly SfxAsset[]
): ResolvedSfxSource {
  if (source.kind === "built-in") {
    const metadata = SFX_CATALOG[source.key];
    return {
      kind: source.kind,
      identity: `built-in:${source.key}`,
      url: `/api/repurpose/sfx?key=${encodeURIComponent(source.key)}`,
      sourceDuration: metadata.sourceDuration,
      targetAmplitude: metadata.targetAmplitude,
      missing: false,
    };
  }

  if (source.kind === "imported") {
    const asset = assets.find((candidate) => candidate.id === source.assetId);
    return asset
      ? {
          kind: source.kind,
          identity: `imported:${encodeURIComponent(source.assetId)}:path:${encodeURIComponent(asset.sourcePath)}`,
          url: `/api/repurpose/asset?path=${encodeURIComponent(asset.sourcePath)}`,
          sourceDuration: source.srcDuration,
          targetAmplitude: 1,
          missing: false,
        }
      : {
          kind: source.kind,
          identity: `imported:${encodeURIComponent(source.assetId)}:missing`,
          url: null,
          sourceDuration: source.srcDuration,
          targetAmplitude: 1,
          missing: true,
        };
  }

  return {
    kind: source.kind,
    identity: `legacy:${source.sourcePath}`,
    url: `/api/repurpose/sfx?path=${encodeURIComponent(source.sourcePath)}`,
    sourceDuration: source.srcDuration,
    targetAmplitude: 1,
    missing: false,
  };
}
