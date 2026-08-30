# Local Automatic Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add button-driven, fully local Face-audio transcription with Portuguese/automatic language modes, NVIDIA CUDA preference, CPU fallback, safe timeline application, captions, cancellation, and durable result caching.

**Architecture:** Browser-safe modules own transcript parsing, API contracts, and pure application rules. A dedicated Node runtime coordinates observer-scoped asynchronous jobs over focused cache/process modules, while a pinned `faster-whisper` Python engine performs local inference. The UI keeps job coordination separate from the shared transcript-application decision so automatic and manual transcripts use the same non-destructive store action.

**Tech Stack:** Next.js 15 Node routes, React 19, TypeScript, Zustand, Vitest, Playwright, FFmpeg/ffprobe, Python 3.10+, `uv`, `faster-whisper==1.2.1`, CTranslate2 CUDA/CPU.

**Spec:** `docs/superpowers/specs/2026-08-28-local-automatic-transcription-design.md`

**Commit policy:** Do not commit during execution unless the user explicitly requests it. End each task with a status/diff checkpoint instead of an automatic commit.

---

## File Structure

### New browser-safe modules

- `lib/repurpose/transcript-ingest.ts`: strict SRT/JSON parsing and shared `Word[]` normalization.
- `lib/repurpose/transcript-application.ts`: untouched-timeline detection, candidate clip creation, and dual-source bounding.
- `lib/repurpose/transcription-contract.ts`: exact request/status/result/error contracts shared by routes and client.

### New server modules

- `lib/repurpose/transcription-cache.server.ts`: content-addressed result cache and atomic publication.
- `lib/repurpose/transcription-process.server.ts`: hash verification, inspection, FFmpeg extraction, Python execution, deadlines, and cleanup.
- `lib/repurpose/transcription-runtime.server.ts`: one shared process, observer leases, polling state, joining, and cancellation.
- `app/api/repurpose/transcription/jobs/route.ts`: thin POST route.
- `app/api/repurpose/transcription/jobs/[id]/route.ts`: thin GET/DELETE route.

### New client modules

- `app/repurpose-studio/_components/useTranscriptApplication.ts`: common automatic/manual apply decision and pending candidate ownership.
- `app/repurpose-studio/_components/TranscriptApplyDialog.tsx`: preserve/rebuild/apply-later confirmation.
- `app/repurpose-studio/_components/useTranscription.ts`: POST/poll/DELETE lifecycle and stale-result protection.
- `app/repurpose-studio/_components/TranscriptionControls.tsx`: language, progress, cancel, retry, and completion UI.

### New Python engine

- `scripts/transcription-engine/pyproject.toml`: pinned engine dependencies.
- `scripts/transcription-engine/uv.lock`: frozen dependency graph.
- `scripts/transcription-engine/engine.py`: model download/load, inference, progress, and CUDA fallback.
- `scripts/transcription-engine/transcribe.py`: strict CLI and atomic JSON output.
- `scripts/transcription-engine/tests/test_engine.py`: deterministic tests with mocked model/download adapters.

## Task 1: Shared Transcript Parsing and API Contracts

**Files:**
- Create: `lib/repurpose/transcript-ingest.ts`
- Create: `lib/repurpose/transcription-contract.ts`
- Create: `tests/unit/transcript-ingest.test.ts`
- Create: `tests/unit/transcription-contract.test.ts`
- Modify: `lib/repurpose/ingest.ts:65-80,432-453`

- [ ] **Step 1: Write failing transcript-ingest tests**

Cover valid JSON/SRT, whitespace normalization, malformed SRT timecodes, empty text, `NaN`/infinite/negative/reversed timestamps, non-monotonic starts, duration tolerance, valid automatic no-speech, and invalid empty manual input.

Target public API:

```ts
export interface RawWordsFile {
  text: string;
  words: Word[];
}

export function normalizeTranscriptWords(
  value: unknown,
  options: { allowEmpty: boolean; durationSec?: number }
): Word[];

export function parseRawWordsFile(
  value: unknown,
  options?: { durationSec?: number }
): RawWordsFile;

export function parseSrtWords(
  source: string,
  options?: { durationSec?: number }
): RawWordsFile;

export function srtToPlainText(source: string): string;
```

- [ ] **Step 2: Write failing transcription-contract tests**

Assert exact-key request parsing, UUID validation, `pt | auto`, all phases/states, state-dependent nullable fields, progress in `[0,1] | null`, safe errors, completed result validation, 16 MiB/100,000-word limits, and rejection of unknown fields.

```ts
export type TranscriptionLanguage = "pt" | "auto";
export type TranscriptionPhase =
  | "preparing"
  | "extracting-audio"
  | "downloading-model"
  | "transcribing"
  | "finalizing";

export interface TranscriptionResult {
  words: Word[];
  language: string;
  languageProbability: number | null;
  device: "cuda" | "cpu";
}

export interface StartTranscriptionRequest {
  observerId: string;
  path: string;
  language: TranscriptionLanguage;
}

export interface StartTranscriptionResponse { jobId: string }

export interface TranscriptionErrorResponse {
  error: TranscriptionError;
}

export type TranscriptionWarning = {
  code: "TRANSCRIPTION_GPU_FALLBACK";
  message: "GPU indisponível; continuando na CPU.";
};

export type TranscriptionStatus =
  | {
      jobId: string;
      state: "queued" | "running";
      phase: TranscriptionPhase;
      progress: number | null;
      device: "cuda" | "cpu" | null;
      warning: TranscriptionWarning | null;
      result: null;
      error: null;
    }
  | {
      jobId: string;
      state: "completed";
      phase: "finalizing";
      progress: 1;
      device: "cuda" | "cpu";
      warning: TranscriptionWarning | null;
      result: TranscriptionResult;
      error: null;
    }
  | {
      jobId: string;
      state: "failed" | "cancelled";
      phase: TranscriptionPhase;
      progress: number | null;
      device: "cuda" | "cpu" | null;
      warning: TranscriptionWarning | null;
      result: null;
      error: TranscriptionError;
    };
```

Export `parseStartTranscriptionRequest`, `parseStartTranscriptionResponse`,
`parseTranscriptionStatus`, `parseTranscriptionResult`, and this HTTP-aware
decoder:

```ts
parseTranscriptionErrorResponse(
  value: unknown,
  status: number
): TranscriptionErrorResponse;
```

Define
`TranscriptionErrorCode`, `TranscriptionError`, and one Portuguese message map
for all public codes:

```text
TRANSCRIPTION_INVALID_REQUEST
TRANSCRIPTION_PAYLOAD_TOO_LARGE
TRANSCRIPTION_OBSERVER_CONFLICT
TRANSCRIPTION_NOT_FOUND
TRANSCRIPTION_SOURCE_INVALID
TRANSCRIPTION_SOURCE_CHANGED
TRANSCRIPTION_SOURCE_TOO_LONG
TRANSCRIPTION_PREPARATION_TIMEOUT
TRANSCRIPTION_AUDIO_MISSING
TRANSCRIPTION_AUDIO_EXTRACTION_FAILED
TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT
TRANSCRIPTION_ENGINE_UNAVAILABLE
TRANSCRIPTION_MODEL_DOWNLOAD_FAILED
TRANSCRIPTION_SETUP_TIMEOUT
TRANSCRIPTION_ENGINE_FAILED
TRANSCRIPTION_INVALID_OUTPUT
TRANSCRIPTION_BUSY
TRANSCRIPTION_CANCELLED
TRANSCRIPTION_TIMEOUT
```

The runtime/routes select a code, but all public messages come from this map.
Never place process stderr or a local path in `message`.
`parseTranscriptionErrorResponse` rejects unknown keys and rejects a code whose
HTTP status is not in this fixed table. It accepts `number` so callers pass the
actual `Response.status` without a cast, then internally rejects unsupported
status numbers before validating the status/code pair:

```text
400 INVALID_REQUEST | SOURCE_INVALID | SOURCE_TOO_LONG | AUDIO_MISSING
404 NOT_FOUND
409 OBSERVER_CONFLICT | SOURCE_CHANGED
413 PAYLOAD_TOO_LARGE
429 BUSY
500 AUDIO_EXTRACTION_FAILED | ENGINE_FAILED | INVALID_OUTPUT
503 ENGINE_UNAVAILABLE | MODEL_DOWNLOAD_FAILED
504 PREPARATION_TIMEOUT | AUDIO_EXTRACTION_TIMEOUT | SETUP_TIMEOUT | TIMEOUT
```

Each short name in the table has the `TRANSCRIPTION_` prefix in JSON. A
cancelled job is represented by the successful GET status union, not a non-2xx
response. Contract tests exercise every status/code pair and reject mismatches.

- [ ] **Step 3: Run the tests and confirm the expected failure**

Run:

```powershell
npm test -- tests/unit/transcript-ingest.test.ts tests/unit/transcription-contract.test.ts
```

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement strict parsing and contract decoders**

Keep parsing browser-safe. Reject malformed SRT blocks instead of turning bad timestamps into zero. Normalize only surrounding whitespace; preserve punctuation. Use a small timestamp tolerance, for example `0.25` seconds, only when `durationSec` is supplied.

Move `RawWordsFile` and `parseRawWordsFile` out of `ingest.ts`; update imports rather than keeping duplicate validators. Do not add a schema dependency.

- [ ] **Step 5: Run focused tests**

Run the command from Step 3.

Expected: both files PASS.

- [ ] **Step 6: Check task diff**

Run `git diff --check` and inspect `git status --short`. Do not commit.

## Task 2: Pure Timeline Applicability and Clip Bounding

**Files:**
- Create: `lib/repurpose/transcript-application.ts`
- Create: `tests/unit/transcript-application.test.ts`
- Modify: `lib/repurpose/store.ts:310-385,1804-1834`
- Modify: `app/repurpose-studio/_components/naming.ts:89-103`
- Modify: `tests/unit/video-timeline-bootstrap.test.ts`

- [ ] **Step 1: Write failing pure-helper tests**

Cover:

- empty clips + empty words is untouched;
- exact `VIDEO_TIMELINE_CLIP_ID` bootstrap is untouched, including non-temporal styling;
- trim, split, duplicate, reorder, deletion, transcript words, and transcript clips are edited;
- effective duration is the shorter positive Screen/Face inspection duration;
- generated clips wholly outside the shared duration are removed;
- a boundary clip is trimmed and its occurrence ranges are intersected;
- full raw words remain unchanged;
- no overlapping speech produces an explicit non-applicable result.

Target API:

```ts
export function effectiveVideoTimelineDuration(meta: FootageMeta | null): number | null;

export function isUntouchedVideoTimeline(input: {
  clips: readonly Clip[];
  words: readonly Word[];
  effectiveDuration: number | null;
}): boolean;

export function buildTranscriptCandidate(input: {
  words: Word[];
  finalTranscript?: string;
  maxSourceDuration?: number;
}):
  | { kind: "ready"; clips: Clip[]; stats: EditStats | null }
  | { kind: "no-shared-speech" };
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
npm test -- tests/unit/transcript-application.test.ts tests/unit/video-timeline-bootstrap.test.ts
```

Expected: new helper imports fail.

- [ ] **Step 3: Implement the pure helper module**

Reuse `buildClipsFromIngest` for automatic raw words. Use `buildShortWithStats` only when a manual final transcript is supplied. Bound clips after construction, update source ranges/occurrences, and leave timeline layout to the store.

Move the effective-duration logic to this module and import it from the store. Replace naming's duplicate bootstrap structure check with `isUntouchedVideoTimeline` or a narrow helper from the same module.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.

Expected: PASS with existing bootstrap behavior unchanged.

- [ ] **Step 5: Check task diff**

Run `git diff --check`; inspect changed exports and imports. Do not commit.

## Task 3: Atomic Transcript Store Action

**Files:**
- Modify: `lib/repurpose/store.ts:731-899,915-1046,1364-1433,1982-2005,2883-2890,3220-3266`
- Modify: `tests/unit/transcript-application.test.ts`

- [ ] **Step 1: Add failing store-action tests**

Create realistic state with clips, words, caption overrides, overlays, markers, SFX, music, grades, selections, deleted words, playhead, in/out, and history. Prove:

- `preserve-cuts` leaves every clip and clip-local visual field unchanged;
- `rebuild` replaces clips and discards old clip-local fields;
- both modes create exactly one Undo step and Redo restores the application;
- words/deleted indices/selections/captions update atomically;
- new caption blocks do not inherit old text/style overrides;
- overlays/markers/music/media assets survive, including overlays and markers
  beyond the new duration at exactly their previous timestamps;
- rebuild clears SFX, applies the candidate `editStats`, clamps playhead/range,
  and preserve-cuts changes none of those fields;
- rebuild clears `overlayDeleteStash` behaviorally, while preserve-cuts retains it;
- Undo restores existing editable snapshot fields but not SFX, `editStats`, transient bounds, or the private stash.

Target action:

```ts
applyTranscript: (input: {
  words: Word[];
  mode: "preserve-cuts" | "rebuild";
  rebuiltClips?: Clip[];
  editStats?: EditStats | null;
}) => void;
```

- [ ] **Step 2: Run the failing store tests**

```powershell
npm test -- tests/unit/transcript-application.test.ts
```

Expected: FAIL because `applyTranscript` does not exist.

- [ ] **Step 3: Extract one caption-block builder with an override policy**

Refactor the existing per-kept-clip chunking into a private pure helper:

```ts
function buildCaptionBlocksForState(input: {
  words: Word[];
  clips: Clip[];
  deletedWordIndices: number[];
  style: CaptionStyle;
  previousBlocks?: CaptionBlock[];
}): CaptionBlock[];
```

Ordinary `rebuildCaptionBlocks` passes `previousBlocks`; transcript replacement omits it so blocks are fresh.

- [ ] **Step 4: Implement `applyTranscript` as one mutation**

Call `commitHistory()` once, compute clips/duration/blocks before `set`, and apply one patch. Do not call `setClips` or `setWords`. In rebuild mode clear `overlayDeleteStash`, `selectedClipId`, and SFX. Set rebuilt `editStats` to `input.editStats ?? null`: automatic raw transcription passes `null`, while a manual final-transcript candidate passes its newly computed stats. Preserve-cuts leaves the current `editStats` unchanged. In both modes clear selected words/caption block and stale deletion indices.

- [ ] **Step 5: Run focused tests**

```powershell
npm test -- tests/unit/transcript-application.test.ts tests/unit/video-timeline-bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run store regression tests**

```powershell
npm test -- tests/unit/video-timeline-bootstrap.test.ts tests/components/SfxPanel.test.tsx tests/components/RepurposeEditor.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Check task diff**

Run `git diff --check`; confirm no unrelated store refactor. Do not commit.

## Task 4: Safe Manual Transcript Application and Persistence

**Files:**
- Create: `app/repurpose-studio/_components/useTranscriptApplication.ts`
- Create: `app/repurpose-studio/_components/TranscriptApplyDialog.tsx`
- Modify: `app/repurpose-studio/_components/SourcesPanel.tsx:23-204,206-410,562-637`
- Modify: `app/repurpose-studio/_components/useProjectPersistence.ts:848-1036`
- Modify: `tests/components/SourcesPanel.test.tsx`
- Modify: `tests/components/project-persistence.test.tsx`
- Modify: `tests/components/useProjectPersistence.test.tsx`

- [ ] **Step 1: Write failing component tests for manual imports**

Cover strict JSON/SRT errors without mutation, source-less manual rebuild, automatic application to an untouched timeline, edited-timeline dialog, preserve cuts, rebuild warning, apply later, final-transcript matching from store words, project switch invalidation, overlays surviving replacement, empty engine speech versus `no-shared-speech`, and an apply-later candidate after Screen duration changes.

- [ ] **Step 2: Write failing persistence tests**

Prove applied words, clips, enabled captions, and fresh blocks save/reopen. Prove no pending candidate, dialog state, observer id, progress, or cache key enters `ProjectSnapshot`. Harden hydration so malformed persisted words do not reach the store.

- [ ] **Step 3: Run tests and verify failure**

```powershell
npm test -- tests/components/SourcesPanel.test.tsx tests/components/project-persistence.test.tsx tests/components/useProjectPersistence.test.tsx
```

Expected: FAIL on old permissive/destructive behavior.

- [ ] **Step 4: Implement `useTranscriptApplication`**

The hook accepts validated candidates from manual or automatic sources, evaluates untouched state at apply time, waits for both sources only for automatic candidates, and exposes one pending dialog model:

```ts
type TranscriptOffer =
  | {
      kind: "ready";
      words: Word[];
      clips: Clip[];
      stats: EditStats | null;
      origin: "automatic" | "manual";
    }
  | {
      kind: "no-shared-speech";
      origin: "automatic";
    };

offerCandidate(candidate: TranscriptOffer): void;
applyPreservingCuts(): void;
applyRebuilding(): void;
applyLater(): void;
reopenPending(): void;
clearPending(): void;
```

Expose `pendingCandidate` and `dialogOpen`. `applyLater()` closes the dialog but
retains the candidate in memory; `reopenPending()` opens that same candidate
without another API call. `clearPending()` runs on project/Face change. Capture
`projectEpoch` and Face original path with pending automatic results and
re-evaluate when Screen becomes ready. Tests must count POST calls and prove a
same-session reopen performs none. After a page reload, clicking Transcribe may
POST again and receive the durable cache hit as specified.

`no-shared-speech` sets a presentation notice and performs no store mutation or
dialog offer; it is distinct from the engine returning zero words, which reports
ordinary no-speech. Retain full validated automatic words with a ready pending
offer. Immediately before either apply action, rerun `buildTranscriptCandidate`
against the current positive Screen/Face effective duration and current untouched
state. If Screen changed while deferred, use its current duration; if a source is
not ready, keep the offer pending; if rebounding now yields `no-shared-speech`,
show that notice without mutation. Tests assert the rebuilt clips use the new
duration and reopening/application still causes no POST.

- [ ] **Step 5: Implement the shared dialog**

Use `components/ui/dialog.tsx`. Recommend preserve-cuts. The rebuild copy must state that per-scene framing/transitions/punches, generated SFX, and deleted-scene recovery data are discarded.

- [ ] **Step 6: Route manual ingest through shared parsing/application**

Remove local `srtTimeToSec`, `srtToWords`, and `srtToText`. Keep demo bootstrap isolated as trusted baseline but validate its words. Replace manual `setClips` + `setWords` calls with `offerCandidate`. Build final-transcript candidates from `useRepurposeStore.getState().words`, not `rawWordsRef`.

- [ ] **Step 7: Harden persisted word hydration**

Use the shared structural validator with `allowEmpty: true`. Preserve backward-compatible optional `words`, but reject malformed entries instead of trusting `Array.isArray`.

- [ ] **Step 8: Run focused component tests**

Run the command from Step 3.

Expected: PASS.

- [ ] **Step 9: Check task diff**

Run `git diff --check`; confirm manual imports never call destructive `setClips`. Do not commit.

## Task 5: Imported Original Path Policy

**Files:**
- Modify: `lib/repurpose/media-paths.server.ts:5-56`
- Modify: `lib/repurpose/media-upload.server.ts:8-12,70-125`
- Modify: `tests/server/media-paths.test.ts`

- [ ] **Step 1: Write failing imported-original resolver tests**

Cover a direct `<64hex>.mp4` child, every supported extension, malformed/case-wrong hash, nested path, arbitrary Downloads file, directory, unsupported extension, traversal, and symlink/junction escape.

- [ ] **Step 2: Run the failing test**

```powershell
npm test -- tests/server/media-paths.test.ts
```

Expected: FAIL because `resolveImportedOriginalVideoPath` is absent.

- [ ] **Step 3: Implement the shared originals directory and resolver**

Export `REPURPOSE_ORIGINALS_DIR = path.join(REPURPOSE_FOOTAGE_DIR, "originals")`. Require a regular real file directly under the real originals directory with `/^[a-f0-9]{64}\.(mp4|mov|m4v|webm|mkv)$/` after lower-case extension handling.

Update `media-upload.server.ts` to use the shared directory so writer and resolver cannot drift.

- [ ] **Step 4: Run server policy and upload tests**

```powershell
npm test -- tests/server/media-paths.test.ts tests/server/footage-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Check task diff**

Run `git diff --check`; confirm the general preview allow-list remains unchanged. Do not commit.

## Task 6: Pinned Python `faster-whisper` Engine

**Files:**
- Create: `scripts/transcription-engine/pyproject.toml`
- Create: `scripts/transcription-engine/uv.lock`
- Create: `scripts/transcription-engine/engine.py`
- Create: `scripts/transcription-engine/transcribe.py`
- Create: `scripts/transcription-engine/tests/test_engine.py`

- [ ] **Step 1: Create the locked project manifest**

Use:

```toml
[project]
name = "repurpose-transcription-engine"
version = "1.0.0"
requires-python = ">=3.10"
dependencies = ["faster-whisper==1.2.1"]
```

Set model constants in `engine.py`:

```py
MODEL_ID = "Systran/faster-whisper-small"
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
```

Generate `uv.lock` with `uv lock --project scripts/transcription-engine`.

- [ ] **Step 2: Write failing deterministic Python tests**

Using `unittest.mock`, cover `pt` versus auto, `word_timestamps=True`, word whitespace normalization, progress by segment end/duration, empty speech, CUDA success, CUDA device failure retrying once on CPU `int8`, non-device failure not retrying, exact NDJSON event order/schema, one terminal event, atomic output publication, and a populated pinned model cache performing no network-enabled download. Do not load a real model.

- [ ] **Step 3: Run tests and verify failure**

```powershell
uv run --frozen --project scripts/transcription-engine python -m unittest discover -s scripts/transcription-engine/tests -v
```

Expected: FAIL because engine functions are missing.

- [ ] **Step 4: Implement the engine module**

Use the model-cache path supplied by Node's cross-platform resolver from Task 7. First call `faster_whisper.utils.download_model(..., cache_dir=model_cache, revision=MODEL_REVISION, local_files_only=True)`. Only a classified local-cache miss may retry once with `local_files_only=False`; corruption and other local errors fail safely. Load the returned local directory. Mock both calls and prove a populated pinned revision never invokes the network-enabled path. Emit one JSON object per stdout line; keep diagnostics on stderr. Use CUDA `float16` first and CPU `int8` fallback only for classified CUDA/device/OOM failures.

The stdout protocol is a strict discriminated union with no unknown keys:

```text
{"type":"phase","phase":"downloading-model"}
{"type":"model-ready","device":"cuda"|"cpu"}
{"type":"progress","phase":"transcribing","device":"cuda"|"cpu","progress":0..1}
{"type":"warning","code":"GPU_FALLBACK"}
{"type":"completed","device":"cuda"|"cpu"}
{"type":"error","code":"INVALID_INPUT"|"MODEL_DOWNLOAD_FAILED"|"ENGINE_FAILED"}
```

The exact successful grammar is:

```text
phase(downloading-model)
model-ready(cuda)
progress(cuda)*
[warning(GPU_FALLBACK) model-ready(cpu) progress(cpu)*]
completed(final-device)
```

A CUDA load failure may omit `model-ready(cuda)` and `progress(cuda)*`, producing
`phase, warning, model-ready(cpu), progress(cpu)*, completed`. Local model reuse
still emits the phase once. Progress is finite and monotonic per device; CPU may
restart from zero after fallback. A non-device inference failure never falls
back. `error` may terminate any nonterminal state, including before `phase` only
for invalid CLI input and after `warning` if CPU setup fails. `phase`, each
device's `model-ready`, `warning`, and the terminal event occur at most once.
Progress for a device is legal only after that device's `model-ready`.

`completed` and `error` are terminal and mutually exclusive. Publish and fsync
the validated transcript result with `os.replace` before emitting `completed`;
its device must equal the latest `model-ready`. Stdout never contains words,
transcript text, paths, stderr, or exception text. Node rejects unknown event
types/keys, illegal transitions, duplicate terminal events, events after
termination, child exit without one terminal event, a `completed` event without
a valid published file, and any line over 64 KiB. Node deletes partial output on
all failures and maps private engine error codes to Task 1's public error map.

- [ ] **Step 5: Implement the strict CLI**

Accept only input WAV, output partial path, model cache, language, and preferred device. Emit `model-ready` before inference. Write final result to a unique temporary file and `os.replace` it to the Node-provided partial path. Never print paths in result/error events.

- [ ] **Step 6: Run Python tests**

Run the command from Step 3.

Expected: PASS without downloading model weights.

- [ ] **Step 7: Check engine lock and files**

Run `uv lock --check --project scripts/transcription-engine` and inspect status. Do not commit.

## Task 7: Cache and Process Pipeline

**Files:**
- Create: `lib/repurpose/transcription-cache.server.ts`
- Create: `lib/repurpose/transcription-process.server.ts`
- Create: `tests/server/transcription-process.test.ts`
- Modify: `lib/repurpose/ffmpeg-process.server.ts:1-35,127-153`

- [ ] **Step 1: Write failing process/cache tests**

Start the file with `// @vitest-environment node`. Inject filesystem, clock, process, inspection, and hash adapters. Cover:

- exact imported-original path and expected hash;
- admission deriving the same cache key before runtime joining without trusting or returning unverified bytes;
- abortable SHA-256 verification before cache lookup;
- file-identity capture around a verified private source snapshot, persistent replacement rejection, and a replace/restore race proving FFmpeg still reads only the verified snapshot;
- two-hour duration cap and missing audio;
- FFmpeg mono 16 kHz PCM arguments and progress;
- 30-minute preparation/setup deadlines, duration-scaled extraction/transcription deadlines;
- bounded 64 KiB progress lines/diagnostics and 16 MiB/100,000-word results;
- malformed NDJSON/engine output, every legal fallback sequence, progress reset only across devices, child exit without a terminal event, and completion before atomic output publication;
- CUDA fallback warning propagation;
- cancellation and Windows process-tree termination;
- source re-hash before publication;
- cleanup on every exit;
- immutable valid cache hit, corrupt cache removal, and atomic publication.

- [ ] **Step 2: Run the failing process tests**

```powershell
npm test -- tests/server/transcription-process.test.ts
```

Expected: FAIL because server modules are missing.

- [ ] **Step 3: Add a focused FFmpeg audio extractor**

Keep compatibility encoding unchanged. Reuse the existing bounded diagnostic/process adapter concepts with arguments equivalent to:

```text
-hide_banner -loglevel error -nostdin -y -i INPUT -map 0:a:0
-ac 1 -ar 16000 -c:a pcm_s16le -progress pipe:1 -nostats OUTPUT.wav
```

- [ ] **Step 4: Implement cache module**

Use environment overrides for tests and one injectable path resolver shared by
model and result caches. Production roots are, in order: `%LOCALAPPDATA%\Repurpose Studio`
on Windows when set; `~/AppData/Local/Repurpose Studio` on Windows when it is
missing; `$XDG_CACHE_HOME/repurpose-studio` on non-Windows when set;
`~/Library/Caches/Repurpose Studio` on macOS; and `~/.cache/repurpose-studio` on
other platforms. Append `models` and `transcripts` respectively. Unit-test every
branch with injected platform/env/home values. Key results by verified source
hash, `pt|auto`, model id/revision, engine schema, and decoding settings.
Bounded-read and validate every cache hit before returning it.

Export the admission handoff used by the runtime:

```ts
interface PreparedTranscriptionRequest {
  sourcePath: string;
  expectedSourceHash: string;
  language: TranscriptionLanguage;
  admissionKey: string;
  cacheKey: string;
}

prepareTranscriptionRequest(
  request: StartTranscriptionRequest,
  signal: AbortSignal
): Promise<PreparedTranscriptionRequest>;
```

This function resolves the path through `resolveImportedOriginalVideoPath`,
extracts the expected SHA-256 from the managed filename, and derives `cacheKey`
from that expected hash plus the pinned model/revision, engine schema, language,
and decoding settings. Derive `admissionKey` from the canonical resolved
`sourcePath` plus `cacheKey`; it is only an in-memory pre-verification join key.
Two different managed paths claiming the same filename hash must not join, and a
regression test starts valid and replaced extension-distinct paths concurrently,
proving the invalid one fails its own verification and receives no valid result.
The function does not read a transcript cache or claim the bytes match yet. The
process receives this prepared object and must stream-hash the source, compare it
to `expectedSourceHash`, and reject mismatches before any cache lookup or child
process. Only verified `cacheKey`, never `admissionKey`, names durable results.

- [ ] **Step 5: Implement process orchestration**

Capture a `FileIdentity` from the resolved original (`realpath`, device/inode when
available, size, and high-resolution modification/birth times). During the
preparation deadline, stream-copy that open original to a unique private
temporary source snapshot while computing SHA-256. Require the hash to equal
`expectedSourceHash`, then re-stat/re-resolve the original and require the same
identity before consulting the cache. Inspect/extract only from the verified
snapshot, never from the mutable pathname. Before publication, re-resolve,
compare identity again, and stream-hash the original to the same expected hash.
Any persistent identity/hash difference fails with
`TRANSCRIPTION_SOURCE_CHANGED`. A replace-and-restore race cannot affect FFmpeg
because it reads the private verified snapshot; test this explicitly as well as
ordinary replacement rejection.

Sequence exactly after admission: snapshot+hash+identity verification, inspect
the snapshot, cache check, FFmpeg extraction from the snapshot, `uv run --frozen`,
model setup, transcription, validate result, source identity/hash recheck, atomic
cache publish, cleanup. Delete the temporary source snapshot, WAV, and partial
result on every exit. Spawn with `shell: false`, `windowsHide: true`, and no
user-controlled arguments beyond validated enum/path values.

On Windows terminate the owned tree with `taskkill /PID <pid> /T /F`, falling back to the direct child kill only if tree termination is unavailable. On POSIX use an owned process group. Never target a PID not returned by this invocation.

- [ ] **Step 6: Run process tests**

Run the command from Step 2.

Expected: PASS without running `uv`, FFmpeg, or a real model.

- [ ] **Step 7: Check task diff**

Run `git diff --check`; inspect cleanup and path-sanitization branches. Do not commit.

## Task 8: Observer-Scoped Job Runtime

**Files:**
- Create: `lib/repurpose/transcription-runtime.server.ts`
- Create: `tests/server/transcription-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests with fake timers**

Cover admission before scheduling, one distinct process, joining identical prepared admission keys, no join for different canonical paths that claim the same hash, 429 busy for another source, 32-observer cap, UUID idempotency, UUID conflict, 30-second active lease renewal/expiry, ten-minute settled observer expiry, a GET just before settled expiry extending retention by another ten minutes, one observer leaving while another survives, last-observer cancellation, start-request abort during admission, completed cache hit, failed/cancelled jobs becoming non-joinable, a fresh retry starting new work, and global singleton reuse/reset.

- [ ] **Step 2: Run and confirm failure**

```powershell
npm test -- tests/server/transcription-runtime.test.ts
```

Expected: FAIL because the runtime is missing.

- [ ] **Step 3: Implement an injectable runtime factory**

```ts
export function createTranscriptionRuntime(deps: {
  prepare: (request: StartTranscriptionRequest, signal: AbortSignal) => Promise<PreparedTranscriptionRequest>;
  run: (request: PreparedTranscriptionRequest, signal: AbortSignal, report: Report) => Promise<TranscriptionResult>;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}): TranscriptionRuntime;
```

`start()` awaits `prepare`, then uses only `prepared.admissionKey` for join/busy
admission and passes the same prepared object to `run`. Maintain separate
`observers: Map<UUID, Observer>` and `sharedJobs: Map<AdmissionKey, SharedJob>`.
Expose one idempotent `release(observerId)` operation used by DELETE and POST
abort cleanup. Every active GET renews the 30-second lease. Every settled GET
resets that observer's retention deadline to ten minutes from that GET. Release
or expiry affects only that observer; abort
the process only at zero observers. Remove every settled job from `sharedJobs`
immediately while retaining each observer's settled status record until expiry.
Thus a new UUID for the same key starts `run`, which re-verifies the source hash
before returning a durable cache hit; failed/cancelled work also starts fresh.
Reposting the original UUID remains idempotent and returns that observer's
settled status rather than starting work.

- [ ] **Step 4: Add the process-global singleton**

Store production runtime behind `Symbol.for("repurpose-studio.transcription-runtime")`. Expose a test reset helper only from the server module, or delete the symbol directly in test cleanup as existing SFX tests do.

- [ ] **Step 5: Run runtime tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Check task diff**

Run `git diff --check`; inspect all timer cleanup and final-observer paths. Do not commit.

## Task 9: Thin POST/GET/DELETE Routes

**Files:**
- Create: `app/api/repurpose/transcription/jobs/route.ts`
- Create: `app/api/repurpose/transcription/jobs/[id]/route.ts`
- Create: `tests/server/transcription-route.test.ts`

- [ ] **Step 1: Write failing route tests**

Start with `// @vitest-environment node`. Mock the runtime module. Cover malformed/oversized JSON, unknown keys, invalid UUID/language/path, abort during admission, abort after runtime observer attachment but before the response with observer release, accepted/idempotent POST with exact `202`, conflict, busy + `Retry-After`, GET status/result, unknown observer, DELETE idempotency, every Task 1 HTTP status/code mapping, and exact safe error bodies with no local paths.

- [ ] **Step 2: Run and verify failure**

```powershell
npm test -- tests/server/transcription-route.test.ts
```

Expected: FAIL because routes are missing.

- [ ] **Step 3: Implement the POST route**

Export `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and `maxDuration` only
for short request handling. Read at most 16 KiB, parse the exact contract, and
pass the validated request and `request.signal` to runtime admission. After
`start()` attaches/returns the observer but before building the response, check
the signal again. If aborted, release that observer immediately and return no
`202`; the route test aborts the controller from the mocked `start()` before it
resolves and asserts one release. Otherwise return a decoder-valid
`StartTranscriptionResponse` with HTTP `202` and `Cache-Control: no-store` for
both new and idempotent starts.

- [ ] **Step 4: Implement dynamic GET/DELETE**

Use the Next 15 signature:

```ts
type RouteContext = { params: Promise<{ id: string }> };
```

Map failures only through the fixed Task 1 status/code table and return a
decoder-valid `TranscriptionErrorResponse`; map missing observers to 404,
released observer DELETE to 204, conflicts to 409, capacity to 429, and invalid
input to 400/413. Route tests pass the actual `response.status` with parsed JSON
to `parseTranscriptionErrorResponse`; GET success always passes
`parseTranscriptionStatus`.

- [ ] **Step 5: Run route tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Run all transcription server tests**

```powershell
npm test -- tests/server/transcription-process.test.ts tests/server/transcription-runtime.test.ts tests/server/transcription-route.test.ts
```

Expected: PASS.

- [ ] **Step 7: Check task diff**

Run `git diff --check`; confirm routes contain no process/cache implementation. Do not commit.

## Task 10: Browser Job Coordinator

**Files:**
- Create: `app/repurpose-studio/_components/useTranscription.ts`
- Create: `tests/components/useTranscription.test.tsx`

- [ ] **Step 1: Write failing hook tests**

Mock fetch and timers. Cover observer UUID created before POST, posting Face `originalPath`, polling/lease renewal, visible and hidden polling intervals below 30 seconds, cancellation during POST and GET, independent best-effort DELETE, exact empty `204` DELETE success, rejection of body-bearing/non-204 DELETE success, project epoch change, Face replacement without epoch change, unmount, late result suppression, empty-engine no speech, cache-hit completion, retry with a new UUID after failed/cancelled status, fallback warning, every success/error response decoder, rejection of status/code mismatches or unknown response keys, and result handoff exactly once.

- [ ] **Step 2: Run and confirm failure**

```powershell
npm test -- tests/components/useTranscription.test.tsx
```

Expected: FAIL because the hook is missing.

- [ ] **Step 3: Implement the state machine**

Expose a narrow API:

```ts
interface UseTranscriptionResult {
  language: TranscriptionLanguage;
  setLanguage(language: TranscriptionLanguage): void;
  status: TranscriptionStatus | null;
  start(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  available: boolean;
}
```

Capture `projectEpoch` and `faceCamSource.originalPath`. Recheck after every
`await`. Keep the observer UUID known before POST. Decode POST and GET success
bodies and every non-2xx body with Task 1's shared decoders before changing
state. DELETE success is the sole bodyless case: require exactly HTTP `204` and
an empty body; decode any non-2xx DELETE body with
`parseTranscriptionErrorResponse(body, response.status)`. Use that same actual
status argument for POST/GET errors. Abort the current fetch first, then send
DELETE with a fresh controller and bounded cleanup timeout. `retry()` fully
releases the old observer, generates a new UUID, clears settled local state, and
starts a new POST; it never reposts a failed/cancelled observer UUID.

- [ ] **Step 4: Implement polling**

Poll around one second while visible and at most ten seconds while hidden. Stop at settled state, cancellation, source/project mismatch, or unmount. Never persist job state.

- [ ] **Step 5: Run hook tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Check task diff**

Run `git diff --check`; inspect every async stale-owner guard. Do not commit.

## Task 11: Transcription Controls and SourcesPanel Integration

**Files:**
- Create: `app/repurpose-studio/_components/TranscriptionControls.tsx`
- Modify: `app/repurpose-studio/_components/SourcesPanel.tsx:94-180,413-539,562-637`
- Modify: `tests/components/SourcesPanel.test.tsx`

- [ ] **Step 1: Add failing presentation/integration tests**

Cover:

- disabled legacy source guidance;
- control visible outside the collapsed re-import disclosure;
- Portuguese default and Auto selection;
- extraction, model download, GPU/CPU, progress, fallback, cancellation, empty-engine no-speech, distinct no-shared-speech without store mutation, completion, and retry states;
- Face-only result waiting for Screen;
- untouched auto-rebuild and captions enabled;
- edited preserve/rebuild/apply-later paths;
- source replacement cancelling the observer;
- rebuild warning text for clip-local edits, SFX, and deleted-scene recovery.
- first-run copy says local Python dependencies and the pinned model may be downloaded to this computer, audio/video never leaves it, and later runs work offline.

- [ ] **Step 2: Run and confirm failure**

```powershell
npm test -- tests/components/SourcesPanel.test.tsx tests/components/useTranscription.test.tsx
```

Expected: FAIL because controls are absent.

- [ ] **Step 3: Implement `TranscriptionControls`**

Reuse the existing Select/Dialog/Button primitives and current Inspector visual language. Keep the component present after both sources load. Do not make Add media count as Face or Screen.

- [ ] **Step 4: Connect result handoff to `useTranscriptApplication`**

Build automatic candidate clips from validated words, but defer applying until
both source records have positive inspected durations. Keep all Face words;
bound only candidate clips to the shorter dual-source duration, and re-bound at
actual application as required by Task 4. Enable captions through the atomic
store action. Empty engine words show ordinary no-speech. A non-empty transcript
whose clips have no overlap with the shared duration passes the explicit
`no-shared-speech` offer to Task 4, shows a distinct message, and performs no
store mutation.

- [ ] **Step 5: Integrate source cancellation**

When `handleMediaFiles("face")` begins or publishes a replacement, cancel/invalidate the current observer even though `projectEpoch` may be unchanged.

- [ ] **Step 6: Run component tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Run typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 8: Check task diff**

Run `git diff --check`; confirm `SourcesPanel` delegates rather than containing a second polling state machine. Do not commit.

## Task 12: End-to-End Coverage and Final Verification

**Files:**
- Create: `tests/e2e/transcription.spec.ts`
- Modify: `tests/e2e/helpers/project.ts`
- Modify: `playwright.config.ts` only if deterministic route interception cannot cover the required browser flow

- [ ] **Step 1: Generate media fixtures once**

```powershell
npm run fixtures:media
```

Expected: generated fixture command exits 0. This must precede media-consuming tests.

- [ ] **Step 2: Write failing deterministic E2E coverage**

Add a footage-only project helper. Intercept transcription POST/GET/DELETE in Playwright with deterministic words so CI never downloads a model or requires CUDA. Cover:

- import Screen + Face without transcript;
- click **Transcrever áudio**;
- see progress and apply words/captions;
- save/reopen and verify captions remain without another POST;
- preserve edited cuts;
- explicitly rebuild an edited timeline;
- cancel a running job;
- inspect the transcription POST and assert its exact JSON keys are only `observerId`, `path`, and `language`, with no media bytes, `blob:` value, transcript/source contents, or multipart body;
- assert no cross-origin request initiated by the transcription action carries media bytes, while allowing normal same-origin preview/video requests;
- no unexpected console/HTTP/request failures.

- [ ] **Step 3: Run the E2E file and verify initial failure**

```powershell
npx playwright test tests/e2e/transcription.spec.ts
```

Expected before final fixture/interception wiring: FAIL on missing flow or helper.

- [ ] **Step 4: Complete E2E helper/interception wiring**

Keep the production Playwright server on port 3001. Do not alter or stop port 3000. Add transcription lifecycle aborts to the browser error collector only when they are expected cancellation behavior.

- [ ] **Step 5: Run focused unit/server/component suites**

```powershell
npm test -- tests/unit/transcript-ingest.test.ts tests/unit/transcription-contract.test.ts tests/unit/transcript-application.test.ts tests/unit/video-timeline-bootstrap.test.ts
npm test -- tests/server/media-paths.test.ts tests/server/transcription-process.test.ts tests/server/transcription-runtime.test.ts tests/server/transcription-route.test.ts
npm test -- tests/components/useTranscription.test.tsx tests/components/SourcesPanel.test.tsx tests/components/project-persistence.test.tsx tests/components/useProjectPersistence.test.tsx
```

Expected: all PASS.

- [ ] **Step 6: Run Python engine unit tests**

```powershell
uv run --frozen --project scripts/transcription-engine python -m unittest discover -s scripts/transcription-engine/tests -v
```

Expected: PASS without model-weight download.

- [ ] **Step 7: Run focused E2E**

```powershell
npx playwright test tests/e2e/transcription.spec.ts
```

Expected: PASS on Desktop Chrome at port 3001.

- [ ] **Step 8: Run full repository verification**

```powershell
npm run verify
```

Expected: typecheck, Vitest, Playwright, and Next build all exit 0 without CUDA or model download.

- [ ] **Step 9: Perform one real-engine local acceptance check**

With the user-approved first-run download, exercise a short Face fixture through the real route/UI and record:

- approximately 484 MB pinned model download shown as local setup;
- `pt` word timings and captions;
- NVIDIA device when CUDA 12/cuBLAS/cuDNN 9 are available;
- visible automatic CPU fallback when they are not;
- second identical run resolving from cache;
- cancellation cleanup;
- after one successful `pt` run, disable network and run `auto` for the same source so the result cache key is different while the already-downloaded model must still be reused offline;
- repeat that identical `auto` request once more to prove the transcript result cache hit.

If the machine lacks compatible NVIDIA libraries, CPU success plus the fallback warning is the accepted result. Do not claim GPU success without observed status.

- [ ] **Step 10: Inspect final workspace state**

Run `git status --short`, `git diff --check`, and review only intended files. Do not commit, push, or deploy unless explicitly requested.

## Execution Notes

- Use `@test-driven-development` for each production slice: failing test, observed failure, minimal implementation, observed pass.
- Use `@systematic-debugging` for any unexpected failure; do not patch around symptoms.
- Use `@verification-before-completion` before reporting the feature complete.
- Keep existing user changes in this dirty worktree. Never revert unrelated modifications.
- Never transcribe `workingPath`, `previewPath`, a URL, or an arbitrary home-directory video. Use only hash-verified `faceCamSource.originalPath` under the managed originals directory.
- Do not change manual imports, persistence, or store history in separate follow-up work; their safe integration is part of this plan.
