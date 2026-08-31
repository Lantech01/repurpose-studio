# Repurpose Studio Stabilization Design

Date: 2026-08-21
Branch: `fix/stabilize-editor`
Status: Implemented and verified on Windows (2026-08-26)

## Context

Repurpose Studio builds successfully, but its core editing workflow is not yet dependable on this Windows machine. The first reproduced failure is media compatibility: a healthy 4K60 HEVC/H.265 `.mov` is accepted by the uploader, but Chrome cannot produce decoded video dimensions, so import or playback fails. The Play transport is also reported as non-functional. The optional local SFX route is present, but its engine is absent and the external reference engine does not implement the `--events-json` contract the route calls.

The project currently has no automated test framework. Most product behavior landed in one large initial commit, with several tightly coupled files over 60 KB, so fixes need regression coverage and narrow boundaries rather than a broad rewrite.

## Goal

Make the existing local editor reliable end to end, without external AI APIs:

- Import H.264 and HEVC/H.265 MP4/MOV sources.
- Play, pause, seek, scrub, cut, and preview without transport drift.
- Keep overlays, captions, music, and SFX synchronized.
- Save and reopen projects.
- Export a playable MP4 with the expected picture and audio layers.
- Bundle the caption faces used by preview/export so the editor never silently falls back after an HTTP 404.
- Make the transcript-first setup sequence explicit before optional media-library actions.
- Provide actionable progress and error states instead of generic decoder failures.
- Add repeatable unit, integration, and browser regression tests.

## Non-goals

- Do not embed the six `leadgenman-video-skills` Claude Code workflows in the web UI.
- Do not add OpenAI, Whisper API, or another external AI service in this phase.
- Do not redesign the editor or rewrite the Zustand store, timeline, or compositor wholesale.
- Do not alter or overwrite a user's original media file.
- Do not add cloud storage, accounts, collaboration, or deployment work.

## Design Principles

1. Preserve originals. All generated media is a derived cache artifact.
2. Try the cheapest valid path first. Native playback wins when it is genuinely decodable.
3. Separate playback media from source media. Preview optimization must not reduce export quality.
4. Use one timeline clock. Media elements follow transport state; they do not each invent it.
5. Fail atomically. Partial transcodes and SFX renders are never published.
6. Test the user-visible failure before changing production behavior.

## Architecture

### 1. Media inspection and compatibility

Introduce a server-side media inspection/compatibility boundary used by footage and Files imports.

The inspection endpoint runs `ffprobe` and returns a normalized description:

- container and extension;
- video codec, codec tag, profile, pixel format, width, height, and frame rate;
- audio codec and channel information;
- duration and file size;
- a stable source fingerprint based on resolved path, modification time, size, and compatibility settings.

The browser still performs a real metadata probe. A source is native-compatible only when the metadata event completes, duration is valid, and decoded dimensions are greater than zero. A container header being readable is not enough; the observed HEVC case reports duration while producing `0x0` video.

When native probing fails, the client requests a compatibility master. The server transcodes to MP4 with:

- H.264 video;
- `yuv420p` pixel format;
- AAC audio when audio is present;
- original geometry and frame rate unless ffmpeg reports an invalid value;
- `+faststart` for range-friendly playback;
- a hardware encoder when a one-time capability probe and the actual encode both succeed;
- `libx264` as the reliable fallback.

Encoding writes to a uniquely named partial file and atomically renames it only after ffmpeg exits successfully and `ffprobe` validates the result. Jobs are de-duplicated by fingerprint, expose progress, and are reused across imports and project reloads.

The data model distinguishes:

- `originalPath`: immutable user source;
- `workingPath`: original when native-compatible, otherwise the full-quality compatibility master;
- `previewPath`: optional lightweight editing proxy;
- inspection metadata and compatibility status.

Existing project records migrate lazily: missing fields are derived from their current paths when opened.

### 2. Preview proxy

Preview and scrubbing may use a separate H.264 proxy with frequent keyframes. It is never used for final export.

The existing 144p proxy is too soft for dependable editing. The stabilized default uses a 540-pixel short side, even dimensions, `yuv420p`, AAC audio, faststart, and a keyframe interval near 0.5 seconds. The proxy is generated in the background after a working source exists. Playback can begin from the working source and swap to the proxy only while paused.

Compatibility masters and preview proxies use bounded caches with TTL and size-budget eviction. Cache loss is recoverable: the source fingerprint rebuilds the missing artifact.

### 3. Transport and synchronization

Create one transport controller for Play, Pause, seek, and frame updates.

The controller owns:

- `isPlaying`;
- current output-timeline time;
- play start output time and monotonic start timestamp;
- duration bounds;
- seek/discontinuity generation;
- readiness and synchronization state.

During playback, one `requestAnimationFrame` loop advances output time from a monotonic clock. Preview video/audio elements map that output time to their source time. At clip boundaries, seeks, and source changes, elements synchronize to the target before normal playback resumes. Small drift is tolerated; drift beyond a defined threshold is corrected. Play and Pause are idempotent, and repeated clicks cannot create multiple animation loops.

The transport refuses to enter playing state when there is no playable clip, duration is zero, or required media failed to load. The UI shows the reason instead of appearing to play while nothing advances.

### 4. Local SFX engine

Vendor a compatible, offline SFX renderer under `scripts/sfx-engine/`:

- the 12 MIT-licensed WAV assets from `soundeffects-claude-code`;
- a Python entrypoint that accepts `--events-json`, `--output`, and `--duration-ms`;
- a minimal `pyproject.toml` and locked dependency setup;
- no Whisper or OpenAI dependency.

The browser continues to compute placements from the already loaded transcript and current edited timeline. The server validates effect names and timestamps, passes a temporary event file to the engine, validates the resulting WAV, publishes it atomically, and removes transient inputs.

The SFX track remains a normal persisted project asset. It plays in preview, respects the gain control, and is mixed into export. Missing engine/dependency failures produce a concise setup error rather than a raw process exception.

## User Experience and Error Handling

Import states are explicit:

1. Copying file
2. Inspecting media
3. Checking browser compatibility
4. Converting to compatible H.264, when required
5. Building preview proxy, in background
6. Ready

The UI displays source codec, conversion progress, and whether preview is using a proxy. Users can cancel a queued or active conversion. Cancellation terminates the process, removes the partial output, and leaves the original untouched.

Errors identify the failed layer and a useful action:

- file is outside an allowed local folder;
- unsupported or corrupt container;
- ffmpeg/ffprobe unavailable;
- conversion failed, including a short sanitized reason;
- browser could not decode either source or compatibility master;
- SFX renderer unavailable or produced no output;
- export codec is unsupported by the browser.

No absolute filesystem paths or command lines are exposed beyond the local UI information already required to identify the user's selected file.

## Testing Strategy

Bootstrap Vitest for unit/integration coverage and Playwright using the installed Chrome executable for real browser flows. Tests are local and require no account or API key.

Small deterministic fixtures are generated with ffmpeg during test setup rather than committing large videos:

- H.264/AAC MP4;
- HEVC/AAC MOV;
- video without audio;
- intentionally invalid media.

Required regression coverage:

- inspection normalizes H.264 and HEVC metadata;
- native-compatible input skips compatibility conversion;
- undecodable HEVC creates and reuses a validated H.264 master;
- failed/cancelled conversion never publishes a partial file;
- import progress reaches Ready or an actionable terminal error;
- Play advances exactly one transport clock;
- Pause freezes time and repeated Play does not create duplicate loops;
- seek and clip-boundary mapping keep preview time within tolerance;
- project persistence retains original, working, and preview references;
- SFX CLI consumes event JSON and produces a non-empty duration-matched WAV;
- SFX API rejects malformed events and returns a playable result for valid input;
- export produces a browser-playable MP4 with expected duration and audio streams.
- every caption font offered by the Inspector is available to both preview and export;
- an empty project identifies raw transcript, Screen, and Face as the prerequisites for Play.

Browser QA runs the complete workflow twice, first with H.264 and then with HEVC, and checks console errors after every interaction. Before/after screenshots and a structured QA report are stored under `.gstack/qa-reports/`.

## Acceptance Criteria

The stabilization is complete only when all of the following are freshly verified:

- H.264 MP4 import completes without transcoding.
- The reproduced 4K60 HEVC MOV imports through compatibility conversion and becomes playable.
- Play/Pause works repeatedly, playhead advances, and seek remains synchronized.
- Timeline cuts, captions, image/video overlays, music, and generated SFX preview correctly.
- A project can be saved, the page reloaded, and the project reopened with working media references.
- SFX generation works offline from the existing transcript and appears in preview/export.
- MP4 export opens in Chrome and ffprobe confirms valid video/audio streams.
- No unexpected console errors occur in the tested workflows.
- Unit, integration, browser tests, TypeScript validation, and production build pass.

## Delivery Sequence

1. Establish browser QA and automated test infrastructure.
2. Reproduce and test the Play transport failure.
3. Fix transport and verify H.264 playback.
4. Add media inspection and HEVC compatibility-master generation.
5. Connect import progress, persistence migration, and preview proxy behavior.
6. Vendor and connect the offline SFX engine.
7. Verify project reopen and full export.
8. Run exhaustive browser QA, resolve remaining in-scope defects, and publish the report.
