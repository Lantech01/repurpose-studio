import { rm } from "node:fs/promises";

import { validateOwnedE2eRoot } from "./helpers/storage-root";

export default async function globalTeardown(): Promise<void> {
  if (process.env.REPURPOSE_E2E_OWNS_ROOT !== "1") return;
  const root = process.env.REPURPOSE_E2E_ROOT;
  if (!root) throw new Error("REPURPOSE_E2E_ROOT is required for owned Playwright cleanup");
  await rm(validateOwnedE2eRoot(root), { recursive: true, force: true });
}
