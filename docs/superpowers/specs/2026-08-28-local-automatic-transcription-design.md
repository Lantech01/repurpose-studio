# Local Automatic Transcription Design

## Problem

Repurpose Studio can ingest a word-level JSON transcript or an SRT, but it
cannot create that transcript from imported footage. Users must leave the app,
run a separate transcription tool, and import its output before the transcript
and caption workflows become useful.

The editor already treats Face as the authoritative audio source and already
stores source-time `Word[]` values shaped as `{ text, start, end }`. Supplying
validated words through that contract unlocks the transcript rail, caption
chunking, timeline word cells, SRT export, and project persistence. The missing
piece is a private local speech-to-text pipeline and a safe way to apply its
result without destroying edits made while it was running.

## Goals

- Transcribe the imported Face video's audio without uploading audio or video.
- Start transcription only when the user presses a button.
- Prefer an NVIDIA GPU when compatible CUDA support is available and fall back
  automatically to CPU.
- Optimize the default flow for Portuguese while allowing automatic language
  detection.
- Produce source-time words compatible with the existing `Word[]` contract.
- Turn captions on after applying a non-empty result.
- Preserve existing timeline work unless the user explicitly chooses to rebuild
  it.
- Support progress, cancellation, cache reuse, actionable errors, and project or
  source changes while a job is running.

## Non-Goals

- Selecting the best retake or removing repeated takes automatically.
- Generating a final cleaned transcript or inferring retake decisions without
  one.
- Speaker diarization, translation, cloud transcription, or collaborative jobs.
- A model picker or advanced decoding controls in the first version.
- Shipping the speech model inside the repository or installer.

## Product Contract

- A **Transcrever áudio** control is available when Face has a durable imported
  `VideoSourceRecord`. A legacy source without that record asks the user to
  re-import Face instead of accepting an arbitrary path or URL.
- The language control has `Português` as its default and `Detectar
  automaticamente` as the alternative.
- The first run may download the multilingual `small` model and Python package
  dependencies. The UI explains that the download is local setup and that media
  is never uploaded. Later runs reuse the local model cache and work offline.
- There is at most one distinct transcription process at a time. A second
  distinct request receives a busy response; an identical request rejoins the
  existing underlying job through its own observer id, or reuses its cached
  result. Cancelling one observer does not cancel work still observed elsewhere.
- Active observers use renewable leases, so a crashed tab, lost POST response,
  or failed DELETE cannot keep an unobserved process alive indefinitely.
- The UI exposes the current phase, determinate progress when available, an
  indeterminate state otherwise, the selected device, and a Cancel action.
- A successful result with speech is applied automatically only when the video
  timeline is still untouched and both source videos are ready. If Screen is
  absent, the result remains cached and waits for Screen. If the timeline is no
  longer untouched, the user chooses whether to preserve cuts, rebuild the video
  timeline, or apply later.
- A successful result with no detected speech is cached and reported as
  `Nenhuma fala detectada`; it does not clear existing words or modify the
  timeline.
- Applying words enables captions and rebuilds caption blocks with the existing
  caption style. It does not attempt retake cleanup.
- Manual `.srt` and `.json` imports remain available and may replace an
  automatically generated transcript through the same safe apply decision and
  atomic store action. They must not use the current destructive `setClips`
  composition after this feature lands.

## Chosen Approach

Use `faster-whisper` in a dedicated Python engine managed by `uv`.

This approach provides true per-word timestamps, multilingual Whisper models,
CUDA support through CTranslate2, and efficient CPU `int8` fallback. It also
matches the repository's existing pattern of running a pinned Python engine via
`uv`. A separate `scripts/transcription-engine` environment keeps its large ML
dependencies isolated from the SFX engine.

`whisper.cpp` was rejected for the first version because maintaining separate
Windows CUDA and CPU binaries would add packaging work without improving the
editor contract. Browser WebGPU/WASM was rejected because model memory would
compete with preview and export in the browser and device support is less
predictable.

## Architecture

### Client Coordinator

`SourcesPanel` owns a focused transcription coordinator, preferably extracted
to a hook once the state machine would otherwise make the panel harder to read.
It:

- reads the Face `originalPath`, Face source identity, project epoch, and current
  language choice;
- starts a server job and polls its status;
- displays extraction, setup, transcription, fallback, completion, and error
  states;
- sends cancellation when the user cancels, the project epoch changes, Face is
  replaced, or the component unmounts;
- ignores every response whose local generation, project epoch, or Face source
  identity is stale; and
- applies or defers a validated completed result.

Aborting a polling request alone does not imply cancellation. The coordinator
uses the job DELETE endpoint for best-effort process cancellation, then invalidates
its local generation so a late response cannot mutate the new project.

Before POST, the client creates a cryptographically random observer UUID and
includes it in the request. If the project or Face changes while POST is pending,
the coordinator aborts POST and can still DELETE that known observer id. The
route checks `request.signal` before and after validation and releases an observer
if the start request is aborted before its response returns. The renewable lease
is the final cleanup backstop if neither signal nor DELETE arrives.

### Job API

Use asynchronous Node routes so a long transcription does not hold one request
open:

- `POST /api/repurpose/transcription/jobs` validates the request and returns
  `202 { jobId }`. The body-supplied observer UUID becomes `jobId` after strict
  UUID validation; it represents this caller's observer, not the shared process
  or cache key. Repeating the same UUID and same request is idempotent; reusing it
  for different input is a conflict. A completed cache hit may return an observer
  already in the `completed` state.
- `GET /api/repurpose/transcription/jobs/[id]` returns current status and the
  result only after completion.
- `DELETE /api/repurpose/transcription/jobs/[id]` is idempotent and releases
  that observer. The underlying queued or running process is cancelled only when
  its observer count reaches zero.

The POST body contains only `{ observerId, path, language }`, where language is
`pt` or `auto`. The server does not trust a client-provided fingerprint,
duration, device, model name, output path, or engine arguments.

Status responses use these stable concepts:

- state: `queued`, `running`, `completed`, `failed`, or `cancelled`;
- phase: `preparing`, `extracting-audio`, `downloading-model`, `transcribing`,
  or `finalizing`;
- progress: a value from 0 to 1, or `null` when the phase is indeterminate;
- device: `cuda`, `cpu`, or `null` before selection;
- optional non-fatal warning, such as CUDA fallback; and
- a typed error containing a safe code and Portuguese user-facing message.

Runtime job state is kept behind a process-global symbol, following the existing
local job patterns so Next.js development module reloads do not duplicate work.
Completed in-memory jobs can expire after a short observation window because
their durable result is content-addressed on disk.

The runtime maintains separate maps for opaque observer ids and shared jobs keyed
by the server-computed cache key. GET and DELETE resolve only opaque observer
ids. This mirrors the existing SFX waiter semantics while allowing polling
instead of one long request.

An active observer lease lasts 30 seconds and every successful GET renews it;
the client polls well inside that interval. Expiry releases the observer and
aborts the underlying job only when it was the last observer. Completed, failed,
and cancelled observers expire ten minutes after their last GET. A shared job
accepts at most 32 observers, matching the existing SFX waiter bound. Cleanup
timers are attached to the process-global runtime so expiry does not depend on a
future request.

### Media Preparation

The route resolves the requested path with a new imported-original resolver. The
resolver requires a real file directly under
`REPURPOSE_FOOTAGE_DIR/originals`, checks containment after `realpath`, accepts
only supported video extensions, and requires a basename shaped as
`<64 lowercase hex content hash><extension>`. Working conversions, preview
proxies, general home-directory videos, and nested arbitrary files are rejected.
This matches the immutable destination written by `storeUploadedVideo`.

The basename supplies an expected content hash so POST can create an observer
without synchronously reading a multi-gigabyte source. The shared job's first
`preparing` step streams the original with abort support, computes SHA-256, and
requires it to match that expected hash before consulting the result cache. That
verified content hash, not path or client metadata, is the durable source identity
and cache-key input. The job then extracts the first audio stream from the Face
original with FFmpeg
to a unique temporary mono 16 kHz WAV. It never transcribes a preview proxy. A
missing audio stream produces a typed `TRANSCRIPTION_AUDIO_MISSING` failure.
The temporary WAV and partial result files are removed after success, failure,
timeout, or cancellation.

The server captures file identity metadata before extraction and re-hashes the
original before publishing a result. A changed, replaced, or hash-mismatched
source fails with `TRANSCRIPTION_SOURCE_CHANGED` and cannot poison the
content-addressed cache.

The first version accepts Face sources up to two hours. The preparing phase
inspects duration and fails longer sources before model setup or audio extraction
with `TRANSCRIPTION_SOURCE_TOO_LONG`.

Path resolution, media inspection, and content hashing share a 30-minute
preparation deadline and remain abortable throughout. Exceeding it fails with
`TRANSCRIPTION_PREPARATION_TIMEOUT`.

After preparation, FFmpeg creates the complete WAV before Python starts. Audio
extraction has a deadline of `max(10 minutes, 0.5 * source duration)`, capped at
one hour. `uv` environment preparation and model setup then have their own
30-minute absolute deadline beginning when the child process starts. Exceeding it
kills the process, cleans temporary files, and returns
`TRANSCRIPTION_SETUP_TIMEOUT`. When the engine reports `model-ready`, the setup
deadline is replaced by a transcription deadline of
`max(30 minutes, 4 * source duration)`, capped at eight hours. The engine always
receives an already-published WAV path; no stdin or cross-process file handshake
is required.

### Python Engine

The engine is invoked with `uv run --frozen` and receives only validated command
arguments: input WAV, model cache directory, result path, language mode, and
preferred device. It emits newline-delimited progress events on stdout and
writes the potentially larger final JSON to a unique partial path. Node validates
that JSON before atomically publishing it to the result cache.

Request JSON is capped at 16 KiB and accepts exact known keys only. A progress
line is capped at 64 KiB, retained process diagnostics are capped at 64 KiB, and
the result JSON is capped at 16 MiB and 100,000 words before validation. Exceeding
a bound fails safely without attempting to parse or expose the oversized data.

The engine uses `Systran/faster-whisper-small` at an immutable pinned model
revision with word timestamps enabled. The pinned revision is an engine constant
and part of the result cache key; it must never follow a mutable `main` branch.
For `Português`, it passes `language="pt"`; for automatic detection it leaves
the language unset and returns the detected language and probability.

Device selection follows this order:

1. Attempt CUDA with an appropriate GPU compute type.
2. If CUDA initialization, model loading, allocation, or transcription fails for
   a device-related reason, emit a fallback warning and restart once on CPU
   `int8`.
3. If CPU also fails, return a typed engine failure. Non-device failures do not
   trigger a misleading retry.

Model setup first checks the configured local cache. If the model is absent, it
downloads into `%LOCALAPPDATA%\Repurpose Studio\models` on Windows, with a
cross-platform user-cache fallback. Download progress may be indeterminate when
the underlying library does not expose a reliable total. No media bytes are
included in model-download requests.

### Validation and Cache

One shared transcript-word validator handles automatic engine output and manual
`.json`/`.srt` imports before either can reach the store. Every word must have
non-empty trimmed text, finite non-negative timestamps, a positive span, and
nondecreasing start order. When a durable Face source is available, end times
must also remain within its inspected duration, allowing only a small timestamp
tolerance; automatic output always has this bound. The validator normalizes
surrounding whitespace but does not rewrite punctuation or vocabulary. Invalid
automatic output is deleted and never cached; invalid manual input shows an
ingest error without changing the project. The manual SRT parser treats malformed
timestamps as errors rather than coercing them to zero. An empty automatic result
is the valid no-speech outcome, while an empty manual transcript is rejected.

The result cache lives under `%LOCALAPPDATA%\Repurpose Studio\transcripts` on
Windows with the same cross-platform fallback. Its key includes the server-
computed source identity, language mode, model id, engine/schema version, and
decoding settings. Result files are immutable content-addressed JSON. A missing,
malformed, or schema-incompatible cache entry is ignored and regenerated.

## Applying Results

### Untouched Predicate

At application time, not merely job start, the video timeline is untouched only
when `words` is empty and either:

- `clips` is empty; or
- `clips` contains exactly the pristine `VIDEO_TIMELINE_CLIP_ID` full-span clip
  matching the current effective source duration.

Any trim, split, deletion, duplication, reorder, transcript-derived clips, or
existing words makes the timeline edited. Visual settings and overlays do not
make the video cuts edited, but they must always survive transcript application.

Transcription may finish with only Face imported, but application waits until
Screen is ready. In rebuild mode, generated clips are intersected with the
current effective dual-source duration, the shorter positive duration of Screen
and Face. Clips wholly outside that duration are dropped and partial boundary
clips are trimmed before timeline layout. The full Face `Word[]` remains the raw
transcript; words outside kept clips simply have no visible output-time caption.
If no speech overlaps the effective dual-source duration, application makes no
changes and reports that the shared source span contains no transcribed speech.

### Atomic Store Action

Add one store action that applies validated transcript words atomically instead
of composing today's `setClips` and `setWords`. This is required because
`setClips` intentionally clears overlays for a fresh ingest.

The action creates one undo step for fields tracked by the existing document
history and always:

- replaces `words`;
- clears stale deleted-word indices and word selection;
- clears stale caption-block selection, and clears clip selection when clips are
  rebuilt;
- rebuilds fresh caption blocks with the current caption style, without
  reattaching timestamp-keyed text or style overrides from the replaced
  transcript;
- enables captions; and
- preserves overlays, markers, grades, global split ratio, caption style, media
  assets, music, footage metadata, and transient source readiness.

In `preserve-cuts` mode, clips and duration are unchanged, so the existing SFX
track remains aligned and is preserved, including every clip-local transition,
split override, framing, punch, and manual-scene flag. In `rebuild` mode, the
action replaces the video clips with the existing raw-word ingest result,
recomputes duration, leaves edit stats null because there is no final clean
transcript, and clears the generated SFX track because its rendered duration and
placements belong to the old edit. Because those visual edits live on the old
clips and cannot be mapped reliably to new speech-derived boundaries, rebuild
also intentionally discards old clip-local transitions, split overrides,
face/screen framing, punches, and manual-scene flags. The confirmation lists both
this loss and the need to generate SFX again; `preserve-cuts` is the recommended
choice for an edited timeline.

Rebuild also clears the session-only `overlayDeleteStash` associated with old
clip ids. Otherwise deterministic ids in the rebuilt clips could claim overlays
removed from unrelated old scenes. The stash is outside document history, so
Undo does not restore it; the confirmation states that recovery data for already
deleted old scenes is discarded. `preserve-cuts` leaves the stash untouched.

Rebuild does not move or delete overlays, markers, media assets, or music. Items
whose output times now fall beyond the shorter duration remain persisted but are
not visible until moved into range or the timeline grows again. The action clamps
the transient playhead to the new duration and clamps the in/out range, clearing
that range if it becomes invalid. These transient bounds, `editStats`, and the
generated SFX track are outside the existing Undo snapshot; Undo restores the
clips, words, caption state, overlays, and markers in one step but does not
restore those derived/transient values. The UI warning before an edited rebuild
states this SFX invalidation explicitly.

Manual raw transcript import uses this same action and untouched/edited decision.
When a final transcript is supplied, the existing final-transcript matcher may
produce the candidate clips from the validated store words, not an ephemeral
panel-only ref, but applying those clips still goes through the same rebuild
confirmation and atomic action. Choosing preserve-cuts applies only the new words
and captions; it never silently replaces edited clips or overlays.
Manual imports retain the existing ability to build transcript-derived clips
before source footage is selected. In that source-less case validation is
structural and the candidate clip span comes from the transcript; when both
sources are present, rebuild candidates are bounded to the effective dual-source
duration just like automatic results.

For an untouched timeline the coordinator invokes `rebuild` automatically.
For an edited timeline it opens a confirmation with:

- **Preservar cortes e adicionar legendas**: apply `preserve-cuts`;
- **Reconstruir timeline com a transcrição**: apply `rebuild`; or
- **Aplicar depois**: retain the cached result without mutating the project.

The coordinator retains the completed result locally for the current Face source
so Apply Later can reopen the same confirmation without running the engine again.
A page reload can recover the same result by issuing the identical POST, which
resolves from the durable cache.

## UI States

- No durable Face source: disabled control with `Reimporte o vídeo Face para
  transcrever` when a legacy source URL exists.
- Ready: language selector and **Transcrever áudio** button.
- Extraction: `Extraindo áudio do Face` with progress when FFmpeg reports it.
- Model setup: `Preparando modelo local` or `Baixando modelo local`, with an
  explanation that audio stays on the computer.
- Transcription: detected/forced language, active `GPU NVIDIA` or `CPU`, progress,
  and Cancel.
- CUDA fallback: non-fatal `GPU indisponível; continuando na CPU` warning.
- Completed: word count, detected language when automatic, and whether the
  result was applied or awaits a decision.
- Cancelled: returns to Ready without changing words, clips, or captions.
- Failed: actionable typed error and Retry; no partial result is applied.

Replacing Face clears completed UI state for the old source. It does not delete
the content-addressed cache, which remains safe to reuse if that same source is
imported again.

## Error Handling

- Missing or non-imported path: `TRANSCRIPTION_SOURCE_INVALID`.
- Source changes while processing: `TRANSCRIPTION_SOURCE_CHANGED`.
- Source has no audio stream: `TRANSCRIPTION_AUDIO_MISSING`.
- FFmpeg unavailable or extraction fails: `TRANSCRIPTION_AUDIO_EXTRACTION_FAILED`.
- Audio extraction exceeds its duration-scaled deadline:
  `TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT`.
- `uv`, the locked engine, or Python cannot start: `TRANSCRIPTION_ENGINE_UNAVAILABLE`
  with installation guidance that does not leak local paths.
- Model download fails: `TRANSCRIPTION_MODEL_DOWNLOAD_FAILED` and Retry.
- Dependency/model setup exceeds 30 minutes: `TRANSCRIPTION_SETUP_TIMEOUT`.
- All compute devices fail: `TRANSCRIPTION_ENGINE_FAILED`.
- Invalid engine JSON or invalid words: `TRANSCRIPTION_INVALID_OUTPUT`.
- Capacity is occupied by another source: `TRANSCRIPTION_BUSY` with
  `Retry-After`.
- Face duration exceeds two hours: `TRANSCRIPTION_SOURCE_TOO_LONG`.
- Source preparation exceeds 30 minutes: `TRANSCRIPTION_PREPARATION_TIMEOUT`.
- Explicit cancellation: `TRANSCRIPTION_CANCELLED`, with child processes killed
  and temporary files removed.
- Transcription exceeds `max(30 minutes, 4 * source duration)` after model setup:
  `TRANSCRIPTION_TIMEOUT`, capped at eight hours.

Diagnostics are bounded server-side. API responses and client logs do not expose
absolute source, cache, model, engine, or temporary paths.

## Testing

### Unit Tests

- Validate request and engine-result schemas, timestamp bounds, ordering, empty
  speech, language modes, cache keys, source content-hash verification, and cache
  corruption recovery. Apply the same structural validator tests to manual JSON
  and strict SRT parsing.
- Validate the untouched predicate for empty, pristine bootstrap, trimmed,
  split, reordered, deleted, and transcript-derived timelines.
- Validate the atomic store action in both modes, one-step Undo/Redo, caption
  activation, caption block rebuilding, stale deletion reset, and preservation
  of overlays and other project state. Rebuild tests also prove SFX invalidation,
  transient bound normalization, and that out-of-range overlays/markers remain
  stored without being moved. Prove rebuild clears `overlayDeleteStash`, Undo
  does not recreate it, preserve-cuts retains it, and fresh caption blocks cannot
  inherit old transcript overrides.
- Validate Python progress parsing and CUDA-to-CPU fallback classification.

### Server Tests

- Put `// @vitest-environment node` at the top of every Node-only route test.
- Mock FFmpeg and the Python process to cover start, poll, completion, DELETE,
  timeout, cleanup, bounded request/progress/result data, and typed errors.
- Prove only real imported footage paths are accepted, including traversal and
  symlink escape rejection.
- Prove one-process capacity, identical-job joining, durable cache hits, and
  recovery from invalid cache entries. Prove releasing one observer does not
  cancel an identical job with another observer, while releasing the last one
  does. Cover observer caps, lease renewal/expiry, start-request aborts, setup
  timeout, preparation timeout, and completed-observer expiry.
- Prove a CUDA device failure restarts once on CPU while a non-device engine
  error does not.

### Component and Browser Tests

- Cover button availability, Portuguese/Auto selection, all progress phases,
  Cancel, Retry, fallback warning, no-speech behavior, and stale project/source
  responses.
- Cover automatic application to an untouched timeline and all three edited-
  timeline choices. Cover Face-only completion waiting for Screen and clipping a
  rebuild to the shorter dual-source duration.
- Prove captions appear in preview, persist after save/reopen, and remain aligned
  with source time while existing cuts are preserved.
- Use a deterministic fake engine in CI. Do not download the Whisper model in
  normal test or build runs.
- Keep a manual real-engine acceptance check for first model download, NVIDIA
  execution when available, CPU fallback, Portuguese word timing, cache reuse,
  cancellation, and offline reuse after the first successful setup.

Run `npm run fixtures:media` before media-consuming tests, use port 3001 for
Playwright, and finish with `npm run verify`.

## Acceptance Criteria

- With both imported sources ready, pressing **Transcrever áudio** produces
  usable word-level Portuguese captions without sending media over the network.
- On a correctly configured NVIDIA machine, status reports GPU execution; if
  CUDA is unavailable or fails, the same job completes on CPU and reports the
  fallback.
- The first model download is visible and later identical requests use the local
  cache, including with networking unavailable.
- Cancelling, changing projects, or replacing Face never applies a stale result
  and leaves no temporary audio or partial result.
- An untouched timeline is rebuilt and captions are enabled automatically.
- An edited timeline is never rebuilt without explicit confirmation, and the
  preserve-cuts option leaves every clip boundary unchanged.
- Rebuild confirmation states that clip-local visual edits are replaced;
  preserve-cuts retains them exactly.
- Applying a transcript changes the existing Undo-tracked document fields in one
  undoable edit and does not delete overlays or unrelated project state.
- A rebuild invalidates the generated SFX track with a visible warning; it does
  not silently keep a duration-mismatched generated track.
- Saved projects reopen with words and enabled captions without retranscribing.
- Manual transcript import continues to work through the same non-destructive
  apply path.
- The complete verification suite passes without requiring CUDA or downloading
  a speech model.
