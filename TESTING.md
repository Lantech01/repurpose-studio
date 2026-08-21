# Testing Repurpose Studio

## Prerequisites

- Node.js 20.19.x, Node.js 22.13.x, or Node.js 24+, and npm.
- `ffmpeg` and `ffprobe` available on `PATH`; the ffmpeg build must include `libx265`.
- Python 3.10 or newer and `uv` for the optional SFX engine and its future integration tests.
- An installed Google Chrome browser. Playwright uses the installed `chrome` channel, so do not download a bundled browser.

## Deterministic media fixtures

Generate the local fixtures once after cloning or whenever the fixture recipe changes:

```sh
npm run fixtures:media
```

The files are written to `tests/fixtures/generated/` and intentionally remain uncommitted.

## Commands

- `npm test` runs all Vitest unit, component, and integration tests once.
- `npm test -- tests/unit` runs the unit-test suite.
- `npm test -- tests/server` runs the Node-only server integration suite once those tests are present.
- `npm run test:watch` runs Vitest in watch mode.
- `npm test -- tests/unit/time-map.smoke.test.ts` runs one test file.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm run test:e2e` starts the application on port 3001 and runs Playwright against installed Desktop Chrome.
- `npm run build` creates the production build.
- `npm run verify` runs typecheck, Vitest, Playwright, and the production build in sequence.

Vitest defaults to jsdom. Every server test under `tests/server/` and every other Node-only integration test must opt in at the top of its file with:

```ts
// @vitest-environment node
```

Playwright's HTML report is written to `.gstack/qa-reports/playwright-html/`; failure traces, videos, and screenshots are retained in `test-results/`.
