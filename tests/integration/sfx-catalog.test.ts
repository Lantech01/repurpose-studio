// @vitest-environment node

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  APPROVED_SFX_KEYS,
  SFX_CATALOG,
  defaultBuiltInDuration,
  getSfxCatalogEntry,
  isApprovedSfxKey,
} from "@/lib/repurpose/sfx-effects";

const execFileAsync = promisify(execFile);
const engineDir = path.join(process.cwd(), "scripts", "sfx-engine");
const catalogPath = path.join(engineDir, "sfx-catalog.json");

const expectedCatalog = {
  mouse_click: { displayName: "Mouse Click", category: "Interaction", filename: "Mouse Click.wav", sourceDuration: 0.9288125, targetAmplitude: 0.5 },
  double_click: { displayName: "Double Click", category: "Interaction", filename: "mixkit-fast-double-click-on-mouse-275.wav", sourceDuration: 0.464988662, targetAmplitude: 0.5 },
  keyboard: { displayName: "Keyboard", category: "Interaction", filename: "Keyboard-Button-Click-06-c-FesliyanStudios.com_.wav", sourceDuration: 1.296, targetAmplitude: 0.2 },
  whoosh: { displayName: "Whoosh", category: "Transition", filename: "Whoosh 1.wav", sourceDuration: 2.188479167, targetAmplitude: 0.3 },
  air_hit: { displayName: "Air Hit", category: "Transition", filename: "mixkit-air-in-a-hit-2161.wav", sourceDuration: 1.276258503, targetAmplitude: 0.2 },
  ding: { displayName: "Correct Ding", category: "UI", filename: "Correct Ding.wav", sourceDuration: 2.951854167, targetAmplitude: 0.2 },
  notification: { displayName: "Notification", category: "UI", filename: "mixkit-bike-notification-bell-590.wav", sourceDuration: 0.974988662, targetAmplitude: 0.2 },
  camera_shutter: { displayName: "Camera Shutter", category: "Camera", filename: "Camera Shutter 5.wav", sourceDuration: 0.375, targetAmplitude: 0.2 },
  digital_shutter: { displayName: "Digital Shutter", category: "Camera", filename: "mixkit-camera-digital-shutter-1432.wav", sourceDuration: 1.511678005, targetAmplitude: 0.2 },
  riser: { displayName: "Riser", category: "Transition", filename: "Riser 3.wav", sourceDuration: 0.886375, targetAmplitude: 0.2 },
  impact: { displayName: "Impact", category: "Transition", filename: "Impact 7.wav", sourceDuration: 3.923145833, targetAmplitude: 0.2 },
  digital_readout: { displayName: "Digital Readout", category: "Signature", filename: "textdigitalreadout.wav", sourceDuration: 0.983604167, targetAmplitude: 0.2 },
} as const;

function wavDuration(buffer: Buffer): number {
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") byteRate = buffer.readUInt32LE(start + 8);
    if (id === "data") dataSize = size;
    offset = start + size + (size % 2);
  }
  return dataSize / byteRate;
}

describe("shared SFX catalog", () => {
  it("is the exact versioned metadata authority in JSON and TypeScript", async () => {
    const json = JSON.parse(await readFile(catalogPath, "utf8"));

    expect(json).toEqual(expectedCatalog);
    expect(SFX_CATALOG).toEqual(expectedCatalog);
    expect(APPROVED_SFX_KEYS).toEqual(Object.keys(expectedCatalog));
  });

  it("provides guarded lookup and first-second built-in duration", () => {
    expect(isApprovedSfxKey("whoosh")).toBe(true);
    expect(isApprovedSfxKey("shell_command")).toBe(false);
    expect(getSfxCatalogEntry("whoosh")).toMatchObject({
      category: "Transition",
      sourceDuration: 2.188479167,
      targetAmplitude: 0.3,
    });
    expect(getSfxCatalogEntry("shell_command")).toBeNull();
    expect(defaultBuiltInDuration("whoosh")).toBe(1);
    expect(defaultBuiltInDuration("mouse_click")).toBe(0.9288125);
  });

  it("is loaded unchanged by the Python renderer", async () => {
    const probe = [
      "import json, runpy",
      `module = runpy.run_path(${JSON.stringify(path.join(engineDir, "build_sfx_track.py"))})`,
      "print(json.dumps(module['SFX_CATALOG']))",
    ].join("; ");
    const { stdout } = await execFileAsync(
      "uv",
      ["run", "--frozen", "python", "-c", probe],
      { cwd: engineDir, timeout: 30_000 }
    );

    expect(JSON.parse(stdout)).toEqual(expectedCatalog);
  });

  it("matches every vendored WAV filename and measured duration", async () => {
    const sfxDir = path.join(engineDir, "sfx");
    expect((await readdir(sfxDir)).sort()).toEqual(
      Object.values(expectedCatalog).map((entry) => entry.filename).sort()
    );

    await Promise.all(Object.values(expectedCatalog).map(async (entry) => {
      const duration = wavDuration(await readFile(path.join(sfxDir, entry.filename)));
      expect(duration).toBeCloseTo(entry.sourceDuration, 6);
    }));
  });
});
