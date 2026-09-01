import os from "node:os";
import path from "node:path";

export function defaultRepurposeProjectsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, "Downloads", "repurpose-projects");
}

export function resolveRepurposeProjectsDir(
  configured = process.env.REPURPOSE_PROJECTS_DIR,
  homeDir = os.homedir()
): string {
  return configured && configured.trim().length > 0
    ? path.resolve(configured)
    : defaultRepurposeProjectsDir(homeDir);
}
