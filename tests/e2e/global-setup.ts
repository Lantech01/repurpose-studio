import { mkdir } from "node:fs/promises";

import {
  e2eStoragePaths,
  validateOwnedE2eRoot,
  validateReusedE2eStorage,
} from "./helpers/storage-root";

export default async function globalSetup(): Promise<void> {
  const storage = validateReusedE2eStorage(process.env);
  if (process.env.REPURPOSE_E2E_OWNS_ROOT === "1") {
    const root = validateOwnedE2eRoot(storage.root);
    const expected = e2eStoragePaths(root);
    if (
      storage.assetDir !== expected.assetDir ||
      storage.sfxDir !== expected.sfxDir ||
      storage.projectsDir !== expected.projectsDir
    ) {
      throw new Error("Owned Playwright storage paths do not match the validated test root");
    }
  }
  await Promise.all([
    mkdir(storage.assetDir, { recursive: true }),
    mkdir(storage.sfxDir, { recursive: true }),
    mkdir(storage.projectsDir, { recursive: true }),
  ]);
}
