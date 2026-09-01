# Repurpose Studio Stabilization Task 12 QA Report

Result: **PASS**

- Date: 2026-08-26
- Scope: exhaustive editor QA and actual-file HEVC acceptance
- Worktree: local `fix-stabilize-editor` worktree
- Branch: `fix/stabilize-editor`
- Clean base at start: `c0518d767eb2b22bbecd7fd83e78bba1b1380dc9`
- Fix commits: `c564c8f`, `d5246c8`; acceptance harness: `355e83f`; final QA/font/onboarding changes are included in the current local commit
- Application URL: `http://127.0.0.1:3001/repurpose-studio`
- Port 3000: intentionally untouched

## Environment

| Component | Version / configuration |
|---|---|
| OS | Windows, `win32` |
| Node.js / npm | `v24.14.1` / `11.11.0` |
| Next.js | `15.5.24` |
| Chrome | `151.0.7922.174`, installed channel used by Playwright |
| ffmpeg / ffprobe | `9.0-full_build-www.gyan.dev` |
| Python / uv | `3.12.10` / `0.11.2` |
| Browser codec setup | `PlatformHEVCDecoderSupport` disabled to force the compatibility path |

## Automated Gates

| Command | Started | Ended | Duration | Exit | Summary |
|---|---|---|---:|---:|---|
| `npm run fixtures:media` | 2026-08-26T17:25:41.455-03:00 | 2026-08-26T17:25:56.123-03:00 | 14.668s | 0 | Generated eight deterministic media fixtures. |
| `npm run verify` (final) | 2026-08-26 | 2026-08-26 | ~2.5m | 0 | TypeScript passed; 40 Vitest files passed with 556 tests passed and 3 skipped; Playwright passed 4 tests with the local-file test skipped by default; production build passed. |
| Actual-file Playwright acceptance (cold) | 2026-08-26T20:07:35.850Z | 2026-08-26T20:08:37.445Z | 61.595s | 0 | Cold HEVC conversion, proxy, transport, reopen, export, Chrome decode, and source-integrity checks passed. |
| Actual-file acceptance revalidation | 2026-08-26T23:26:09.388Z | 2026-08-26T23:27:18.578Z | 69.190s | 0 | Warm-cache run additionally proved real video/canvas advancement, a 1.0005s source discontinuity, and source integrity from `finally`. |
| Actual-file final revalidation | 2026-08-27T02:20:28.352Z | 2026-08-27T02:21:25.045Z | 56.693s | 0 | Revalidated the protected MOV after bundled-font and onboarding changes; stable transport proxy, exact authoritative export paths, boundary, Chrome decode, audio, cleanup, and post-cleanup source integrity passed. |
| Full user-project export | 2026-08-26 | 2026-08-26 | 10.3s | 0 | Exported the current 10.13s user edit with captions and SFX: H.264/AAC, 1080x1920, 608 frames, zero proxy requests, zero page errors. |
| `editor-surfaces.spec.ts` | 2026-08-26 | 2026-08-26 | 35.3s | 0 | Picker/drop/paste, keyboard, split, trim, loop/I-O, captions, music, SFX, reopen, and hub delete passed. |
| `export.spec.ts` | 2026-08-26 | 2026-08-26 | 25.2s | 0 | Direct preview/export pixel comparison at three frames, H.264/AAC decode, narration, music, and timed SFX PCM checks passed. |
| `hevc-editor.spec.ts` | 2026-08-26 | 2026-08-26 | 18.8s | 0 | HEVC regression and 9:16 containment at 1600x1000, 1280x600, and 768x1024 passed. |
| `useVideoProxy.test.tsx` | 2026-08-26 | 2026-08-26 | 2.13s | 0 | 11 tests passed, including deferred proxy activation while playing and activation after pause. |
| Caption fonts/onboarding component tests | 2026-08-26 | 2026-08-26 | <5s | 0 | Bundled-font warming, Outfit/Inter options, transcript-first guidance, source readiness, inspector order, and always-visible overlay import passed. |
| `npm run lint` | 2026-08-26 | 2026-08-26 | <1m | 0 | Zero errors; one pre-existing `@next/next/no-img-element` warning in unmodified `GhostOverflowLayer.tsx`. |
| `npm audit --omit=dev` | 2026-08-26 | 2026-08-26 | <1s | 0 | 0 vulnerabilities. |
| `npm audit` | 2026-08-26 | 2026-08-26 | <1s | 0 | 0 vulnerabilities. |
| `git diff --check` | 2026-08-26 | 2026-08-26 | <1s | 0 | No whitespace errors; Git printed Windows LF-to-CRLF notices only. |
| Independent diff review | 2026-08-26 | 2026-08-26 | Two passes | 0 | Final re-review returned PASS with no findings after reconnect, strict font loading, exact export-source evidence, cleanup ordering, and transport stability were hardened. |

## Issues

| ID | Severity | Finding | RED evidence | Fix | GREEN evidence | Commit | Status |
|---|---|---|---|---|---|---|---|
| QA-01 | Medium | The actual source reports a timestamp-derived average of 59.9699 fps while ffmpeg preserves 598 frames at nominal 60 fps. The fixed 0.01 fps validator rejected that valid master. | Actual cold conversion ended in `COMPATIBILITY_VALIDATION_FAILED`; source/output delta was about 0.0301 fps. | Use a bounded 0.1% tolerance, never below 0.01 fps. | New 4K60 regression passes; invalid 30.04 vs 30 fps still fails; 79 cache tests plus the actual conversion pass. | `c564c8f` | Fixed |
| QA-02 | Medium | On a tall editor viewport, `height: 100%` plus the 340px width cap distorted the preview to 340x656 instead of 9:16. | Initial actual preview screenshots measured 340x656 while export was 540x960. | Size from the tightest container width, container height converted to 9:16, and 340px cap. | Actual canvas is 340x604.4375 (9:16 within pixel rounding); regular HEVC E2E asserts the ratio. | `d5246c8` | Fixed |
| QA-03 | Medium | Independent preview/export baselines could both pass while representing different frames, so they did not prove parity. | The old baselines represented frame-boundary times around 1.4s and visibly differed. | Capture preview frames 15/45/75, seek export halfway into the corresponding encoded frame, and compare RGB pixels directly at 1080x1920. | All three frames passed MAE <12 and large-difference ratio <2%; observed maxima were 7.4762 and 0.41%. | Task 12 final QA | Fixed |
| QA-04 | Medium | Every advertised caption face requested a missing `/fonts/...` asset, produced 11 HTTP 404s, and silently rendered a fallback face. | Instrumented real-project load recorded the exact failed font URLs. | Bundle OFL Fontsource packages, warm their CSS faces through `document.fonts`, reject an absent face instead of silently accepting fallback, preserve persisted TikTok ids, and add Outfit and Inter. | TikTok Sans, Anton, DM Sans, Fraunces, Outfit, and Inter all load; browser verification recorded zero failed responses, the collector no longer allowlists font 404s, and a failed warm-up is tested as retriable. | Task 12 final QA | Fixed |
| QA-05 | Medium | An empty editor showed the optional Files library before Sources, so users could import media without creating a timeline and perceive Play as broken. | New projects stayed at duration zero while the first visible Inspector action was generic Files import. | Put Sources first, explain the transcript-first sequence, and keep it expanded until raw words plus usable Screen and Face paths are present. | Component tests and desktop/tablet browser checks prove the guidance, order, disabled Play state, and restored `reconnect:` handling. | Task 12 final QA | Fixed |
| QA-06 | Low | The first manual full-export harness waited for a Playwright download while Chrome used the native save picker, creating a false 600s timeout. | No app error appeared because export had reached the picker path. | Force the anchor-download path in automation, as the committed E2E tests already do, and report progress/network state. | The real project downloaded in 10.3s and decoded successfully. | Diagnostic harness only | Fixed |
| QA-07 | Medium | Tightening Sources readiness initially hid Add media in a newly closed Re-import fold. | The full export E2E timed out waiting for its file chooser. | Keep overlay Add media outside the collapsible source-reimport controls. | Focused component regression and `export.spec.ts` passed; the final full gate passed. | Task 12 final QA | Fixed |

No critical or high defects remained. Test-harness races found while building the dogfood flow were corrected without product changes.

## Source Integrity

The actual source was read and uploaded only. The acceptance test hashes and stats it before the flow and from `finally` after project cleanup, so integrity is checked even when another assertion fails or cleanup behavior changes.

| Property | Before | After |
|---|---|---|
| Path | Protected local MOV (path retained only in ignored evidence) | Same |
| Size | 60,010,280 bytes | 60,010,280 bytes |
| Last write (UTC) | `2026-08-12T14:38:45.5486898Z` | Unchanged |
| SHA-256 | Recorded in ignored local evidence | Same |

## Actual Media

| Field | Source | Working master | Preview proxy |
|---|---|---|---|
| Container | MOV/MP4 family | MP4 | MP4 |
| Video | HEVC Main, `hvc1`, `yuv420p`, 3840x2160 | H.264 High, `yuv420p`, 3840x2160 | H.264 High, `yuv420p`, 960x540 |
| Frame rate | 59.9699 fps average, 60 fps nominal | 60 fps, 598 frames | 60 fps, 598 frames |
| Audio | AAC LC, 48 kHz, stereo | AAC LC, 48 kHz, stereo | AAC LC, 48 kHz, stereo |
| Duration | 9.970s | 9.968s | 9.968s |
| Size | 60,010,280 bytes | 63,688,580 bytes | 3,893,568 bytes |
| Encoder | iPhone source | `h264_qsv` hardware path | `h264_qsv` hardware path |

Cold Files import reached `Pronto` in 20.693s from picker selection; the final warm-cache revalidation took 4.765s. The same content-addressed original and compatibility master were reused when the MOV was selected as Face footage. During paused editing both base source elements used `quality=proxy`; the source URL remained identical across five Play/Pause cycles. The dedicated proxy unit suite proves a newly ready proxy is deferred while playing and activated after pause. Export issued ten requests spanning exactly the expected Screen and Face/video-overlay working paths, with no proxy-quality or unexpected path.

## Actual HEVC Acceptance

The opt-in command was:

```powershell
$env:REPURPOSE_ACTUAL_HEVC_PATH='C:\path\to\protected-hevc.mov'
npm run test:e2e -- tests/e2e/actual-hevc.acceptance.spec.ts --workers=1 --reporter=line
```

Observed UI phases: `Copiando arquivo`, `Inspecionando midia`, `Verificando compatibilidade no Chrome`, `Convertendo HEVC para H.264`, and `Pronto`. No generic decode error appeared.

Evidence passed for Files import and placement as a video overlay, reuse as Face footage, proxy publication, five Play/Pause cycles, start/middle/end seeks, autosave, reload, hub reopen, bounded export, Chrome decode, ffprobe, full-quality export requests, and source integrity. Every transport cycle asserted that the active Face `HTMLVideoElement.currentTime` advanced, the composited canvas changed, the video paused afterward, and its proxy URL stayed stable. After export verification, reverse-order splits and deletion of the middle segment created a 1.0005017s source-time discontinuity at output time 1.0005017s; decoded media time matched the outgoing source one frame before and the incoming source exactly at that boundary.

### Export

| Field | Result |
|---|---|
| Artifact | `actual-hevc-layered-1080p.mp4` |
| Container | MP4 (`isom`) |
| Video | H.264 High, `yuv420p`, 1080x1920, 180 frames, 59.9699 fps |
| Audio | AAC LC, 48 kHz, stereo |
| Duration | 3.008s |
| Size | 12,229,439 bytes |
| Chrome decode | 1080x1920, 3.008s |
| Actual-file audio RMS | 0.096734, above the 0.001 signal floor |

The complete current user project was also exported outside the bounded acceptance fixture. Its edited timeline is 10.13s (two clips after user edits), and the resulting 39,184,766-byte MP4 contains 608 H.264 frames at 59.9699 fps plus AAC stereo audio. Chrome decoded it at 1080x1920 for 10.138417s. ffmpeg measured mean audio volume -24.6 dB and peak -4.8 dB. The export requested only authoritative media, emitted no page error, and completed in 10.3s with the new bundled caption fonts.

## Visual Parity

The deterministic layered case now compares preview and decoded export pixels directly at frames 15, 45, and 75. Export seeks target the middle of each encoded frame to avoid timestamp-boundary ambiguity. Both images are rasterized at 1080x1920 and evaluated globally and across the known caption region. Thresholds are MAE <12 and ratio of pixels with RGB mean difference >24 below 2%.

| Time | Full MAE | Caption-band MAE | Full large-diff ratio | Caption-band ratio | Result |
|---:|---:|---:|---:|---:|---|
| 0.5s | 7.4762 | 6.4813 | 0.30% | 0.41% | Pass |
| 1.5s | 7.2641 | 6.4299 | 0.32% | 0.33% | Pass |
| 2.5s | 3.7360 | 3.1287 | 0.13% | 0.40% | Pass |

The actual protected-file pairs remain a manual geometry/content check because the preview uses a lower-resolution proxy. They are supplementary to, not a substitute for, the automated deterministic all-layer comparison.

| Layer | Expected | Actual preview/export | Result |
|---|---|---|---|
| Canvas | 9:16 without CSS distortion | 340x604.4375 preview; 540x960 evidence PNG; 1080x1920 export | Pass |
| Split seam | Same 50% screen/face split | Seam remains centered in all three pairs | Pass |
| Face crop | Same source-time face framing | Gesture, crop, and vertical placement match at 0.5s, 1.5s, and 2.5s | Pass |
| Video overlay | Same output-time placement and muted video layer | Full-width upper layer remains aligned in all three pairs | Pass |
| Color | No unintended grade or range shift | Natural BT.709 appearance is consistent between proxy and export | Pass |
| Caption | Same text, active-word timing, placement, font, stroke, and color | Direct caption-region MAE was at most 6.4813 with at most 0.41% large differences | Pass |
| Image/video fixture layers | Same blocks, crop, seam, and z-order | Direct full-frame comparison passed at all three output times | Pass |

Actual-file frame pairs are retained locally and intentionally excluded from Git because they contain protected source imagery:

| Time | Local preview | Local decoded export |
|---|---|---|
| ~0.5s | `07-preview-0.5s.png` | `export-0.5s.png` |
| ~1.5s | `08-preview-1.5s.png` | `export-1.5s.png` |
| ~2.5s | `09-preview-2.5s.png` | `export-2.5s.png` |

### Deterministic PCM Parity

| Signal | Expected | Actual | Result |
|---|---|---:|---|
| Narration at 440 Hz | Present and >0.01 | Layered magnitude 0.124001 | Pass |
| Music at 220 Hz | At least 4x base control | Base 0.00000588; layered 0.123989 | Pass |
| Timed SFX residual | Event RMS >0.01 | 0.073403 | Pass |
| SFX full residual | Full RMS >0.005 | 0.046505 | Pass |
| Layered output | Non-silent | Full RMS 0.132823 | Pass |

## Console And Request Health

- Unexpected browser console errors: 0.
- Unexpected page errors: 0.
- Unexpected HTTP errors: 0.
- Unexpected request failures: 0.
- Export failures/warnings: 0.
- Caption-font HTTP errors: 0; all offered faces are bundled locally.
- Raw evidence retains allowlisted optional demo-asset 404s and navigation/media `ERR_ABORTED` lifecycle events; the collector verifies none are unexpected.

## Local Screenshots

The ignored `screenshots/` directory contains the before-import hub, conversion, proxy-ready, layered preview, reopened project, successful export, decoded export, and three preview/export frame pairs. These files remain available for local review but are not commit candidates because they contain protected source imagery.

## Acceptance Checklist

- [x] Start from hub and capture before-import evidence.
- [x] Load deterministic raw and final transcript.
- [x] Import actual MOV in Files and place it as a video overlay.
- [x] Reuse actual MOV as footage through content-addressed ingest.
- [x] Observe conversion without a generic decode error.
- [x] Build, inspect, and pause-swap the 540p preview proxy.
- [x] Verify Play/Pause five times with real video-time/canvas advancement and stable proxy URLs.
- [x] Persist a real split and verify decoded source-time mapping around its boundary.
- [x] Exercise keyboard transport, frame step, boundary crossing, split, trim, in/out, and loop.
- [x] Exercise captions, image/video overlays, Files image/audio, picker/drop/paste, music, and offline SFX.
- [x] Exercise hub create/open/delete, autosave, reload, reopen, and Play/Pause.
- [x] Export a bounded 3s 1080x1920 MP4 from the authoritative working source.
- [x] Open the export in Chrome and verify it with ffprobe.
- [x] Inspect three preview/export frame pairs and deterministic caption/layer snapshots.
- [x] Verify deterministic narration/music/SFX PCM and actual-file audio signal.
- [x] Run all automated gates and both dependency audits.
- [x] Recheck source size, timestamp, and SHA-256 unchanged after test-project cleanup.
- [x] Export the complete current user project with captions/SFX and authoritative source requests.
- [x] Bundle every advertised caption family, including Outfit and Inter, with zero font 404s.
- [x] Make the transcript-first empty-project path explicit without changing the editing model.

## Residual Risks

- Next.js development mode warns that future versions will require `allowedDevOrigins` for `127.0.0.1`. This does not affect the successful production build.
- Rapid page navigation while media streams are being aborted can make the Next.js dev server log `ERR_INVALID_STATE: Controller is already closed`. Chrome recorded no page, HTTP, or unexpected request error, and the production build passed; this remains dev-only framework noise to monitor after a Next.js upgrade.
- The protected actual-file test is opt-in and therefore skipped by ordinary `npm run verify`; this report records the separate fresh run. Deterministic HEVC remains in the default suite.
- The real run selected Intel Quick Sync (`h264_qsv`). Software fallback is covered by the compatibility tests but was not the winning encoder for this machine.
- ESLint retains one pre-existing `<img>` optimization warning in unmodified `GhostOverflowLayer.tsx`; there are no lint errors.
- CodeRabbit CLI could not run because WSL is not installed on this host; an independent two-pass read-only diff review completed with a final PASS and no findings.

## Artifacts

- Machine-readable local run record: `actual-hevc-evidence.json` (gitignored; contains machine-specific paths)
- Actual full-quality export: `actual-hevc-layered-1080p.mp4` (gitignored protected-media derivative)
- Captured preview proxy: `actual-hevc-preview-proxy.mp4` (gitignored protected-media derivative)
- Protected-source screenshots: local ignored `screenshots/` directory
