// @vitest-environment node

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultRepurposeProjectsDir,
  resolveRepurposeProjectsDir,
} from "@/lib/repurpose/project-root";

describe("repurpose project root", () => {
  it("preserves the existing default and honors an explicit isolated root", () => {
    expect(defaultRepurposeProjectsDir("C:\\Users\\editor")).toBe(
      path.join("C:\\Users\\editor", "Downloads", "repurpose-projects")
    );
    expect(resolveRepurposeProjectsDir(undefined, os.homedir())).toBe(
      path.join(os.homedir(), "Downloads", "repurpose-projects")
    );
    const configured = path.join(os.tmpdir(), "repurpose-projects-configured");
    expect(resolveRepurposeProjectsDir(configured, "C:\\Users\\ignored")).toBe(
      path.resolve(configured)
    );
  });
});
