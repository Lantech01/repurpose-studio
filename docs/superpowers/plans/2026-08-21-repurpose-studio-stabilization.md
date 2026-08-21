# Repurpose Studio Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Make the existing local Repurpose Studio reliably import H.264 and HEVC footage, play and seek through one transport clock, persist projects, render offline SFX, and export a browser-playable MP4 on this Windows machine.

**Architecture:** Keep the current Next.js, Zustand, compositor, and browser export pipeline. Add a narrow local-media boundary that streams selected files to an immutable originals directory, inspects them with ffprobe, creates a fingerprinted H.264 compatibility master only when Chrome cannot decode the original, and builds a separate 540px editing proxy. Keep the legacy `faceCamPath`/`screenPath` fields as browser URLs so existing preview/export consumers stay stable, while nested source records preserve `originalPath`, `workingPath`, and `previewPath`. Replace the face-video-owned playhead with a pure monotonic transport clock and make every media element follow that one clock.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict mode, Zustand 5, ffmpeg/ffprobe, Python 3.12 + uv + pydub, Vitest + Testing Library, Playwright with installed Google Chrome.

---

## Fixed behavioral contracts

These constants and policies are decisions, not open implementation questions:

- Base screen/face drift tolerance: `0.150` seconds.
- Overlay-video drift tolerance: `0.250` seconds.
- External-seek detection tolerance: `0.250` seconds.
- End and clip-boundary comparisons: one source frame, derived from fps, with `1 / 30` only as invalid-fps fallback.
- Compatibility cache: 30-day TTL, 20 GiB cap, oldest-first eviction after TTL eviction.
- Preview cache: 30-day TTL, 10 GiB cap, 540-pixel short side, approximately 0.5-second keyframe spacing.
- One compatibility job exists per source fingerprint. Because this is a single-user local app, cancelling from any observing import cancels that shared job for all observers, kills ffmpeg, removes the partial file, and records `cancelled`. A later POST starts a fresh job.
- A source fingerprint includes resolved original path, file size, mtime, and a versioned compatibility settings string.
- Export always reads the full-quality `workingPath`. It never reads `previewPath`.
- A compatibility result is published only after ffmpeg succeeds and ffprobe confirms H.264, yuv420p, expected geometry/frame rate, sane duration, and AAC when the input carried audio.
- H.264 that passes the real Chrome metadata probe is copied and inspected but not transcoded.
- No leadgenman workflow, Whisper model, OpenAI client, API key, or network service enters the web app in this phase.

## Task 1: Bootstrap deterministic test and QA infrastructure

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `playwright.config.ts`
- Create: `tests/fixtures/generate-media.mjs`
- Create: `tests/unit/time-map.smoke.test.ts`
- Create: `TESTING.md`
- Create: `AGENTS.md`
- Create: `.github/workflows/test.yml`

### Step 1: Install the test dependencies

Run:

```powershell
npm install --save-dev vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test
```

Expected: `package.json` and `package-lock.json` change; no browser download is required because Playwright will use the installed Chrome channel.

Add these scripts:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "fixtures:media": "node tests/fixtures/generate-media.mjs",
    "verify": "npm run typecheck && npm test && npm run test:e2e && npm run build"
  }
}
```

### Step 2: Configure Vitest and the browser test environment

Use this complete Vitest configuration:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
```

`tests/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Every `tests/server/*.test.ts` and Node-only integration test must start with `// @vitest-environment node`. Component/browser-unit tests use the configured jsdom environment.

Use Playwright's installed Chrome and a dedicated worktree port:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: ".gstack/qa-reports/playwright-html", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3001",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3001",
    url: "http://127.0.0.1:3001/repurpose-studio",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"] } }],
});
```

### Step 3: Generate tiny deterministic media fixtures

`tests/fixtures/generate-media.mjs` must call `spawnSync("ffmpeg", args, { stdio: "inherit" })` without a shell and create:

- `tests/fixtures/generated/h264-aac.mp4`: 320x180, 30 fps, 3 seconds, test pattern + 440 Hz AAC.
- `tests/fixtures/generated/hevc-aac.mov`: 320x180, 30 fps, 3 seconds, `libx265` + AAC.
- `tests/fixtures/generated/h264-silent.mp4`: 320x180, 30 fps, 3 seconds, no audio.
- `tests/fixtures/generated/overlay.mp4`: 160x90, 30 fps, 2 seconds.
- `tests/fixtures/generated/overlay.png`: deterministic 160x90 still image.
- `tests/fixtures/generated/music.wav`: 3 seconds, 220 Hz.
- `tests/fixtures/generated/invalid.mov`: deterministic non-media bytes.
- `tests/fixtures/generated/raw.srt`: timed words spanning 3 seconds and containing deterministic SFX triggers such as click, code, screenshot, and result.

Every ffmpeg command must include `-y`, `-hide_banner`, `-loglevel error`, and `-threads 1`. If `libx265` is unavailable, fail with an actionable message instead of silently substituting a compatible codec.

Run:

```powershell
npm run fixtures:media
ffprobe -v error -show_entries stream=codec_name,pix_fmt,width,height -of json tests/fixtures/generated/hevc-aac.mov
```

Expected: the HEVC fixture reports `codec_name: hevc` and the H.264 fixture reports `codec_name: h264`.

Add these generated/runtime paths to `.gitignore` so `git add tests` never commits test media or browser artifacts:

```gitignore
tests/fixtures/generated/
test-results/
.gstack/qa-reports/playwright-html/
```

### Step 4: Prove the harness against an existing pure function

Create `tests/unit/time-map.smoke.test.ts` with a minimal kept clip and assert `timelineToSourceTime` maps output `0.5` to its expected source time.

Run:

```powershell
npm test -- tests/unit/time-map.smoke.test.ts
```

Expected: PASS.

### Step 5: Document local and CI verification

`TESTING.md` must list prerequisites (`Node 20+`, `ffmpeg`, `ffprobe`, `Python 3.10+`, `uv`, installed Chrome), fixture generation, unit/integration commands, E2E port 3001, and exhaustive QA report location.

`AGENTS.md` must tell future agents to run `npm run fixtures:media` once, use port 3001 for this worktree, never use preview proxies for export, and run `npm run verify` before completion.

The GitHub workflow uses `ubuntu-latest`, installs ffmpeg through apt, verifies `ffmpeg -encoders` contains `libx265`, then runs fixture generation, typecheck, unit tests, and production build. It may omit Playwright because this phase's authoritative browser target is the installed Windows Chrome. Task 9 extends the same workflow with Python/uv setup when SFX integration tests arrive.

### Step 6: Commit

```powershell
git add package.json package-lock.json .gitignore vitest.config.ts playwright.config.ts tests TESTING.md AGENTS.md .github/workflows/test.yml
git commit -m "test: bootstrap studio verification harness"
```

## Task 2: Replace playback timing with one tested transport clock

**Files:**

- Create: `lib/repurpose/transport-clock.ts`
- Create: `lib/repurpose/media-sync.ts`
- Create: `tests/unit/transport-clock.test.ts`
- Create: `tests/unit/media-sync.test.ts`
- Create: `tests/components/TransportBar.test.tsx`
- Create: `tests/components/PreviewCanvas.transport.test.tsx`
- Modify: `lib/repurpose/store.ts`
- Modify: `app/repurpose-studio/_components/PreviewCanvas.tsx`
- Modify: `app/repurpose-studio/_components/TransportBar.tsx`

### Step 1: Write failing transport-clock tests

The public contract:

```ts
export const BASE_MEDIA_DRIFT_TOLERANCE_SEC = 0.15;
export const OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC = 0.25;
export const EXTERNAL_SEEK_TOLERANCE_SEC = 0.25;

export interface TransportAnchor {
  outputSec: number;
  monotonicMs: number;
  rate: number;
  generation: number;
}

export function startTransport(outputSec: number, monotonicMs: number, rate: number, generation: number): TransportAnchor;
export function sampleTransport(anchor: TransportAnchor, monotonicMs: number, regionStart: number, regionEnd: number): number;
export function reanchorTransport(anchor: TransportAnchor, outputSec: number, monotonicMs: number, rate?: number): TransportAnchor;
export function shouldCorrectDrift(actualSourceSec: number, targetSourceSec: number, toleranceSec: number): boolean;
```

Tests must prove:

- 1000 ms advances exactly 1 second at 1x.
- 1000 ms advances 2 seconds at 2x.
- sampling clamps at the region end.
- pause is represented by not sampling and therefore freezes time.
- re-anchoring after seek increments generation and never applies an old anchor.
- `0.149` seconds of drift is tolerated; `0.151` is corrected.
- repeated `startTransport` calls do not themselves schedule animation frames.
- base-media synchronization corrects a fake media element at 151 ms drift but not 149 ms.
- overlay synchronization corrects at 251 ms but not 249 ms.
- an external seek writes the mapped source time to both active base elements and re-anchors the clock.
- a discontinuous cut promotes the prepared slot, starts it at the incoming `srcStart`, and leaves screen/face within 150 ms.

Run:

```powershell
npm test -- tests/unit/transport-clock.test.ts
```

Expected: FAIL because the module does not exist.

### Step 2: Implement the pure clock

Implement the exact interface above with no React, DOM, Date, or store imports. `sampleTransport` must use only the injected monotonic timestamp and clamp the result.

`media-sync.ts` owns the side-effectful but DOM-small boundary:

```ts
export function synchronizeMediaTime(
  media: Pick<HTMLMediaElement, "currentTime">,
  targetSourceSec: number,
  toleranceSec: number,
): { corrected: boolean; driftSec: number };
```

Use this function for base and overlay corrections so thresholds cannot drift between branches.

Run the unit test again.

Expected: PASS.

### Step 3: Add transient readiness and error state to the store

Add:

```ts
export type MediaReadiness = "idle" | "loading" | "ready" | "error";

mediaReadiness: MediaReadiness;
playbackBlockedReason: string | null;
setMediaReadiness: (state: MediaReadiness, reason?: string | null) => void;
```

Rules:

- `setFootageMeta` sets `loading` when both paths exist and `idle` when they do not.
- the preview reports `ready` only after both required base videos have decoded dimensions.
- media `error` sets a short user-facing reason and pauses.
- `play()` is idempotent and refuses duration zero, missing clips, missing footage paths, `loading`, or `error`.
- `pause()` remains idempotent and resets rate to 1x.
- readiness/error are transient and not added to `ProjectSnapshot`.

Write `TransportBar.test.tsx` first. Reset Zustand state before every test and assert the button remains Play plus an accessible reason when media is loading/error.

Run:

```powershell
npm test -- tests/components/TransportBar.test.tsx
```

Expected: FAIL before the component/store changes, then PASS.

### Step 4: Make PreviewCanvas use the monotonic clock

In `PreviewCanvas.tsx`:

- Keep exactly one rAF owner and exactly one scheduled next frame.
- Remove face-video `currentTime` as the playhead authority.
- Store one `TransportAnchor` ref when playback starts or rate changes.
- On every playing tick, calculate output time with `sampleTransport` and write it once.
- Map output time to source time with existing `timelineToSourceTime`.
- Preserve the standby ring and discontinuous-cut swap, but re-anchor after every seek/cut/wrap.
- Correct base media only when drift exceeds 150 ms.
- Correct overlay media only when drift exceeds 250 ms.
- Keep the existing 250 ms external-seek detection, but re-anchor before the next sample so a timeline click is not overwritten.
- Await both active base `play()` promises with `Promise.allSettled`. If a required element rejects, call `pause()` and `setMediaReadiness("error", "Chrome could not start this video. Re-import it to create a compatible copy.")`. Do not swallow the rejection.
- Cancel the sole pending rAF on unmount.

Add a development/test-only injected rAF scheduler or extract a `runTransportFrame` helper so a test can assert five repeated Play clicks still produce one active callback.

`PreviewCanvas.transport.test.tsx` must mount the canvas with mocked `HTMLMediaElement.play/pause/currentTime/readyState` and a controlled rAF queue. Seed two kept clips with a discontinuous source gap plus one active video overlay. Assert real element `currentTime` values after Play, external seek, and the clip-boundary swap—not just store playhead values. Add stable `data-source-role`, `data-slot-index`, and `data-overlay-id` attributes to hidden testable media elements; they are diagnostics only and do not alter rendering.

Run:

```powershell
npm test -- tests/unit/transport-clock.test.ts tests/unit/media-sync.test.ts tests/components/TransportBar.test.tsx tests/components/PreviewCanvas.transport.test.tsx
npm run typecheck
```

Expected: PASS.

### Step 5: Commit

```powershell
git add lib/repurpose/transport-clock.ts lib/repurpose/media-sync.ts lib/repurpose/store.ts app/repurpose-studio/_components/PreviewCanvas.tsx app/repurpose-studio/_components/TransportBar.tsx tests
git commit -m "fix: make playback follow one transport clock"
```

## Task 3: Stream selected videos into immutable local originals

**Files:**

- Create: `lib/repurpose/media-types.ts`
- Create: `lib/repurpose/media-paths.server.ts`
- Create: `lib/repurpose/media-upload.server.ts`
- Create: `app/api/repurpose/footage/route.ts`
- Create: `tests/server/media-paths.test.ts`
- Create: `tests/server/footage-route.test.ts`
- Modify: `app/api/repurpose/video/route.ts`
- Modify: `app/api/repurpose/proxy/route.ts`

### Step 1: Write failing path-policy and upload tests

Shared types:

```ts
export type VideoRole = "face" | "screen" | "overlay" | "library";

export interface UploadedVideo {
  originalPath: string;
  contentHash: string;
  size: number;
  name: string;
}
```

Tests must assert:

- real paths below Downloads/Desktop/Documents/Movies/temp are accepted for video reads.
- symlink/traversal escape is rejected.
- only `.mp4`, `.mov`, `.m4v`, `.webm`, and `.mkv` are accepted.
- a streamed 5 MiB request reaches disk without calling `Request.formData()` or `File.arrayBuffer()`.
- abort/error removes `.partial`.
- two byte-identical uploads reuse one content-addressed original.
- the original is stored below `~/Downloads/repurpose-footage/originals` and never overwritten.

Run:

```powershell
npm test -- tests/server/media-paths.test.ts tests/server/footage-route.test.ts
```

Expected: FAIL because the modules and route do not exist.

### Step 2: Extract the shared server-only path policy

`media-paths.server.ts` must export:

```ts
export const VIDEO_EXTENSIONS: ReadonlySet<string>;
export const REPURPOSE_FOOTAGE_DIR: string;
export async function resolveAllowedVideoPath(rawPath: string): Promise<string | null>;
export function isPathInside(root: string, target: string): boolean;
```

Move `resolveAllowed` out of the video route, update the video/proxy routes to import it, and remove the illegal route-to-route import. Preserve realpath and extension validation.

### Step 3: Implement content-addressed streaming upload

`POST /api/repurpose/footage?name=<encoded>&role=<role>` must:

1. validate the decoded basename and extension;
2. require a request body;
3. stream `Readable.fromWeb(request.body)` through a SHA-256 transform into a unique partial under the originals directory;
4. on completion, rename to `<sha256>.<ext>` if absent, otherwise remove the duplicate partial; keep the sanitized original name only in response metadata so byte-identical uploads truly reuse one file;
5. return `UploadedVideo`;
6. remove only its exact validated partial on abort/failure.

Do not put selected-video bytes through FormData or a Buffer.

Run the server tests again.

Expected: PASS.

### Step 4: Commit

```powershell
git add lib/repurpose/media-types.ts lib/repurpose/media-paths.server.ts lib/repurpose/media-upload.server.ts app/api/repurpose/footage app/api/repurpose/video/route.ts app/api/repurpose/proxy/route.ts tests/server
git commit -m "feat: stream video imports to immutable originals"
```

## Task 4: Inspect media with ffprobe and make browser compatibility measurable

**Files:**

- Create: `lib/repurpose/media-inspection.server.ts`
- Create: `lib/repurpose/native-media-probe.ts`
- Create: `app/api/repurpose/media/route.ts`
- Create: `tests/server/media-inspection.test.ts`
- Create: `tests/unit/native-media-probe.test.ts`

### Step 1: Write failing inspection tests

The normalized contract in `media-types.ts`:

```ts
export interface MediaInspection {
  fingerprint: string;
  container: string;
  extension: string;
  size: number;
  durationSec: number;
  video: {
    codec: string;
    codecTag: string;
    profile: string;
    pixelFormat: string;
    width: number;
    height: number;
    fps: number;
  };
  audio: null | {
    codec: string;
    channels: number;
    sampleRate: number;
  };
}

export interface BrowserMediaProbe {
  decodable: boolean;
  durationSec: number;
  width: number;
  height: number;
  reason?: string;
}
```

Tests with the generated fixtures must prove:

- H.264/AAC normalizes codec, yuv420p, dimensions, 30 fps, duration, and audio.
- HEVC/AAC normalizes `hevc` even inside MOV.
- silent H.264 returns `audio: null`.
- invalid media returns a typed `MEDIA_INVALID` error with sanitized stderr.
- a missing ffprobe executable returns `FFPROBE_UNAVAILABLE`.
- fingerprint changes with file mtime, size, or compatibility settings version.
- a metadata event with finite duration but `videoWidth=0` and `videoHeight=0` is not decodable.

Run:

```powershell
npm test -- tests/server/media-inspection.test.ts tests/unit/native-media-probe.test.ts
```

Expected: FAIL.

### Step 2: Implement ffprobe parsing

Call ffprobe through `execFile` with an argument array:

```text
ffprobe -v error -show_format -show_streams -of json <path>
```

Parse rational frame rates such as `60000/1001` safely. Reject zero dimensions, missing video streams, invalid duration, and malformed JSON. Limit returned stderr to 600 sanitized characters and never include a command line.

`GET /api/repurpose/media?path=...` validates through `resolveAllowedVideoPath` and returns either the normalized inspection or:

```json
{ "error": { "code": "MEDIA_INVALID", "message": "This file is not a readable video." } }
```

### Step 3: Implement the real browser probe

`probeBrowserVideo(src, signal)` creates a muted metadata-only video, listens for metadata/error/abort, times out after 15 seconds, and succeeds only when duration is finite and positive and both decoded dimensions are positive. Always detach handlers and clear `src` before returning.

Run tests and typecheck.

Expected: PASS.

### Step 4: Commit

```powershell
git add lib/repurpose/media-types.ts lib/repurpose/media-inspection.server.ts lib/repurpose/native-media-probe.ts app/api/repurpose/media tests
git commit -m "feat: inspect codecs and verify browser decodability"
```

## Task 5: Build cancellable, validated H.264 compatibility masters

**Files:**

- Create: `lib/repurpose/ffmpeg-process.server.ts`
- Create: `lib/repurpose/compatibility-cache.server.ts`
- Create: `app/api/repurpose/compatibility/route.ts`
- Create: `tests/server/compatibility-cache.test.ts`
- Create: `tests/server/compatibility-route.test.ts`

### Step 1: Write failing job-lifecycle tests

The server state and wire response:

```ts
export type CompatibilityStatus =
  | "none"
  | "queued"
  | "building"
  | "ready"
  | "failed"
  | "cancelled"
  | "unavailable";

export interface CompatibilityState {
  status: CompatibilityStatus;
  progress: number | null;
  workingPath?: string;
  error?: { code: string; message: string };
}
```

Tests must prove:

- two simultaneous starts for one fingerprint call ffmpeg once.
- progress is parsed from `out_time_ms`/`out_time_us`.
- successful output is atomically renamed and then reused.
- output is rejected when validation is not H.264/yuv420p or duration differs by more than max(0.25 sec, one frame).
- output is rejected when width/height differ from the inspected input.
- output is rejected when frame rate differs by more than 0.01 fps from the inspected valid input.
- AAC is required only when input inspection contains audio.
- cancellation kills the exact child, reports `cancelled`, and removes the partial.
- cancelling a shared job is global for the local single-user process.
- a POST after cancellation starts a new job.
- failed hardware encode retries the next candidate and ultimately `libx264`.
- a failed software encode never publishes a final file.
- TTL and 20 GiB eviction never delete active partials.

Run:

```powershell
npm test -- tests/server/compatibility-cache.test.ts tests/server/compatibility-route.test.ts
```

Expected: FAIL.

### Step 2: Implement encoder discovery and actual-success fallback

Cache `ffmpeg -encoders` once. Candidate order:

- Windows: `h264_nvenc`, `h264_qsv`, `h264_amf`, `libx264`.
- macOS: `h264_videotoolbox`, `libx264`.
- Linux: `h264_nvenc`, `h264_qsv`, `libx264`.

Listing support is only a filter. Each candidate must run the actual encode; a non-zero exit tries the next candidate.

Common output arguments:

```text
-map 0:v:0 -map 0:a:0? -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart
```

Do not scale or change a valid input frame rate. Software uses `libx264 -preset medium -crf 18`. Hardware encoders use quality-oriented options supported by that encoder, isolated in one candidate table.

### Step 3: Implement cache, validation, routes, and cancellation

- Cache directory: `<tmp>/repurpose-compatible`.
- Filename: `<fingerprint>-compat-v1.mp4`.
- Partial: include pid plus random UUID.
- GET: state only; never expose private cache internals except `workingPath` after ready because the local client must persist it.
- POST: start/reuse.
- DELETE: cancel the shared fingerprint job.
- Validate every completed file through `inspectMedia` before rename.
- Sweep at most once per 10 minutes.

Run tests, then manually convert the deterministic HEVC fixture:

```powershell
npm test -- tests/server/compatibility-cache.test.ts tests/server/compatibility-route.test.ts
npm run typecheck
```

Expected: PASS.

### Step 4: Commit

```powershell
git add lib/repurpose/ffmpeg-process.server.ts lib/repurpose/compatibility-cache.server.ts app/api/repurpose/compatibility tests/server
git commit -m "feat: create reusable H264 compatibility masters"
```

## Task 6: Orchestrate import and persist original/working/preview identities

**Files:**

- Create: `lib/repurpose/video-import-client.ts`
- Create: `tests/unit/video-import-client.test.ts`
- Create: `tests/components/project-persistence.test.tsx`
- Modify: `lib/repurpose/types.ts`
- Modify: `lib/repurpose/ingest.ts`
- Modify: `lib/repurpose/store.ts`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts`

### Step 1: Write failing import-state tests

Add these types:

```ts
export type VideoImportPhase =
  | "copying"
  | "inspecting"
  | "checking-browser"
  | "converting"
  | "building-proxy"
  | "ready"
  | "cancelled"
  | "error";

export interface VideoSourceRecord {
  originalPath: string;
  workingPath: string;
  previewPath?: string;
  originalName: string;
  inspection: MediaInspection;
  nativeCompatible: boolean;
  compatibilityStatus: "native" | "converted";
}
```

Extend `FootageMeta` with optional `faceCamSource` and `screenSource` records while retaining the current URL fields. Extend `MediaAsset` and `Overlay` with optional `videoSource`. For video entries, legacy `sourcePath` points at the full-quality working file.

Tests must cover:

- state sequence `copying -> inspecting -> checking-browser -> ready` for compatible H.264.
- no compatibility POST for compatible H.264.
- sequence includes `converting` for a 0x0 browser probe.
- converted output is probed a second time; another 0x0 result is terminal error.
- cancel aborts XHR/fetch and DELETEs an active compatibility job.
- progress never decreases within a phase.
- an imported record sets working=original for native and working=master for converted.
- all error codes map to concise Portuguese UI messages while logs retain English codes.

Run:

```powershell
npm test -- tests/unit/video-import-client.test.ts
```

Expected: FAIL.

### Step 2: Implement streaming client orchestration

Use `XMLHttpRequest` only for the upload so `xhr.upload.onprogress` can report copying progress. Use fetch with an AbortSignal for inspection, browser probe, compatibility start/poll, and cancellation.

Public API:

```ts
export interface ImportVideoOptions {
  role: VideoRole;
  signal: AbortSignal;
  onProgress: (state: { phase: VideoImportPhase; progress: number | null; codec?: string }) => void;
}

export async function importVideoFile(file: File, options: ImportVideoOptions): Promise<VideoSourceRecord>;
export function videoUrlForWorkingSource(source: VideoSourceRecord): string;
export async function reconcileVideoSource(source: VideoSourceRecord, signal: AbortSignal): Promise<VideoSourceRecord>;
```

Poll conversion at 750 ms while visible and 2000 ms while the document is hidden. Stop on every terminal state.

### Step 3: Migrate snapshots lazily

Export pure helpers from `useProjectPersistence.ts` for testing:

```ts
export function restoreFootageMeta(meta: FootageMeta | null): FootageMeta | null;
export function restoreMediaAsset(asset: MediaAsset): MediaAsset;
```

Migration rules:

- New source records re-derive `faceCamPath`/`screenPath`/`src` from `workingPath`.
- Legacy proxied paths extract the `path` query and use it as both original and working when possible.
- Legacy blob paths stay flagged for re-import.
- Missing preview cache does not break restore; the proxy hook rebuilds it.
- Snapshots retain source records and never persist transient import progress.
- After synchronous hydration, `useProjectPersistence` runs one abortable reconciliation pass over face, screen, media-bin, and overlay video records before marking media Ready.
- Reconciliation checks both `originalPath` and `workingPath` through the media endpoint. A native source whose original vanished is flagged for re-import.
- When a converted `workingPath` was evicted but `originalPath` still exists, reconciliation re-inspects the original, POSTs the fingerprinted compatibility job, waits for a newly validated master, updates `workingPath`/browser URLs, and then permits playback.
- When both original and working paths vanished, reconciliation reports a reconnect error and never leaves the Play button appearing active.
- A missing `previewPath` is cleared immediately and rebuilt in the background; it never blocks full-quality playback.

Write persistence tests first for new, legacy proxied, legacy blob, evicted-converted-master-with-original-present, and all-source-files-missing snapshots. The evicted-master test must mock the compatibility job reaching Ready and assert the restored project uses its new working URL.

Run:

```powershell
npm test -- tests/unit/video-import-client.test.ts tests/components/project-persistence.test.tsx
npm run typecheck
```

Expected: PASS.

### Step 4: Commit

```powershell
git add lib/repurpose/video-import-client.ts lib/repurpose/types.ts lib/repurpose/ingest.ts lib/repurpose/store.ts app/repurpose-studio/_components/useProjectPersistence.ts tests
git commit -m "feat: persist original and working media sources"
```

## Task 7: Use the compatibility pipeline in every video entry point

**Files:**

- Create: `app/repurpose-studio/_components/VideoImportProgress.tsx`
- Create: `tests/components/VideoImportProgress.test.tsx`
- Modify: `app/repurpose-studio/_components/SourcesPanel.tsx`
- Modify: `app/repurpose-studio/_components/FilesPanel.tsx`
- Modify: `lib/repurpose/overlay-ingest.ts`
- Modify: `app/repurpose-studio/_components/RepurposeEditor.tsx`

### Step 1: Write failing progress UI tests

Render every phase and assert accessible, actionable copy:

- `Copiando arquivo` with percentage.
- `Inspecionando mídia`.
- `Verificando compatibilidade no Chrome`.
- `Convertendo HEVC para H.264` with percentage and Cancel button.
- `Criando proxy de prévia`.
- `Pronto`.
- layer-specific errors without raw absolute paths or command lines.

Run:

```powershell
npm test -- tests/components/VideoImportProgress.test.tsx
```

Expected: FAIL.

### Step 2: Replace SourcesPanel blob-only video import

Make `handleMediaFiles` async and call `importVideoFile`. On success:

- update only the selected face/screen source record;
- derive the current URL path from its working file;
- use inspection fps, geometry, and duration instead of transcript defaults;
- keep the other track unchanged;
- revoke no persistent URL because the result is not a blob;
- expose cancel during conversion;
- reset the input so selecting the same file fires again.

While either required base source is importing, set store readiness `loading`. When both paths decode, PreviewCanvas moves it to `ready`.

### Step 3: Replace FilesPanel video probing

Images/audio keep the existing asset route. Videos use `importVideoFile(role: "library")` and register:

- `src` from working path;
- `sourcePath` as working path for legacy consumers;
- `videoSource` with original/working/preview metadata;
- dimensions and duration from server inspection, not a potentially misleading header-only browser event.

This directly removes the reproduced `Could not decode that video` failure for HEVC media-bin imports.

### Step 4: Replace video-overlay ingest

Images keep the current lightweight flow. Videos use `importVideoFile(role: "overlay")` before `addOverlay` and `addMediaAsset`. Preserve the single shared ingest function for picker, drop, and paste. A conversion error must be returned to the caller and surfaced in `RepurposeEditor`, not only logged to the console.

### Step 5: Test and commit

Run:

```powershell
npm test -- tests/components/VideoImportProgress.test.tsx tests/unit/video-import-client.test.ts
npm run typecheck
```

Expected: PASS.

```powershell
git add app/repurpose-studio/_components lib/repurpose/overlay-ingest.ts tests
git commit -m "fix: import HEVC across footage files and overlays"
```

## Task 8: Generalize and harden the 540p preview proxy

**Files:**

- Rename: `app/repurpose-studio/_components/useFacecamProxy.ts` to `app/repurpose-studio/_components/useVideoProxy.ts`
- Create: `lib/repurpose/video-proxy-client.ts`
- Create: `tests/server/proxy-cache.test.ts`
- Create: `tests/unit/useVideoProxy.test.tsx`
- Modify: `lib/repurpose/proxy-cache.ts`
- Modify: `app/api/repurpose/proxy/route.ts`
- Modify: `app/api/repurpose/video/route.ts`
- Modify: `app/repurpose-studio/_components/PreviewCanvas.tsx`
- Modify: `app/repurpose-studio/_components/FilesPanel.tsx`
- Modify: `lib/repurpose/overlay-ingest.ts`
- Modify: `lib/repurpose/types.ts`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts`

### Step 1: Write failing Windows/proxy tests

Tests must prove:

- a `C:\Users\...\video.mp4` URL round-trips through `rawPathFromRef`.
- face, screen, media-bin, and overlay sources start/reuse the same fingerprinted proxy job.
- proxy filename includes the 540p/settings version.
- output short side is 540 and both dimensions are even.
- keyframe spacing is no greater than 0.6 seconds.
- cache uses 30-day/10 GiB policy.
- hardware order is platform-aware and actual failure falls back to libx264.
- proxy swaps only while paused.
- a proxy 404 falls back to working media and queues a rebuild.
- export-facing `faceCamPath`/`screenPath` never change to proxy URLs.
- PreviewCanvas gives a video overlay its `previewPath` while `export-short.ts` still receives that overlay's working `src`.
- snapshot reconciliation clears/rebuilds evicted proxies for footage, media-bin assets, and overlays.

Run:

```powershell
npm test -- tests/server/proxy-cache.test.ts tests/unit/useVideoProxy.test.tsx
```

Expected: FAIL; the current hook rejects Windows raw paths and only handles facecam, and the current proxy is 144p.

### Step 2: Implement the generalized hook and proxy

Rename the hook, export and test `rawPathFromRef`, accept Windows drive paths, and call it once for screen and once for face.

Move non-React polling into:

```ts
export async function ensureVideoProxy(
  source: VideoSourceRecord,
  signal: AbortSignal,
  onProgress?: (progress: number | null) => void,
): Promise<VideoSourceRecord>;
```

The hook delegates to this client. FilesPanel and overlay ingest start it in the background immediately after compatibility import, and persistence reconciliation restarts it for restored footage, media-bin, and overlay records. One server fingerprint still de-duplicates all callers.

Change proxy settings:

```ts
const PROXY_SHORT_SIDE = 540;
const PROXY_SETTINGS_VERSION = "proxy-v2-540p-gop-half-second";
```

Derive GOP from the inspected fps with `Math.max(1, Math.round(fps * 0.5))` rather than hardcoding 15. Encode H.264/yuv420p/AAC/faststart with even scaling.

When ready, update only nested `previewPath` for persistence/diagnostics. Hidden base and overlay video elements receive the proxy URL. `Overlay.src`, `MediaAsset.src`, and the working URLs in FootageMeta remain untouched because export and placement must continue to resolve full-quality media.

Add one narrow store action:

```ts
type VideoSourceTarget =
  | { kind: "footage"; role: "face" | "screen" }
  | { kind: "asset"; id: string }
  | { kind: "overlay"; id: string };

setVideoSourceRecord(target: VideoSourceTarget, source: VideoSourceRecord): void;
```

It immutably updates only the matching nested source record without changing working URLs. Proxy clients call it after Ready and after clearing a 404'd preview.

### Step 3: Test and commit

Run:

```powershell
npm test -- tests/server/proxy-cache.test.ts tests/unit/useVideoProxy.test.tsx
npm run typecheck
```

Expected: PASS.

```powershell
git add app/repurpose-studio/_components/useVideoProxy.ts app/repurpose-studio/_components/PreviewCanvas.tsx app/repurpose-studio/_components/FilesPanel.tsx lib/repurpose/video-proxy-client.ts lib/repurpose/overlay-ingest.ts lib/repurpose/proxy-cache.ts lib/repurpose/types.ts app/api/repurpose/proxy app/api/repurpose/video app/repurpose-studio/_components/useProjectPersistence.ts tests
git commit -m "fix: build Windows compatible 540p preview proxies"
```

## Task 9: Vendor the offline SFX engine with the route's real contract

**Files:**

- Create: `scripts/sfx-engine/LICENSE.soundeffects-claude-code`
- Create: `scripts/sfx-engine/pyproject.toml`
- Create: `scripts/sfx-engine/uv.lock`
- Create: `scripts/sfx-engine/build_sfx_track.py`
- Create: `scripts/sfx-engine/sfx/Mouse Click.wav`
- Create: `scripts/sfx-engine/sfx/mixkit-fast-double-click-on-mouse-275.wav`
- Create: `scripts/sfx-engine/sfx/Keyboard-Button-Click-06-c-FesliyanStudios.com_.wav`
- Create: `scripts/sfx-engine/sfx/Whoosh 1.wav`
- Create: `scripts/sfx-engine/sfx/mixkit-air-in-a-hit-2161.wav`
- Create: `scripts/sfx-engine/sfx/Correct Ding.wav`
- Create: `scripts/sfx-engine/sfx/mixkit-bike-notification-bell-590.wav`
- Create: `scripts/sfx-engine/sfx/Camera Shutter 5.wav`
- Create: `scripts/sfx-engine/sfx/mixkit-camera-digital-shutter-1432.wav`
- Create: `scripts/sfx-engine/sfx/Riser 3.wav`
- Create: `scripts/sfx-engine/sfx/Impact 7.wav`
- Create: `scripts/sfx-engine/sfx/textdigitalreadout.wav`
- Create: `tests/integration/sfx-engine.test.ts`
- Create: `tests/server/sfx-route.test.ts`
- Modify: `app/api/repurpose/sfx/route.ts`
- Modify: `.github/workflows/test.yml`
- Modify: `TESTING.md`

### Step 1: Copy only the useful MIT-licensed subset

Source: `https://github.com/Lantech01/soundeffects-claude-code.git`.

Copy the 12 WAV assets, retain its MIT license, and adapt the small pydub mixer. Do not copy its Claude skill or add `openai-whisper`. The local `pyproject.toml` contains only:

```toml
[project]
name = "repurpose-sfx-engine"
version = "1.0.0"
requires-python = ">=3.10"
dependencies = ["pydub==0.25.1"]
```

Run `uv lock` inside `scripts/sfx-engine` and commit the lock.

### Step 2: Write failing CLI and route tests

The CLI must require:

```text
--events-json <path> --output <path> --duration-ms <positive integer>
```

Tests must prove:

- valid events JSON creates 48 kHz stereo WAV.
- duration is within 50 ms of requested duration.
- all 12 keys resolve.
- unknown effect, negative time, out-of-range time, malformed JSON, and empty events fail non-zero without publishing output.
- two overlapping events mix instead of replacing each other.
- the API rejects malformed payloads before launching Python.
- valid API output is non-empty, duration-matched, and range-streamable.
- missing uv/engine produces `SFX_ENGINE_UNAVAILABLE` with setup guidance.

Run:

```powershell
npm test -- tests/integration/sfx-engine.test.ts tests/server/sfx-route.test.ts
```

Expected: FAIL because the engine is absent and the reference script ignores `--events-json`.

### Step 3: Implement strict JSON loading and atomic route publication

`build_sfx_track.py` reads only the supplied JSON, validates keys/types/times, renders silence at 48 kHz stereo, normalizes/trims each effect as the reference engine does, and writes the requested path.

The API writes Python output to a unique `.partial.wav`, validates it with Python's standard `wave` module or ffprobe, then atomically renames to the hashed final path. The finalizer removes events JSON and partial output. Use `uv run --frozen python build_sfx_track.py ...`.

Update CI to make its native prerequisites explicit. The workflow uses `ubuntu-latest`, installs ffmpeg through apt, verifies `ffmpeg -encoders` contains `libx265` before fixture generation, sets up Python 3.12, installs `uv` with `python -m pip install uv`, and runs `uv sync --frozen --project scripts/sfx-engine` before `npm test`. This keeps the committed workflow green once SFX integration tests exist.

Run:

```powershell
npm test -- tests/integration/sfx-engine.test.ts tests/server/sfx-route.test.ts
npm run typecheck
```

Expected: PASS.

### Step 4: Commit

```powershell
git add scripts/sfx-engine app/api/repurpose/sfx/route.ts .github/workflows/test.yml tests TESTING.md
git commit -m "feat: add offline sound effects renderer"
```

## Task 10: Lock project reopen and export to full-quality media

**Files:**

- Create: `tests/e2e/helpers/project.ts`
- Create: `tests/e2e/helpers/audio-analysis.ts`
- Create: `tests/e2e/h264-editor.spec.ts`
- Create: `tests/e2e/hevc-editor.spec.ts`
- Create: `tests/e2e/export.spec.ts`
- Create: `tests/integration/export-contract.test.ts`
- Modify: `lib/repurpose/export-short.ts`
- Modify: `app/repurpose-studio/_components/RepurposeEditor.tsx`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts`

### Step 1: Write failing export/source contract tests

Extract a pure resolver:

```ts
export interface ResolvedExportSources {
  screen: string | undefined;
  face: string | undefined;
}

export function resolveExportSources(meta: FootageMeta | null): ResolvedExportSources;
```

Tests:

- new records resolve browser URLs from `workingPath`.
- native records resolve original/working without proxy.
- converted records resolve compatibility master.
- `previewPath` is ignored even when present.
- legacy path-only snapshots still resolve.

Run:

```powershell
npm test -- tests/integration/export-contract.test.ts
```

Expected: FAIL.

### Step 2: Route every export read through the resolver

Use resolved sources for reachability, Mediabunny decode, `loadVideo` fallback, thumbnail/audio assembly, and error messages. Keep proxy paths out of the function's return by construction.

Improve export errors:

- unsupported browser encoder -> name H.264/HEVC WebCodecs availability.
- unreadable working source -> offer re-import/reconvert.
- audio mix failure remains non-fatal but is captured in a visible export warning.

Run unit tests and typecheck.

Expected: PASS.

### Step 3: Create real Chrome E2E workflows

Helpers must:

- create a project through the visible hub;
- upload raw.srt;
- attach face and screen fixtures through accessible labels;
- wait for `Pronto`;
- click Play and assert timecode/playhead changes once;
- pause and assert it freezes within 100 ms;
- seek by clicking the timeline;
- save/reload/reopen;
- collect console/page errors and fail on unexpected messages.

`h264-editor.spec.ts` asserts no `Convertendo` phase.

`hevc-editor.spec.ts` asserts conversion occurs, reaches Ready, and reload keeps playable working references.

`export.spec.ts` first exports a three-second base-audio control, then adds captions, the deterministic image/video overlay, 220 Hz music, generates SFX at a known transcript-triggered time, exports the layered 1080p result, saves both Playwright downloads, opens the layered file in a new Chrome page, and asserts positive decoded dimensions/duration. After the test, call ffprobe through a safe helper and assert:

- one H.264 or HEVC video stream;
- at least one audio stream;
- duration within max(0.5 sec, two frames) of the edited project;
- dimensions 1080x1920.

`audio-analysis.ts` runs ffmpeg without a shell to decode each downloaded audio stream as mono 48 kHz float PCM. It implements a small Goertzel/RMS analyzer and proves against the base-only control:

- the layered export's 220 Hz magnitude is at least 4x the control, demonstrating that the music bed survived muxing;
- RMS in a 100 ms window centered on the planned SFX event is at least 1.5x the same control window, demonstrating that the SFX track was mixed at the intended time;
- the original 440 Hz face-audio tone remains present, demonstrating that layering did not replace narration.

If these deterministic thresholds reveal codec noise variance on the installed Chrome encoder, calibrate once from measured control/layered values and record the evidence in the QA report; never weaken the test to “audio stream exists.”

Add visual assertions at Ready, after seek, with overlay/caption layers, and on the reopened project. Use a 3% maximum pixel-difference ratio only for deterministic generated fixtures.

The first intentional baseline creation runs `npm run test:e2e -- --update-snapshots`, then a human/agent visually inspects every generated expected PNG before staging it. A normal `npm run test:e2e` must pass against those reviewed baselines before the task is committed.

Run:

```powershell
npm run fixtures:media
npm run test:e2e -- tests/e2e/h264-editor.spec.ts tests/e2e/hevc-editor.spec.ts tests/e2e/export.spec.ts
```

Expected: PASS with no unexpected console errors.

### Step 4: Commit

```powershell
git add lib/repurpose/export-short.ts app/repurpose-studio/_components tests
git commit -m "test: verify project reopen and layered MP4 export"
```

## Task 11: Resolve dependency findings without changing product scope

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

### Step 1: Capture the current audit

Run:

```powershell
npm audit
npm outdated
```

Expected baseline: six high-severity findings were observed after the initial install. Save the package/advisory names in the commit body or QA report; do not paste secrets or user paths.

### Step 2: Apply compatible security updates

Run:

```powershell
npm audit fix
```

Do not use `--force`. If a remaining production high requires a major framework upgrade, record it as a residual finding instead of widening this stabilization into a migration.

### Step 3: Verify after dependency changes

Run:

```powershell
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Expected: all code verification passes and no high-severity production dependency remains. If dev-only advisories remain without a compatible fix, record exact package/advisory and impact in the QA report.

### Step 4: Commit

```powershell
git add package.json package-lock.json
git commit -m "chore: apply compatible dependency security fixes"
```

## Task 12: Exhaustive browser QA, actual HEVC acceptance, and final evidence

**Files:**

- Create: `.gstack/qa-reports/repurpose-studio-stabilization-2026-08-21/report.md`
- Create: `.gstack/qa-reports/repurpose-studio-stabilization-2026-08-21/screenshots/*.png`
- Modify: `docs/superpowers/specs/2026-08-21-repurpose-studio-stabilization-design.md`
- Modify: `TESTING.md`

### Step 1: Start from a clean worktree

Run:

```powershell
git status --short
```

Expected: empty. If not empty, inspect and preserve every unrelated user change before continuing.

### Step 2: Run the complete automated gate freshly

```powershell
npm run fixtures:media
npm run typecheck
npm test
npm run test:e2e
npm run build
npm audit --omit=dev
```

Record command, timestamp, exit code, and summary in `report.md`.

### Step 3: Test the user's actual 4K60 HEVC file

Use:

```text
C:\Users\oslan\Downloads\IMG_6849.MOV
```

Through the visible UI:

1. import it in Files and place it as an overlay;
2. import it as Face or Screen footage;
3. confirm ffprobe shows HEVC, 3840x2160, approximately 60 fps;
4. confirm the UI reports conversion, never the generic decode error;
5. wait for Ready;
6. play/pause five times;
7. seek at start/middle/end and across a clip boundary;
8. verify the proxy builds and swaps only while paused;
9. save, reload, reopen, and play;
10. export a short bounded in/out region to keep acceptance runtime reasonable;
11. open the export in Chrome and verify it with ffprobe.

Capture screenshots before import, during conversion, Ready/playing, reopened project, layered preview, and successful export. Record conversion time and whether hardware or software encoder won.

### Step 4: Dogfood every in-scope editor surface

Use exhaustive QA and fix every reproducible critical/high/medium defect inside the approved design:

- hub create/open/delete flow;
- raw and final transcript import;
- footage import;
- Files image/video/audio import;
- drag/drop and paste overlay import;
- Play/Pause/Space/J-K-L/frame step;
- timeline seek, scrub, split, trim, in/out, loop;
- captions;
- image/video overlays;
- music;
- offline SFX;
- autosave and reload;
- 1080p export.

After every interaction inspect console/page errors. For each found bug, first add the smallest failing automated regression, then fix, rerun the narrow test, and make one focused commit. Do not include cosmetic redesign or the six leadgenman agent workflows.

### Step 5: Verify visual export parity

At three deterministic timestamps, save:

- preview canvas screenshot;
- decoded exported frame from the same output timestamp.

Compare layout seam, face/screen crop, overlay position, caption text/position, and color grade. The report must include a table of expected/actual for each layer; do not declare parity from duration/codec checks alone.

Run the deterministic PCM analyzer from Task 10 against the final layered export and include its 440 Hz narration, 220 Hz music, and SFX-window measurements in the same expected/actual table. An audio stream count alone is not acceptable evidence for music/SFX parity.

### Step 6: Finish documentation

Update the design status to `Implemented and verified` only after every acceptance item has evidence. Update `TESTING.md` with any Windows-specific setup learned during the real run.

The QA report must include:

- environment and commit SHA;
- automated command results;
- fixture and actual-file metadata;
- issue table with severity/status/commit;
- screenshots;
- exported file ffprobe summary;
- console error count;
- residual risks, including any dev-only advisory;
- explicit acceptance checklist.

### Step 7: Final clean verification and commit

Run:

```powershell
git status --short
npm run verify
git diff --check
```

Expected: verification passes and `git diff --check` prints nothing.

```powershell
git add .gstack/qa-reports/repurpose-studio-stabilization-2026-08-21 docs/superpowers/specs/2026-08-21-repurpose-studio-stabilization-design.md TESTING.md
git commit -m "docs: record editor stabilization QA"
git status --short
```

Expected: final status is clean.

## Final acceptance handoff

Before claiming completion, run the verification-before-completion skill against fresh outputs and report:

- worktree path and branch;
- final commit list;
- exact command results;
- actual `IMG_6849.MOV` result;
- export path/metadata;
- QA report link;
- any residual limitation.

Do not merge, push, delete the worktree, or stop the existing main-branch dev server unless the user separately authorizes it.
