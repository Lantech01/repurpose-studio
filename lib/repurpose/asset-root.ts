import os from "node:os";
import path from "node:path";

export function defaultRepurposeAssetDir(homeDir = os.homedir()): string {
  return path.join(homeDir, "Downloads", "repurpose-overlays");
}

export function resolveRepurposeAssetDir(
  configured = process.env.REPURPOSE_ASSET_DIR,
  homeDir = os.homedir()
): string {
  return configured && configured.trim().length > 0
    ? path.resolve(configured)
    : defaultRepurposeAssetDir(homeDir);
}
