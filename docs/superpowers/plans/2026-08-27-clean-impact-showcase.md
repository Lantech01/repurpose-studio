# Clean Impact Showcase Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a separately persisted Clean Impact showcase project through the existing editor UI and export a verified 1080x1920 MP4 without changing the protected source or existing project.

**Architecture:** Drive the running local editor on port 3001 with a temporary Playwright script outside the repository. The script records file/API baselines, performs every edit through visible UI controls, persists and reopens the new project, captures local screenshots, downloads the export, and writes ignored JSON evidence. Repository application code remains unchanged.

**Tech Stack:** Next.js Repurpose Studio, Playwright/Chromium, Node.js `fs`/`crypto`, ffmpeg/ffprobe, local Python/pydub SFX engine.

---

## File And Data Map

- Read only: `C:\Users\oslan\Downloads\IMG_6849.MOV`
- Read only: `C:\Users\oslan\Downloads\IMG_6849.srt`
- Protect: `C:\Users\oslan\Downloads\repurpose-projects\hoje-18h30-tem-26-aug-26.json`
- Read: `tests/fixtures/generated/overlay.png`
- Read: `tests/fixtures/generated/overlay.mp4`
- Read: `tests/fixtures/generated/music.wav`
- Create outside Git: `C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\create-showcase.cjs`
- Create outside Git: `C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\music-loop.wav`
- Create outside Git: `C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\clean-impact-showcase.mp4`
- Create outside Git: `C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\visual-control.mp4`
- Create outside Git: `C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\music-control.mp4`
- Create outside Git: `C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\evidence.json`
- Create outside Git: `C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\screenshots\*.png`
- Create through the app: one new JSON project under `C:\Users\oslan\Downloads\repurpose-projects\`

### Task 1: Establish Safety Baselines

Execution starts only after this plan is reviewed. Because no commit was requested, this plan file may be the sole intentional Git change; record that exact state as the repository baseline and preserve it.

- [ ] **Step 1: Verify the local app and project list**

Run:

```powershell
curl.exe --fail --silent --show-error http://127.0.0.1:3001/api/repurpose/projects
```

Expected: HTTP 200 and the existing project `hoje-18h30-tem-26-aug-26` is present. Also record the listener PID/command line for port 3001 and the exact initial state of port 3000: listener PID/command line if present, otherwise `absent`.

- [ ] **Step 2: Create the approved temporary evidence directory**

Verify `C:\Users\oslan\AppData\Local\Temp\opencode` exists, then create only `clean-impact-showcase` and its `screenshots` child.

- [ ] **Step 3: Generate the required local media fixtures once**

Run `npm run fixtures:media` before any showcase step consumes `overlay.png`, `overlay.mp4`, or `music.wav`.

Expected: all three files exist under `tests/fixtures/generated/`; they remain ignored and do not dirty Git.

- [ ] **Step 4: Record immutable baselines**

The temporary driver must write these values to `evidence.json` before opening an editor route:

```text
IMG_6849.MOV: absolute path, size, mtimeMs, SHA-256
IMG_6849.srt: absolute path, size, mtimeMs, SHA-256
hoje-18h30-tem-26-aug-26.json: size, mtimeMs, SHA-256
GET /api/repurpose/projects response
GET /api/repurpose/projects/hoje-18h30-tem-26-aug-26 response
```

Expected: all three files are readable and the existing project snapshot is captured only in the local evidence file.

- [ ] **Step 5: Record the repository baseline**

Record the output of `git rev-parse HEAD`, `git status --porcelain=v1`, and `git diff --stat` in evidence before starting Chromium.

Expected: HEAD remains the pre-execution commit and status contains at most this plan file as the known intentional change. Record any other pre-existing paths and do not modify them.

- [ ] **Step 6: Make failure evidence unconditional**

Wrap the temporary driver in `try/catch/finally`. The catch block records the failing phase, exception, current URL, current durable project ID, browser errors, and a failure screenshot. The finally block always recomputes protected-file fingerprints, writes `evidence.json`, and closes browser resources. Register equivalent process-level handlers so an uncaught rejection still writes failure evidence. Never open, mutate, or delete the protected existing project as part of recovery.

### Task 2: Create And Hydrate The New Project Through The UI

- [ ] **Step 1: Write the temporary Playwright driver**

Create `create-showcase.cjs` outside Git. Resolve Playwright from this worktree and launch the installed browser with `{ channel: "chrome", args: ["--disable-features=PlatformHEVCDecoderSupport"] }`, matching `playwright.config.ts`; bundled Chromium is not assumed to exist. Use viewport `1600x1000`, disable `window.showSaveFilePicker`, and collect console errors, page errors, HTTP errors, failed requests, `/api/repurpose/video` export requests, and managed overlay-asset requests. Implement the unconditional failure/finally path from Task 1 before the first navigation.

- [ ] **Step 2: Create a provisional project**

Navigate to `/repurpose-studio`, wait for hub loading placeholders to disappear, capture `01-hub-before.png`, and click the first exact `New Project` button.

Expected: URL matches `/repurpose-studio/new-*` and the Sources onboarding is visible.

- [ ] **Step 3: Load the real transcript and capture the durable ID**

Use the file chooser behind `Load raw transcript (.srt / .json)` with `IMG_6849.srt`. Poll until the route no longer ends in `new-*`, save that final segment as `projectId`, and assert it is not `hoje-18h30-tem-26-aug-26`. Then choose the same SRT through `Load final transcript (.srt)`.

Expected: transcript words and caption blocks exist, project duration is between 9.8 and 10.1 seconds, and `projectId` is persisted to evidence immediately.

- [ ] **Step 4: Import the protected MOV as both base sources**

Choose `IMG_6849.MOV` through the `Screen` picker, wait for the snapshot to contain `screenSource`, then repeat through `Face` and wait for `faceCamSource`. Wait until `Play` is enabled and `Preparing fast preview` disappears.

Expected: both source records share the same immutable original fingerprint, use a full-quality working path, and publish preview proxies without modifying the MOV.

- [ ] **Step 5: Capture the hydrated baseline**

Save `02-hydrated-project.png`, assert the preview canvas is 9:16, and assert browser errors are empty apart from the three known optional demo 404s and lifecycle aborts already accepted by the test helper contract.

### Task 3: Apply The Clean Impact Visual Edit

- [ ] **Step 1: Add phrase-boundary cuts**

Seek to approximately `3.17s` and click `Split clip at playhead`; seek to approximately `6.10s` and split again. Do not delete speech.

Expected: the persisted snapshot contains three kept clips with continuous timeline boundaries.

- [ ] **Step 2: Shape the Screen/Face composition**

At a playhead inside each scene, drag the preview split handle to scene ratios `0.57`, `0.50`, and `0.57`. This creates two restrained layout transitions while keeping 57/43 as the base.

Expected: each kept clip persists the intended `splitRatio`, within `0.01`.

- [ ] **Step 3: Apply subtle grades**

In `Color adjustments`, select `Warm` for Face and `Neutral` for Screen.

Expected: snapshot values are `faceGrade="warm"` and `screenGrade="neutral"`.

- [ ] **Step 4: Configure captions**

Enable captions if needed, choose the `Minimal` template, select `Inter`, choose weight `700`, keep two words per caption, keep Pin to split on, set Size near `0.052`, and choose coral `#FF6B35` for Active while Fill remains white.

Expected: persisted caption style uses `clean-minimal`, `inter`, weight `700`, active coral, white fill, and no missing-font request occurs.

- [ ] **Step 5: Place two accent overlays**

Seek to approximately `2.0s` and choose `overlay.png` through `Add media (image / video)`. Seek to approximately `6.5s` and choose `overlay.mp4` through the same UI action.

Expected: the snapshot contains one image overlay and one video overlay at separate timeline ranges; the video overlay is visible in the hidden media pool and both are copied to managed storage.

- [ ] **Step 6: Capture the visual edit**

Seek to `2.5s` and save `03-clean-impact-first-accent.png`; seek to `7.0s` and save `04-clean-impact-second-accent.png`.

- [ ] **Step 7: Export an audio control before adding music**

Select `1080p` and export the current visual-only edit as `visual-control.mp4`. This control must contain narration and every visual layer but no music or generated SFX.

Expected: the download succeeds, no export alert/warning appears, and the snapshot still has neither audio enhancement track.

### Task 4: Add Music And Offline SFX

- [ ] **Step 1: Generate a duration-matched temporary music bed**

Read the persisted project duration and run:

```powershell
ffmpeg -y -hide_banner -loglevel error -stream_loop -1 -i "tests/fixtures/generated/music.wav" -t <project-duration> -ac 2 -ar 48000 -c:a pcm_s16le "C:\Users\oslan\AppData\Local\Temp\opencode\clean-impact-showcase\music-loop.wav"
```

Expected: ffprobe reports stereo PCM audio at 48 kHz and duration within `0.05s` of the project.

- [ ] **Step 2: Import music and set its mix level**

Choose `music-loop.wav` through `Add music`, wait for the loaded-track label, and fill `Background music volume` with `0.15`.

Expected: the snapshot contains a full-length music track with `gain=0.15`.

- [ ] **Step 3: Export the music control before generating SFX**

Keep `1080p` selected and export as `music-control.mp4`.

Expected: this control has the same narration and visual state as `visual-control.mp4`, plus music, while the snapshot still has no SFX track.

- [ ] **Step 4: Generate the built-in SFX track**

Before clicking, begin recording the exact JSON request body posted to `/api/repurpose/sfx`. Click exact `Generate SFX track`, wait for `SFX track loaded`, and fill `SFX track volume` with `0.45`.

Expected: the snapshot contains a managed `sourcePath`, project-duration SFX, and `gain=0.45`; evidence contains the generated `{ sfx, atMs }` events and their exact timestamps; no Whisper, OpenAI, or external plugin is invoked.

- [ ] **Step 5: Capture the complete timeline**

Click `Fit timeline to window` and save `05-complete-timeline.png` showing clip, caption, overlay, Music, and SFX rows.

### Task 5: Persist, Reopen, Play, And Export

- [ ] **Step 1: Wait for the final autosave**

Poll `GET /api/repurpose/projects/{projectId}` until clips, captions, two overlays, music, SFX, grades, split ratios, and playhead match the editor state. Save this response as `finalSnapshot` in evidence.

- [ ] **Step 2: Reload and reopen from the hub**

Reload the project, assert `Play` becomes enabled, navigate back to the hub, assert both original and showcase links are present, and reopen only the showcase project.

Expected: the same `projectId` and `finalSnapshot` content return after hydration.

- [ ] **Step 3: Verify real playback**

At the start, click `Play` and poll until the playhead, active Face `currentTime`, and preview canvas signature all advance. Click `Pause` and assert time remains stable for 120 ms. Read the real FPS from `finalSnapshot.footageMeta.fps`, move by exact keyboard frames from the start, and capture stable preview canvas data URLs at approximately `2.5s`, `6.25s`, and `7.0s`; these cover the image accent, a clean graded/captioned scene after the four-second image overlay ends and before the video begins, and the video accent.

- [ ] **Step 4: Export the complete project**

Select `1080p`, begin a Playwright download wait, click exact `Export MP4`, race download against the visible `Export failed` alert, save the result as `clean-impact-showcase.mp4`, and wait for the export button to re-enable.

Expected: no export warning/error appears. The unique recorded video request paths exactly equal the unique persisted authoritative set comprising Screen `workingPath`, Face `workingPath`, and the video overlay `sourcePath`; every request has `quality` absent. The image overlay managed-asset URL is requested during preview/export preparation.

- [ ] **Step 5: Validate the MP4**

Run ffprobe, read the MP4 bytes, and serve them in the existing browser context through a temporary same-origin ranged route such as `/__clean-impact-export.mp4`, following `tests/e2e/export.spec.ts`. Do not use `file://`, which would taint comparison canvases. In a second Chrome page, compare the decoded export frame to the captured live preview at the same exact frame numbers, seeking to `(frame + 0.5) / finalSnapshot.footageMeta.fps`. Use the proven parity thresholds: `fullMae < 12`, `captionBandMae < 12`, `fullLargeDiffRatio < 0.02`, and `captionBandLargeDiffRatio < 0.02`.

Expected: H.264 `yuv420p`, 1080x1920, at least one AAC audio stream, Chrome dimensions 1080x1920, duration within `0.05s` of `finalSnapshot.duration`, and all three live-preview/export frame comparisons pass. This validates the grades, split layout, captions, image overlay, and video overlay in the actual MP4 rather than only in persisted JSON.

- [ ] **Step 6: Prove music and SFX are present in the encoded mix**

Decode all three exports to mono float PCM at 48 kHz and apply the same Goertzel/RMS analysis used by `tests/e2e/helpers/audio-analysis.ts`. Compare `visual-control.mp4` to `music-control.mp4`, then `music-control.mp4` to the final export. Align tracks by the best normalized cross-correlation within plus/minus 1,024 samples before subtraction, and measure SFX windows at the exact `atMs` values captured from the SFX POST body.

Expected: visual-control/music-control normalized correlation is greater than `0.50`; their difference has `fullRms > 0.001` and 220 Hz magnitude greater than `0.005`. Music-control/final correlation outside the captured SFX windows is greater than `0.80`, proving narration plus music remained present. Their difference has `fullRms > 0.003`. For each event, search 100 ms windows from `atMs` through `atMs + 1,000 ms`. At the residual peak offset, rendered-source RMS must be at least `95%` of that event's source peak RMS, proving the encoded peak falls inside the source effect's active level set without relying on unstable argmax timing across flat plateaus. The residual/source RMS ratio at that same offset must be between `0.35` and `0.55`, bracketing the configured `0.45` gain. At least one residual peak must exceed `0.006`. This onset-aware comparison accounts for effects whose sample energy attacks after the placement cue and effects with broad equal-energy plateaus while still proving timing, gain, and encoded SFX content above AAC noise.

- [ ] **Step 7: Capture final evidence**

Save `06-export-complete.png`, `07-export-opened.png`, and `08-hub-with-two-projects.png`.

### Task 6: Prove Postconditions And Hand Off

- [ ] **Step 1: Stop only the worktree server and run the mandatory verification gate**

Identify the listener PID on port 3001, verify its command line belongs to this worktree, record it, and stop only that process. Assert port 3000 exactly matches its Task 1 state, including remaining absent when it began absent. Run:

```powershell
npm run verify
```

Expected: Playwright starts and stops its own port-3001 server before `next build`, then typecheck, Vitest, Playwright, and production build all pass. Do not reuse the active dev server because `next build` and `next dev` share `.next`.

- [ ] **Step 2: Restart port 3001 unconditionally**

Whether verification passes or fails, start this worktree's dev server on port 3001 as a detached process, poll `/repurpose-studio` and `/api/repurpose/projects` to HTTP 200, and reopen only the showcase URL. Assert port 3000 still exactly matches its Task 1 listener-or-absence baseline.

- [ ] **Step 3: Recompute protected-file integrity after all mutating operations**

After verification and server restart, recompute size, mtimeMs, and SHA-256 for the MOV, SRT, and existing project JSON in an unconditional finalizer.

Expected: all values exactly match Task 1, even if verification failed.

- [ ] **Step 4: Verify the final project list after all E2E cleanup**

Expected: the API lists the unchanged original project plus the new showcase project. No test project remains. Do not delete either user project.

- [ ] **Step 5: Finalize local evidence**

Write timestamps, `projectId`, project URL, verification result, source-integrity results, browser errors, request assertions, ffprobe output, Chrome decode metadata, audio measurements, and artifact paths to `evidence.json`. Do not place machine-specific evidence or media in Git.

- [ ] **Step 6: Verify repository cleanliness against the baseline**

Run:

```powershell
git status --short
```

Expected: HEAD equals the Task 1 baseline, and status/diff exactly match the Task 1 baseline. No application-code or generated-media changes were introduced.

- [ ] **Step 7: User handoff**

Return the new project URL, MP4 path, screenshot paths, export metadata, and integrity result. Leave the showcase project open on port 3001 for review.
