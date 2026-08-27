# Testing Repurpose Studio

## Prerequisites

- Node.js 20.19.x, Node.js 22.13.x, or Node.js 24+, and npm.
- `ffmpeg` and `ffprobe` available on `PATH`; the ffmpeg build must include `libx265`.
- Python 3.10 or newer (CI uses 3.12) and `uv==0.11.2`, intentionally pinned to the version used to verify the offline SFX lockfile.
- An installed Google Chrome browser. Playwright uses the installed `chrome` channel, so do not download a bundled browser.

## Deterministic media fixtures

Generate the local fixtures once after cloning or whenever the fixture recipe changes:

```sh
npm run fixtures:media
```

The files are written to `tests/fixtures/generated/` and intentionally remain uncommitted.

## Offline SFX engine

Install `uv` and synchronize the engine from its committed lock file before running SFX tests:

```sh
python -m pip install uv==0.11.2
uv sync --frozen --project scripts/sfx-engine
npm test -- tests/components/SfxPanel.test.tsx tests/integration/sfx-engine.test.ts tests/integration/sfx-planner-contract.test.ts tests/server/sfx-project-references.test.ts tests/server/sfx-route.test.ts
```

The engine is local-only. It reads the supplied events JSON and the vendored WAV library; it does not download models or make network requests while rendering.

Within one application process, identical content hashes share one render, each render accepts at most 32 callers, at most two distinct Python renders run concurrently, and at most eight distinct jobs wait in the queue. Completed WAVs use oldest-first retention with a seven-day TTL and 2 GiB cache cap; active render files, persisted project references, and files being validated or streamed by GET are never swept. Newly published finals also receive a conservative 60-second grace so autosave can persist their project reference before budget eviction resumes. Local overrides are available through `REPURPOSE_SFX_MAX_WAITERS_PER_JOB`, `REPURPOSE_SFX_MAX_QUEUED_RENDERS`, `REPURPOSE_SFX_CACHE_TTL_MS`, and `REPURPOSE_SFX_CACHE_MAX_BYTES`.

## Commands

- `npm test` runs all Vitest unit, component, and integration tests once.
- `npm test -- tests/unit` runs the unit-test suite.
- `npm test -- tests/server` runs the Node-only server integration suite.
- `npm test -- tests/components/SfxPanel.test.tsx tests/integration/sfx-engine.test.ts tests/integration/sfx-planner-contract.test.ts tests/server/sfx-project-references.test.ts tests/server/sfx-route.test.ts` verifies client request ownership, the offline renderer, planner allowlist, persisted-reference retention, and the API publication contract.
- `npm run test:watch` runs Vitest in watch mode.
- `npm test -- tests/unit/time-map.smoke.test.ts` runs one test file.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm run test:e2e` starts the application on port 3001 and runs Playwright against installed Desktop Chrome.
- `npm run build` creates the production build.
- `npm run verify` runs typecheck, Vitest, Playwright, and the production build in sequence.

## Actual HEVC acceptance on Windows

The protected local-file acceptance is opt-in and is skipped during ordinary CI and `npm run verify`. Generate fixtures first, close any unrelated server on port 3001, and point the test at the source file:

```powershell
npm run fixtures:media
$env:REPURPOSE_ACTUAL_HEVC_PATH='C:\path\to\protected-hevc.mov'
npm run test:e2e -- tests/e2e/actual-hevc.acceptance.spec.ts --workers=1 --reporter=line
Remove-Item Env:REPURPOSE_ACTUAL_HEVC_PATH
```

The test only reads/uploads the selected source. It records size, last-write time, and SHA-256 before the flow and again from `finally` after project cleanup, then fails if any change is detected. It exercises the actual file through Files, compatibility conversion, a 540p proxy, real decoded-video/canvas transport, a persisted split boundary, reload/reopen, and a bounded authoritative-source export. Evidence is written under `.gstack/qa-reports/repurpose-studio-stabilization-2026-08-21/`; machine-specific JSON and source-derived MP4 files are intentionally gitignored.

Set `REPURPOSE_E2E_REUSE_SERVER=1` only when intentionally testing against a server already listening on port 3001. Otherwise Playwright starts and owns the development server. On the verified Windows machine, ffmpeg selected Intel Quick Sync (`h264_qsv`) for the actual 4K60 conversion; the compatibility pipeline may use its software fallback on other hardware.

Vitest defaults to jsdom. Every server test under `tests/server/` and every other Node-only integration test must opt in at the top of its file with:

```ts
// @vitest-environment node
```

Playwright's HTML report is written to `.gstack/qa-reports/playwright-html/`; failure traces, videos, and screenshots are retained in `test-results/`.
