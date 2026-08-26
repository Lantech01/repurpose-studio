// @vitest-environment node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const engineDir = path.join(process.cwd(), "scripts", "sfx-engine");
const scriptPath = path.join(engineDir, "build_sfx_track.py");
const tempRoots: string[] = [];

const effectKeys = [
  "mouse_click",
  "double_click",
  "keyboard",
  "whoosh",
  "air_hit",
  "ding",
  "notification",
  "camera_shutter",
  "digital_shutter",
  "riser",
  "impact",
  "digital_readout",
] as const;

interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  durationMs: number;
  samples: Int16Array;
}

function peak(samples: Int16Array): number {
  let result = 0;
  for (const sample of samples) result = Math.max(result, Math.abs(sample));
  return result;
}

function inspectWav(buffer: Buffer): WavInfo {
  expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) break;
    if (id === "fmt ") {
      expect(buffer.readUInt16LE(start)).toBe(1);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }

  expect(data.byteLength).toBeGreaterThan(0);
  const samples = new Int16Array(data.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2);
  }
  const frameCount = data.byteLength / (channels * (bitsPerSample / 8));
  return {
    channels,
    sampleRate,
    bitsPerSample,
    durationMs: (frameCount / sampleRate) * 1000,
    samples,
  };
}

async function runEngine(
  eventsJson: string,
  durationMs: number,
  outputName = "output.wav"
): Promise<{ outputPath: string; run: () => Promise<unknown> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-sfx-engine-"));
  tempRoots.push(root);
  const eventsPath = path.join(root, "events.json");
  const outputPath = path.join(root, outputName);
  await writeFile(eventsPath, eventsJson, "utf8");
  return {
    outputPath,
    run: () => execFileAsync(
      "uv",
      [
        "run",
        "--frozen",
        "python",
        scriptPath,
        "--events-json",
        eventsPath,
        "--output",
        outputPath,
        "--duration-ms",
        String(durationMs),
      ],
      { cwd: engineDir, timeout: 30_000 }
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("offline SFX engine", () => {
  it("renders the requested duration as 48 kHz stereo PCM WAV", async () => {
    const invocation = await runEngine(
      JSON.stringify([{ sfx: "mouse_click", at_ms: 100 }]),
      1250
    );

    await invocation.run();

    const info = inspectWav(await readFile(invocation.outputPath));
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(48_000);
    expect(info.bitsPerSample).toBe(16);
    expect(Math.abs(info.durationMs - 1250)).toBeLessThanOrEqual(50);
  });

  it("resolves every approved effect key", async () => {
    const events = effectKeys.map((sfx, index) => ({ sfx, at_ms: index * 100 }));
    const invocation = await runEngine(JSON.stringify(events), 2500);

    await invocation.run();

    const info = inspectWav(await readFile(invocation.outputPath));
    expect(peak(info.samples)).toBeGreaterThan(0);
  });

  it("normalizes clicks to 50%, whoosh to 30%, and other effects to 20% amplitude", async () => {
    const names = ["mouse_click", "double_click", "whoosh", "ding"] as const;
    const invocations = await Promise.all(names.map((name) => runEngine(
      JSON.stringify([{ sfx: name, at_ms: 0 }]),
      1000,
      `${name}.wav`
    )));

    await Promise.all(invocations.map((invocation) => invocation.run()));

    const amplitudes = await Promise.all(invocations.map(async (invocation) => (
      peak(inspectWav(await readFile(invocation.outputPath)).samples) / 32767
    )));
    expect(amplitudes[0]).toBeCloseTo(0.5, 2);
    expect(amplitudes[1]).toBeCloseTo(0.5, 2);
    expect(amplitudes[2]).toBeCloseTo(0.3, 2);
    expect(amplitudes[3]).toBeCloseTo(0.2, 2);
  });

  it.each([
    ["an unknown effect", JSON.stringify([{ sfx: "shell_command", at_ms: 0 }]), 1000],
    ["a negative event time", JSON.stringify([{ sfx: "ding", at_ms: -1 }]), 1000],
    ["an event at the end of the track", JSON.stringify([{ sfx: "ding", at_ms: 1000 }]), 1000],
    ["malformed JSON", "{", 1000],
    ["an empty event list", "[]", 1000],
    ["a non-list root", JSON.stringify({ sfx: "ding", at_ms: 0 }), 1000],
    ["a non-object event", JSON.stringify(["ding"]), 1000],
    ["a non-numeric event time", JSON.stringify([{ sfx: "ding", at_ms: "0" }]), 1000],
    ["a non-finite event time", '[{"sfx":"ding","at_ms":1e309}]', 1000],
  ])("rejects %s without publishing output", async (_name, eventsJson, durationMs) => {
    const invocation = await runEngine(eventsJson, durationMs);

    await expect(invocation.run()).rejects.toMatchObject({
      stderr: expect.stringMatching(/invalid events JSON|events.*must|unknown effect|at_ms/i),
    });
    await expect(stat(invocation.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mixes overlapping events instead of replacing the earlier event", async () => {
    const single = await runEngine(
      JSON.stringify([{ sfx: "mouse_click", at_ms: 100 }]),
      700,
      "single.wav"
    );
    const overlapping = await runEngine(
      JSON.stringify([
        { sfx: "mouse_click", at_ms: 100 },
        { sfx: "mouse_click", at_ms: 100 },
      ]),
      700,
      "overlapping.wav"
    );

    await Promise.all([single.run(), overlapping.run()]);

    const singlePeak = peak(inspectWav(await readFile(single.outputPath)).samples);
    const overlappingPeak = peak(inspectWav(await readFile(overlapping.outputPath)).samples);
    expect(overlappingPeak).toBeGreaterThan(singlePeak * 1.7);
  });

  it("requires all CLI arguments and a positive integer duration", async () => {
    await expect(execFileAsync(
      "uv",
      ["run", "--frozen", "python", scriptPath, "--duration-ms", "1.5"],
      { cwd: engineDir, timeout: 30_000 }
    )).rejects.toMatchObject({ stderr: expect.stringMatching(/required|invalid|positive integer/i) });
  });
});
