// @vitest-environment node

import { copyFile, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/repurpose/media/route";
import {
  MediaInspectionError,
  createMediaFingerprint,
  inspectMedia,
  parseRationalFrameRate,
} from "@/lib/repurpose/media-inspection.server";

const fixtures = path.resolve("tests", "fixtures", "generated");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempFixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-inspection-"));
  tempRoots.push(root);
  const target = path.join(root, name);
  await copyFile(path.join(fixtures, name), target);
  return target;
}

describe("inspectMedia", () => {
  it("normalizes H.264/AAC stream metadata", async () => {
    const file = await tempFixture("h264-aac.mp4");

    const inspection = await inspectMedia(file);

    expect(inspection).toMatchObject({
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      extension: ".mp4",
      size: (await stat(file)).size,
      video: {
        codec: "h264",
        pixelFormat: "yuv420p",
        width: 320,
        height: 180,
        fps: 30,
      },
      audio: {
        codec: "aac",
        channels: 1,
        sampleRate: 48_000,
      },
    });
    expect(inspection.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(inspection.video.codecTag).toBeTruthy();
    expect(inspection.video.profile).toBeTruthy();
    expect(inspection.durationSec).toBeCloseTo(3, 1);
  });

  it("normalizes HEVC inside a MOV container", async () => {
    const inspection = await inspectMedia(await tempFixture("hevc-aac.mov"));

    expect(inspection.extension).toBe(".mov");
    expect(inspection.video.codec).toBe("hevc");
    expect(inspection.audio?.codec).toBe("aac");
  });

  it("returns null audio for a silent H.264 video", async () => {
    const inspection = await inspectMedia(await tempFixture("h264-silent.mp4"));

    expect(inspection.video.codec).toBe("h264");
    expect(inspection.audio).toBeNull();
  });

  it("returns a typed MEDIA_INVALID error with bounded sanitized stderr", async () => {
    const invalid = await tempFixture("invalid.mov");

    const error = await inspectMedia(invalid).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MediaInspectionError);
    expect(error).toMatchObject({ code: "MEDIA_INVALID" });
    expect((error as MediaInspectionError).stderr.length).toBeLessThanOrEqual(600);
    expect((error as MediaInspectionError).stderr).not.toContain("\r");
    expect((error as MediaInspectionError).stderr).not.toContain(invalid);
    expect((error as Error).message).not.toContain(invalid);
    expect((error as Error).message).not.toContain("ffprobe -v");
  });

  it("maps a missing ffprobe executable to FFPROBE_UNAVAILABLE", async () => {
    const file = await tempFixture("h264-aac.mp4");

    await expect(inspectMedia(file, { ffprobePath: "ffprobe-repurpose-does-not-exist" })).rejects.toMatchObject({
      code: "FFPROBE_UNAVAILABLE",
    });
  });

  it("maps malformed successful ffprobe output to MEDIA_INVALID", async () => {
    const file = await tempFixture("h264-aac.mp4");

    await expect(inspectMedia(file, { ffprobePath: process.execPath })).rejects.toMatchObject({
      code: "MEDIA_INVALID",
    });
  });

  it("rejects media without a video stream or a positive duration", async () => {
    await expect(inspectMedia(path.join(fixtures, "music.wav"))).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    await expect(inspectMedia(path.join(fixtures, "overlay.png"))).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  });

  it("parses rational frame rates without producing non-finite values", () => {
    expect(parseRationalFrameRate("60000/1001")).toBeCloseTo(59.94, 2);
    expect(parseRationalFrameRate("30/1")).toBe(30);
    expect(parseRationalFrameRate("0/0")).toBe(0);
    expect(parseRationalFrameRate("not-a-rate")).toBe(0);
  });

  it("invokes ffprobe with an argument array and the required inspection flags", async () => {
    const file = await tempFixture("h264-aac.mp4");
    const runFfprobe = vi.fn(async () => ({
      stdout: JSON.stringify({
        streams: [{
          codec_type: "video",
          codec_name: "h264",
          codec_tag_string: "avc1",
          profile: "High",
          pix_fmt: "yuv420p",
          width: 320,
          height: 180,
          avg_frame_rate: "60000/1001",
        }],
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "3" },
      }),
    }));

    const inspection = await inspectMedia(file, { runFfprobe });

    expect(runFfprobe).toHaveBeenCalledWith(
      "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    );
    expect(inspection.video.fps).toBeCloseTo(59.94, 2);
  });

  it.each([
    ["a null stream", JSON.stringify({ streams: [null], format: { duration: "3" } })],
    ["zero video dimensions", JSON.stringify({ streams: [{ codec_type: "video", width: 0, height: 180 }], format: { duration: "3" } })],
    ["an invalid duration", JSON.stringify({ streams: [{ codec_type: "video", width: 320, height: 180 }], format: { duration: "NaN" } })],
    ["malformed JSON", "not-json"],
  ])("returns MEDIA_INVALID for %s from ffprobe", async (_label, stdout) => {
    const file = await tempFixture("h264-aac.mp4");

    await expect(inspectMedia(file, { runFfprobe: async () => ({ stdout }) })).rejects.toMatchObject({
      code: "MEDIA_INVALID",
    });
  });

  it("changes the fingerprint with mtime, size, or compatibility settings version", async () => {
    const file = await tempFixture("h264-silent.mp4");
    const initial = await createMediaFingerprint(file, "compat-v1");
    const current = await stat(file);

    await utimes(file, current.atime, new Date(current.mtimeMs + 2_000));
    const afterMtime = await createMediaFingerprint(file, "compat-v1");
    await writeFile(file, Buffer.concat([await import("node:fs/promises").then(({ readFile }) => readFile(file)), Buffer.from([0])]));
    const afterSize = await createMediaFingerprint(file, "compat-v1");
    const afterVersion = await createMediaFingerprint(file, "compat-v2");

    expect(new Set([initial, afterMtime, afterSize, afterVersion])).toHaveLength(4);
  });
});

describe("GET /api/repurpose/media", () => {
  it("rejects paths outside the shared allowed-video policy", async () => {
    const response = await GET(new Request("http://localhost/api/repurpose/media?path=C%3A%5Cprivate%5Cclip.mp4"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "MEDIA_PATH_INVALID", message: "Select a local video file." },
    });
  });

  it("returns normalized inspection for an allowed local video", async () => {
    const file = await tempFixture("h264-aac.mp4");
    const response = await GET(new Request(`http://localhost/api/repurpose/media?path=${encodeURIComponent(file)}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ video: { codec: "h264", width: 320, height: 180 } });
  });

  it("returns a public typed error without leaking the path", async () => {
    const file = await tempFixture("invalid.mov");
    const response = await GET(new Request(`http://localhost/api/repurpose/media?path=${encodeURIComponent(file)}`));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({ error: { code: "MEDIA_INVALID", message: "This file is not a readable video." } });
    expect(JSON.stringify(body)).not.toContain(file);
  });
});
