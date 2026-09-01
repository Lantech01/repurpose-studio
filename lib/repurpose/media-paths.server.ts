import { realpath, stat } from "node:fs/promises";
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
export const REPURPOSE_ORIGINALS_DIR = path.join(
  REPURPOSE_FOOTAGE_DIR,
  "originals"
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
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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

export async function resolveImportedOriginalVideoPath(
  rawPath: string,
  fileSystem: {
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<{ isFile(): boolean }>;
  } = { realpath, stat }
): Promise<string | null> {
  if (!rawPath || !path.isAbsolute(rawPath)) return null;

  const extension = path.extname(rawPath);
  const normalizedName = `${path.basename(rawPath, extension)}${extension.toLowerCase()}`;
  if (!/^[a-f0-9]{64}\.(mp4|mov|m4v|webm|mkv)$/.test(normalizedName)) {
    return null;
  }
  if (path.resolve(path.dirname(rawPath)) !== path.resolve(REPURPOSE_ORIGINALS_DIR)) {
    return null;
  }

  try {
    const resolvedPath = await fileSystem.realpath(rawPath);
    const originalsRoot = await fileSystem.realpath(REPURPOSE_ORIGINALS_DIR);
    const resolvedExtension = path.extname(resolvedPath);
    const resolvedName = `${path.basename(
      resolvedPath,
      resolvedExtension
    )}${resolvedExtension.toLowerCase()}`;
    if (
      !/^[a-f0-9]{64}\.(mp4|mov|m4v|webm|mkv)$/.test(resolvedName) ||
      path.dirname(resolvedPath) !== originalsRoot
    ) {
      return null;
    }
    const resolvedInfo = await fileSystem.stat(resolvedPath);
    if (!resolvedInfo.isFile()) return null;
    return resolvedPath;
  } catch {
    return null;
  }
}
