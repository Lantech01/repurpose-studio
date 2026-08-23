import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
]);

export const REPURPOSE_FOOTAGE_DIR = path.join(
  os.homedir(),
  "Downloads",
  "repurpose-footage"
);

const ALLOWED_ROOTS = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Movies"),
  os.tmpdir(),
];

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveAllowedVideoPath(rawPath: string): Promise<string | null> {
  if (!rawPath || !path.isAbsolute(rawPath)) return null;

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(rawPath);
  } catch {
    return null;
  }

  if (!VIDEO_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) return null;

  for (const root of ALLOWED_ROOTS) {
    try {
      if (isPathInside(await realpath(root), resolvedPath)) return resolvedPath;
    } catch {
      // A missing optional media directory is not an allowed source.
    }
  }
  return null;
}
