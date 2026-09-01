// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  cache: {
    get: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
  },
  resolvePath: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("@/lib/repurpose/compatibility-cache.server", () => ({ compatibilityCache: dependencies.cache }));
vi.mock("@/lib/repurpose/media-paths.server", () => ({ resolveAllowedVideoPath: dependencies.resolvePath }));
vi.mock("@/lib/repurpose/media-inspection.server", () => ({
  MediaInspectionError: class MediaInspectionError extends Error {},
  inspectMedia: dependencies.inspect,
}));

import { DELETE, GET, POST } from "@/app/api/repurpose/compatibility/route";
import type { CompatibilityState, MediaInspection } from "@/lib/repurpose/media-types";

const fingerprint = "a".repeat(64);

function inspection(): MediaInspection {
  return {
    fingerprint,
    container: "mov",
    extension: ".mov",
    size: 1,
    durationSec: 3,
    video: { codec: "hevc", codecTag: "hvc1", profile: "Main", pixelFormat: "yuv420p", width: 320, height: 180, fps: 30 },
    audio: { codec: "aac", channels: 1, sampleRate: 48_000 },
  };
}

function state(status: CompatibilityState["status"]): CompatibilityState {
  return { status, progress: status === "building" ? 0.5 : null };
}

function harness() {
  dependencies.cache.get.mockReset().mockReturnValue(state("none"));
  dependencies.cache.start.mockReset().mockResolvedValue(state("building"));
  dependencies.cache.cancel.mockReset().mockResolvedValue(state("cancelled"));
  dependencies.resolvePath.mockReset().mockImplementation(async (value: string) => value === "C:/allowed/source.mov" ? value : null);
  dependencies.inspect.mockReset().mockResolvedValue(inspection());
  return {
    cache: dependencies.cache,
    resolvePath: dependencies.resolvePath,
    inspect: dependencies.inspect,
    handlers: { DELETE, GET, POST },
  };
}

describe("compatibility route", () => {
  it("GET returns state only and validates the fingerprint", async () => {
    const { handlers, cache } = harness();
    cache.get.mockReturnValue({ status: "ready", progress: null, workingPath: "C:/cache/master.mp4" });

    const response = await handlers.GET(new Request(`http://localhost/api/repurpose/compatibility?fingerprint=${fingerprint}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", progress: null, workingPath: "C:/cache/master.mp4" });
    expect(cache.get).toHaveBeenCalledWith(fingerprint);
    const invalid = await handlers.GET(new Request("http://localhost/api/repurpose/compatibility?fingerprint=../private"));
    expect(invalid.status).toBe(400);
  });

  it("POST resolves and inspects the authoritative path before starting or reusing", async () => {
    const { handlers, cache, resolvePath, inspect } = harness();
    const response = await handlers.POST(new Request("http://localhost/api/repurpose/compatibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "C:/allowed/source.mov", fingerprint }),
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(state("building"));
    expect(resolvePath).toHaveBeenCalledWith("C:/allowed/source.mov");
    expect(inspect).toHaveBeenCalledWith("C:/allowed/source.mov", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(cache.start).toHaveBeenCalledWith({ originalPath: "C:/allowed/source.mov", inspection: inspection() });
  });

  it("POST rejects malformed JSON, invalid paths, and stale fingerprints", async () => {
    const { handlers } = harness();
    const malformed = await handlers.POST(new Request("http://localhost/api/repurpose/compatibility", { method: "POST", body: "{" }));
    const invalidPath = await handlers.POST(new Request("http://localhost/api/repurpose/compatibility", {
      method: "POST", body: JSON.stringify({ path: "C:/private/secret.mov" }),
    }));
    const stale = await handlers.POST(new Request("http://localhost/api/repurpose/compatibility", {
      method: "POST", body: JSON.stringify({ path: "C:/allowed/source.mov", fingerprint: "b".repeat(64) }),
    }));

    expect(malformed.status).toBe(400);
    expect(invalidPath.status).toBe(400);
    expect(stale.status).toBe(409);
  });

  it("DELETE globally cancels the shared fingerprint job", async () => {
    const { handlers, cache } = harness();
    const response = await handlers.DELETE(new Request("http://localhost/api/repurpose/compatibility", {
      method: "DELETE", body: JSON.stringify({ fingerprint }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state("cancelled"));
    expect(cache.cancel).toHaveBeenCalledWith(fingerprint);
  });

  it("sanitizes inspection and conversion failures without leaking paths or commands", async () => {
    const { handlers, inspect, cache } = harness();
    inspect.mockRejectedValueOnce(Object.assign(new Error("ffprobe C:/allowed/source.mov --secret"), { code: "FFPROBE_UNAVAILABLE" }));
    const unavailable = await handlers.POST(new Request("http://localhost/api/repurpose/compatibility", {
      method: "POST", body: JSON.stringify({ path: "C:/allowed/source.mov" }),
    }));
    cache.start.mockRejectedValueOnce(new Error("ffmpeg C:/cache/private.partial.mp4 --all-args"));
    const failed = await handlers.POST(new Request("http://localhost/api/repurpose/compatibility", {
      method: "POST", body: JSON.stringify({ path: "C:/allowed/source.mov" }),
    }));

    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("C:/");
    expect(failed.status).toBe(500);
    const body = await failed.text();
    expect(body).not.toContain("C:/");
    expect(body).not.toContain("--all-args");
  });
});
