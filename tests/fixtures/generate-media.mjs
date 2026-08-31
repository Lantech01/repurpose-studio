import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "generated");
mkdirSync(fixtureDir, { recursive: true });

const commonArgs = ["-y", "-hide_banner", "-loglevel", "error", "-threads", "1"];

function runFfmpeg(args, description, unavailableEncoder) {
  const result = spawnSync("ffmpeg", [...commonArgs, ...args], { stdio: "inherit" });

  if (result.error) {
    throw new Error(
      `Unable to run ffmpeg while generating ${description}. Install ffmpeg and ensure it is on PATH. ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    if (unavailableEncoder) {
      throw new Error(
        `Unable to generate ${description}. This fixture requires ffmpeg with the ${unavailableEncoder} encoder; install a full ffmpeg build that includes it.`,
      );
    }
    throw new Error(`ffmpeg failed while generating ${description} (exit code ${result.status}).`);
  }
}

const testPattern = "testsrc2=size=320x180:rate=30:duration=3";
const videoMetadata = ["-map_metadata", "-1", "-metadata", "creation_time=1970-01-01T00:00:00Z"];

runFfmpeg(
  [
    "-f", "lavfi", "-i", testPattern,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest",
    ...videoMetadata,
    join(fixtureDir, "h264-aac.mp4"),
  ],
  "H.264/AAC fixture",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", testPattern,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v", "libx265", "-preset", "fast", "-crf", "24", "-pix_fmt", "yuv420p",
    "-x265-params", "pools=none:frame-threads=1:log-level=error",
    "-c:a", "aac", "-b:a", "96k", "-shortest",
    ...videoMetadata,
    join(fixtureDir, "hevc-aac.mov"),
  ],
  "HEVC/AAC fixture",
  "libx265",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", testPattern,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-an",
    ...videoMetadata,
    join(fixtureDir, "h264-silent.mp4"),
  ],
  "silent H.264 fixture",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", "color=c=0xE53935:size=320x180:rate=30:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-an",
    ...videoMetadata,
    join(fixtureDir, "split-screen-red.mp4"),
  ],
  "solid red split Screen fixture",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", "color=c=0x2450A4:size=320x180:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest",
    ...videoMetadata,
    join(fixtureDir, "split-face-blue-aac.mp4"),
  ],
  "solid blue split Face/AAC fixture",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2,volume=4",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-shortest",
    ...videoMetadata,
    join(fixtureDir, "overlay.mp4"),
  ],
  "video overlay fixture with isolated 220Hz AAC tone",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", "color=c=0xF26B5B:size=160x90:rate=1:duration=1",
    "-frames:v", "1", "-c:v", "png",
    join(fixtureDir, "overlay.png"),
  ],
  "PNG overlay fixture",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=3",
    "-c:a", "pcm_s16le", "-map_metadata", "-1",
    join(fixtureDir, "music.wav"),
  ],
  "music fixture",
);

runFfmpeg(
  [
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=0.5",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=1100:sample_rate=48000:duration=0.5",
    "-filter_complex",
    "[0:a]volume=0.1[a0];[1:a]volume=0.1[a1];[2:a]volume=0.1[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]",
    "-map", "[out]", "-ac", "2", "-c:a", "pcm_s16le", "-map_metadata", "-1",
    join(fixtureDir, "editable-sfx.wav"),
  ],
  "segmented editable SFX fixture",
);

writeFileSync(join(fixtureDir, "invalid.mov"), Buffer.from("repurpose-studio-invalid-media\n", "utf8"));
writeFileSync(
  join(fixtureDir, "raw.srt"),
  [
    "1",
    "00:00:00,000 --> 00:00:00,700",
    "click",
    "",
    "2",
    "00:00:00,700 --> 00:00:01,400",
    "code",
    "",
    "3",
    "00:00:01,400 --> 00:00:02,200",
    "screenshot",
    "",
    "4",
    "00:00:02,200 --> 00:00:03,000",
    "result",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Generated deterministic media fixtures in ${fixtureDir}`);
