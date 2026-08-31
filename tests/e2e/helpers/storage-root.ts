import os from "node:os";
import path from "node:path";

export const E2E_ROOT_PREFIX = "repurpose-studio-e2e-";

export interface E2eStoragePaths {
  root: string;
  assetDir: string;
  sfxDir: string;
  projectsDir: string;
}

export interface E2eStorageEnvironment extends E2eStoragePaths {
  ownsRoot: boolean;
}

function isStrictlyUnder(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function e2eStoragePaths(root: string): E2eStoragePaths {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    assetDir: path.join(resolvedRoot, "assets"),
    sfxDir: path.join(resolvedRoot, "sfx-cache"),
    projectsDir: path.join(resolvedRoot, "projects"),
  };
}

export function validateOwnedE2eRoot(root: string): string {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  const name = path.basename(resolved);
  if (
    path.dirname(resolved) !== tempRoot ||
    !new RegExp(`^${E2E_ROOT_PREFIX}[A-Za-z0-9_-]{6,}$`).test(name)
  ) {
    throw new Error(`Refusing to clean unsafe Playwright root: ${resolved}`);
  }
  return resolved;
}

export function validateReusedE2eStorage(
  environment: Record<string, string | undefined>
): E2eStorageEnvironment {
  const required = [
    "REPURPOSE_E2E_ROOT",
    "REPURPOSE_ASSET_DIR",
    "REPURPOSE_SFX_CACHE_DIR",
    "REPURPOSE_PROJECTS_DIR",
  ] as const;
  for (const name of required) {
    if (!environment[name]) {
      throw new Error(`${name} is required when REPURPOSE_E2E_REUSE_SERVER=1`);
    }
  }
  const root = path.resolve(environment.REPURPOSE_E2E_ROOT!);
  const assetDir = path.resolve(environment.REPURPOSE_ASSET_DIR!);
  const sfxDir = path.resolve(environment.REPURPOSE_SFX_CACHE_DIR!);
  const projectsDir = path.resolve(environment.REPURPOSE_PROJECTS_DIR!);
  if (
    !isStrictlyUnder(root, assetDir) ||
    !isStrictlyUnder(root, sfxDir) ||
    !isStrictlyUnder(root, projectsDir) ||
    new Set([assetDir, sfxDir, projectsDir]).size !== 3
  ) {
    throw new Error("Reused-server asset, SFX, and project roots must be distinct and contained by REPURPOSE_E2E_ROOT");
  }
  return { root, assetDir, sfxDir, projectsDir, ownsRoot: false };
}
