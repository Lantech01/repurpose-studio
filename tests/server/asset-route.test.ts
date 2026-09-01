// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const roots: string[] = [];
const originalAssetDir = process.env.REPURPOSE_ASSET_DIR;

afterEach(async () => {
  vi.resetModules();
  if (originalAssetDir === undefined) delete process.env.REPURPOSE_ASSET_DIR;
  else process.env.REPURPOSE_ASSET_DIR = originalAssetDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("asset route storage root", () => {
  it("persists and serves uploads only from the configured asset directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-asset-route-"));
    roots.push(root);
    const assetDir = path.join(root, "isolated-assets");
    process.env.REPURPOSE_ASSET_DIR = assetDir;
    vi.resetModules();
    const route = await import("@/app/api/repurpose/asset/route");
    const form = new FormData();
    form.set("name", "isolated-audio");
    form.set("file", new File([Buffer.from("RIFF-test")], "sound.wav", { type: "audio/wav" }));

    const response = await route.POST(new Request("http://localhost/api/repurpose/asset", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string };
    const relative = path.relative(path.resolve(assetDir), path.resolve(body.path));
    expect(relative).not.toBe("");
    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);

    const served = await route.GET(new Request(
      `http://localhost/api/repurpose/asset?path=${encodeURIComponent(body.path)}`
    ));
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from("RIFF-test"));
  });
});
