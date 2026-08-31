// @vitest-environment node

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultRepurposeAssetDir,
  resolveRepurposeAssetDir,
} from "@/lib/repurpose/asset-root";

describe("repurpose asset root", () => {
  it("defaults exactly to the existing Downloads overlay directory", () => {
    expect(defaultRepurposeAssetDir("C:\\Users\\editor")).toBe(
      path.join("C:\\Users\\editor", "Downloads", "repurpose-overlays")
    );
    expect(resolveRepurposeAssetDir(undefined, os.homedir())).toBe(
      path.join(os.homedir(), "Downloads", "repurpose-overlays")
    );
  });

  it("resolves an explicit asset root without falling back to a user directory", () => {
    const configured = path.join(os.tmpdir(), "repurpose-assets-configured");
    expect(resolveRepurposeAssetDir(configured, "C:\\Users\\ignored")).toBe(
      path.resolve(configured)
    );
  });
});
