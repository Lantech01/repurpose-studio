import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  APPROVED_SFX_KEYS,
  SFX_CATALOG,
  getSfxCatalogEntry,
} from "@/lib/repurpose/sfx-effects";
import {
  normalizeProjectMediaPath,
  ProjectReferenceSnapshotUnavailableError,
  withProjectReferenceSnapshot,
} from "@/lib/repurpose/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const execFileAsync = promisify(execFile);
const SFX_DIR = process.env.REPURPOSE_SFX_CACHE_DIR
  ? path.resolve(process.env.REPURPOSE_SFX_CACHE_DIR)
  : path.join(os.homedir(), "Downloads", "repurpose-overlays");
const ENGINE_DIR = process.env.REPURPOSE_SFX_ENGINE_DIR
  ? path.resolve(process.env.REPURPOSE_SFX_ENGINE_DIR)
  : path.join(process.cwd(), "scripts", "sfx-engine");

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_EVENTS = 500;
const MAX_DURATION_MS = 10 * 60 * 1000;
const ENGINE_TIMEOUT_MS = 280_000;
const MAX_ENGINE_BUFFER = 8 * 1024 * 1024;
const MAX_CONCURRENT_RENDERS = 2;
const MAX_QUEUED_RENDERS = positiveEnvInteger("REPURPOSE_SFX_MAX_QUEUED_RENDERS", 8);
const MAX_WAITERS_PER_JOB = positiveEnvInteger("REPURPOSE_SFX_MAX_WAITERS_PER_JOB", 32);
const CACHE_TTL_MS = positiveEnvInteger("REPURPOSE_SFX_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000);
const CACHE_MAX_BYTES = positiveEnvInteger("REPURPOSE_SFX_CACHE_MAX_BYTES", 2 * 1024 * 1024 * 1024);
// Autosave is debounced; keep a new final alive long enough for its project
// snapshot to publish even when the cache is already over budget.
const PUBLICATION_GRACE_MS = 60_000;
const FINAL_FILE_PATTERN = /^sfx-[a-f0-9]{64}\.wav$/;
const EFFECT_KEYS = new Set<string>(APPROVED_SFX_KEYS);
const SFX_ASSET_NAMES = APPROVED_SFX_KEYS.map((key) => SFX_CATALOG[key].filename);

interface ValidatedEvent {
  sfx: string;
  at_ms: number;
}

interface WavInfo {
  size: number;
  durationMs: number;
}

interface RenderOutcome {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface RenderJob {
  hash: string;
  validated: { events: ValidatedEvent[]; durationMs: number };
  controller: AbortController;
  waiters: Set<symbol>;
  state: "queued" | "running" | "settled";
  promise: Promise<RenderOutcome>;
  resolve: (outcome: RenderOutcome) => void;
  run: () => Promise<RenderOutcome>;
}

interface RuntimeState {
  jobs: Map<string, RenderJob>;
  running: number;
  queue: RenderJob[];
  sweepRunning: Promise<void> | null;
  sweepPending: boolean;
  sweepExtraProtected: Set<string>;
  activeFiles: Set<string>;
  servingFiles: Map<string, number>;
}

const RUNTIME_STATE_KEY = Symbol.for("repurpose-studio.sfx-runtime");
const globalRuntime = globalThis as unknown as Record<symbol, RuntimeState | undefined>;
const runtimeState = globalRuntime[RUNTIME_STATE_KEY] ??= {
  jobs: new Map(),
  running: 0,
  queue: [] as RenderJob[],
  sweepRunning: null,
  sweepPending: false,
  sweepExtraProtected: new Set(),
  activeFiles: new Set(),
  servingFiles: new Map(),
};

class RequestTooLargeError extends Error {}
class EngineUnavailableError extends Error {}

function positiveEnvInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnder(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function cachePathIdentity(filePath: string): string {
  return normalizeProjectMediaPath(filePath) ?? filePath;
}

function isFileProtected(
  filePath: string,
  projectReferences: ReadonlySet<string>,
  extraProtected: ReadonlySet<string>
): boolean {
  const identity = cachePathIdentity(filePath);
  return extraProtected.has(identity) ||
    runtimeState.activeFiles.has(identity) ||
    (runtimeState.servingFiles.get(identity) ?? 0) > 0 ||
    projectReferences.has(identity);
}

async function performCacheSweep(extraProtected: ReadonlySet<string>): Promise<void> {
  try {
    await withProjectReferenceSnapshot(async (projectReferences) => {
      const entries = await readdir(SFX_DIR, { withFileTypes: true });
      const files = (await Promise.all(entries
        .filter((entry) => entry.isFile() && FINAL_FILE_PATTERN.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(SFX_DIR, entry.name);
          const info = await stat(filePath);
          return { filePath, size: info.size, mtimeMs: info.mtimeMs };
        })))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

      let totalBytes = files.reduce((total, file) => total + file.size, 0);
      const sweepAt = Date.now();
      const expiresBefore = sweepAt - CACHE_TTL_MS;
      for (const file of files) {
        if (isFileProtected(file.filePath, projectReferences, extraProtected)) continue;
        if (sweepAt - file.mtimeMs < PUBLICATION_GRACE_MS) continue;
        if (file.mtimeMs >= expiresBefore && totalBytes <= CACHE_MAX_BYTES) continue;
        await rm(file.filePath, { force: true });
        totalBytes -= file.size;
      }
    });
  } catch (error) {
    if (error instanceof ProjectReferenceSnapshotUnavailableError) return;
    throw error;
  }
}

function sweepCache(extraProtected?: string): Promise<void> {
  if (extraProtected) runtimeState.sweepExtraProtected.add(cachePathIdentity(extraProtected));
  if (runtimeState.sweepRunning) {
    runtimeState.sweepPending = true;
    return runtimeState.sweepRunning;
  }

  const sweep = (async () => {
    try {
      do {
        runtimeState.sweepPending = false;
        const protectedFiles = new Set(runtimeState.sweepExtraProtected);
        runtimeState.sweepExtraProtected.clear();
        await performCacheSweep(protectedFiles);
      } while (runtimeState.sweepPending);
    } catch (error) {
      runtimeState.sweepPending = false;
      runtimeState.sweepExtraProtected.clear();
      throw error;
    }
  })();
  runtimeState.sweepRunning = sweep.finally(() => {
    runtimeState.sweepRunning = null;
  });
  return runtimeState.sweepRunning;
}

async function readBody(req: Request): Promise<string> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new RequestTooLargeError();
  }
  if (!req.body) return "";

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function validatePayload(value: unknown):
  | { events: ValidatedEvent[]; durationMs: number }
  | { error: string } {
  if (!isRecord(value)) return { error: "payload must be an object" };
  if (Object.keys(value).some((key) => key !== "events" && key !== "durationMs")) {
    return { error: "payload must contain only events and durationMs" };
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    return { error: "events must be a non-empty array" };
  }
  if (value.events.length > MAX_EVENTS) {
    return { error: `events must contain at most ${MAX_EVENTS} items` };
  }
  if (
    typeof value.durationMs !== "number" ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs <= 0 ||
    value.durationMs > MAX_DURATION_MS
  ) {
    return { error: `durationMs must be a positive integer no greater than ${MAX_DURATION_MS}` };
  }

  const durationMs = value.durationMs;
  const events: ValidatedEvent[] = [];
  for (let index = 0; index < value.events.length; index += 1) {
    const event = value.events[index];
    if (!isRecord(event) || Object.keys(event).some((key) => key !== "sfx" && key !== "atMs")) {
      return { error: `events[${index}] must contain only sfx and atMs` };
    }
    if (typeof event.sfx !== "string" || !EFFECT_KEYS.has(event.sfx)) {
      return { error: `events[${index}].sfx is unknown` };
    }
    if (typeof event.atMs !== "number" || !Number.isFinite(event.atMs) || event.atMs < 0) {
      return { error: `events[${index}].atMs must be a finite nonnegative number` };
    }
    const atMs = Math.round(event.atMs);
    if (atMs >= durationMs) {
      return { error: `events[${index}].atMs must be within the track` };
    }
    events.push({ sfx: event.sfx, at_ms: atMs });
  }
  return { events, durationMs };
}

async function engineIsInstalled(): Promise<boolean> {
  try {
    const files = await Promise.all([
      stat(path.join(ENGINE_DIR, "build_sfx_track.py")),
      stat(path.join(ENGINE_DIR, "pyproject.toml")),
      stat(path.join(ENGINE_DIR, "uv.lock")),
      stat(path.join(ENGINE_DIR, "sfx-catalog.json")),
      ...SFX_ASSET_NAMES.map((name) => stat(path.join(ENGINE_DIR, "sfx", name))),
    ]);
    return files.every((file) => file.isFile());
  } catch {
    return false;
  }
}

async function inspectWav(filePath: string, requestedDurationMs?: number): Promise<WavInfo | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const file = await stat(filePath);
    if (!file.isFile() || file.size < 44) return null;
    handle = await open(filePath, "r");
    const header = Buffer.alloc(Math.min(file.size, 64 * 1024));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
      return null;
    }

    let offset = 12;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let blockAlign = 0;
    let dataSize = 0;
    let dataStart = 0;
    while (offset + 8 <= bytes.length) {
      const chunkId = bytes.toString("ascii", offset, offset + 4);
      const chunkSize = bytes.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (chunkId === "fmt " && chunkSize >= 16 && chunkStart + 16 <= bytes.length) {
        if (bytes.readUInt16LE(chunkStart) !== 1) return null;
        channels = bytes.readUInt16LE(chunkStart + 2);
        sampleRate = bytes.readUInt32LE(chunkStart + 4);
        blockAlign = bytes.readUInt16LE(chunkStart + 12);
        bitsPerSample = bytes.readUInt16LE(chunkStart + 14);
      } else if (chunkId === "data") {
        dataSize = chunkSize;
        dataStart = chunkStart;
        break;
      }
      offset = chunkStart + chunkSize + (chunkSize % 2);
    }

    if (
      channels !== 2 ||
      sampleRate !== 48_000 ||
      bitsPerSample !== 16 ||
      blockAlign !== 4 ||
      dataSize <= 0 ||
      dataStart + dataSize > file.size ||
      dataSize % blockAlign !== 0
    ) {
      return null;
    }
    const durationMs = (dataSize / blockAlign / sampleRate) * 1000;
    if (requestedDurationMs !== undefined && Math.abs(durationMs - requestedDurationMs) > 50) return null;
    return { size: file.size, durationMs };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function errorOutcome(code: string, error: string, status: number): RenderOutcome {
  return { status, body: { code, error } };
}

function unavailableOutcome(): RenderOutcome {
  return errorOutcome(
    "SFX_ENGINE_UNAVAILABLE",
    "The local SFX engine is unavailable. Install uv from https://docs.astral.sh/uv/getting-started/installation/, then run: uv sync --frozen --project scripts/sfx-engine",
    503
  );
}

function unavailableResponse(): Response {
  return outcomeResponse(unavailableOutcome());
}

function resultOutcome(outPath: string): RenderOutcome {
  return {
    status: 200,
    body: {
      ok: true,
      path: outPath,
      url: `/api/repurpose/sfx?path=${encodeURIComponent(outPath)}`,
    },
  };
}

function processErrorCode(error: unknown): string | number | undefined {
  return isRecord(error) && (typeof error.code === "string" || typeof error.code === "number")
    ? error.code
    : undefined;
}

function cacheErrorOutcome(): RenderOutcome {
  return errorOutcome("SFX_CACHE_UNAVAILABLE", "The local SFX cache is unavailable", 500);
}

function isCacheError(error: unknown): boolean {
  return ["EACCES", "EPERM", "EROFS", "ENOSPC", "EMFILE", "ENFILE", "ENOENT", "EISDIR", "ENOTDIR", "EEXIST"].includes(
    String(processErrorCode(error))
  );
}

async function renderTrack(
  validated: { events: ValidatedEvent[]; durationMs: number },
  hash: string,
  signal: AbortSignal
): Promise<RenderOutcome> {
  const finalPath = path.join(SFX_DIR, `sfx-${hash}.wav`);
  const unique = randomUUID();
  const eventsPath = path.join(SFX_DIR, `sfx-${hash}-${unique}.events.json`);
  const partialPath = path.join(SFX_DIR, `sfx-${hash}-${unique}.partial.wav`);
  runtimeState.activeFiles.add(cachePathIdentity(finalPath));
  runtimeState.activeFiles.add(cachePathIdentity(eventsPath));
  runtimeState.activeFiles.add(cachePathIdentity(partialPath));

  try {
    await mkdir(SFX_DIR, { recursive: true });
    await sweepCache(finalPath);
    if (await inspectWav(finalPath, validated.durationMs)) return resultOutcome(finalPath);
    await rm(finalPath, { force: true });
    await writeFile(eventsPath, JSON.stringify(validated.events), { encoding: "utf8", flag: "wx" });
    try {
      await execFileAsync(
        "uv",
        [
          "run",
          "--frozen",
          "python",
          "build_sfx_track.py",
          "--events-json",
          eventsPath,
          "--output",
          partialPath,
          "--duration-ms",
          String(validated.durationMs),
        ],
        {
          cwd: ENGINE_DIR,
          maxBuffer: MAX_ENGINE_BUFFER,
          timeout: ENGINE_TIMEOUT_MS,
          signal,
          shell: false,
        }
      );
    } catch (error) {
      if (processErrorCode(error) === "ENOENT") throw new EngineUnavailableError();
      throw error;
    }

    if (!(await inspectWav(partialPath, validated.durationMs))) {
      return errorOutcome("SFX_INVALID_OUTPUT", "SFX engine produced an invalid WAV", 500);
    }
    if (!(await inspectWav(finalPath, validated.durationMs))) {
      try {
        await rename(partialPath, finalPath);
      } catch (error) {
        if (!(await inspectWav(finalPath, validated.durationMs))) {
          if (isCacheError(error)) throw error;
          return errorOutcome("SFX_PUBLICATION_FAILED", "SFX track could not be published", 500);
        }
      }
    }
    if (!(await inspectWav(finalPath, validated.durationMs))) {
      return errorOutcome("SFX_PUBLICATION_FAILED", "SFX track could not be published", 500);
    }
    await sweepCache(finalPath);
    return resultOutcome(finalPath);
  } catch (error) {
    if (error instanceof EngineUnavailableError) return unavailableOutcome();
    if (isCacheError(error)) return cacheErrorOutcome();
    if (signal.aborted) {
      return errorOutcome("SFX_RENDER_ABORTED", "SFX rendering was cancelled", 499);
    }
    if (isRecord(error) && (error.killed === true || error.signal)) {
      return errorOutcome("SFX_RENDER_TIMEOUT", "SFX rendering timed out", 504);
    }
    return errorOutcome("SFX_RENDER_FAILED", "SFX rendering failed", 500);
  } finally {
    await Promise.all([
      rm(eventsPath, { force: true }).catch(() => {}),
      rm(partialPath, { force: true }).catch(() => {}),
    ]);
    runtimeState.activeFiles.delete(cachePathIdentity(eventsPath));
    runtimeState.activeFiles.delete(cachePathIdentity(partialPath));
    runtimeState.activeFiles.delete(cachePathIdentity(finalPath));
  }
}

function abortedOutcome(): RenderOutcome {
  return errorOutcome("SFX_RENDER_ABORTED", "SFX rendering was cancelled", 499);
}

function busyOutcome(): RenderOutcome {
  return {
    ...errorOutcome("SFX_RENDER_BUSY", "SFX render capacity is temporarily full", 429),
    headers: { "Retry-After": "1" },
  };
}

function createRenderJob(
  hash: string,
  validated: { events: ValidatedEvent[]; durationMs: number }
): RenderJob {
  let resolve!: (outcome: RenderOutcome) => void;
  const promise = new Promise<RenderOutcome>((jobResolve) => {
    resolve = jobResolve;
  });
  const controller = new AbortController();
  return {
    hash,
    validated,
    controller,
    waiters: new Set(),
    state: "queued",
    promise,
    resolve,
    run: () => renderTrack(validated, hash, controller.signal),
  };
}

function settleRenderJob(job: RenderJob, outcome: RenderOutcome): void {
  if (job.state === "settled") return;
  const wasRunning = job.state === "running";
  job.state = "settled";
  if (runtimeState.jobs.get(job.hash) === job) runtimeState.jobs.delete(job.hash);
  job.resolve(outcome);
  if (wasRunning) runtimeState.running -= 1;
  startQueuedRenderJobs();
}

function startRenderJob(job: RenderJob): void {
  if (job.state === "settled") return;
  if (job.waiters.size === 0) {
    job.controller.abort();
    settleRenderJob(job, abortedOutcome());
    return;
  }
  job.state = "running";
  runtimeState.running += 1;
  void job.run()
    .then((outcome) => settleRenderJob(job, outcome))
    .catch(() => settleRenderJob(
      job,
      errorOutcome("SFX_RENDER_FAILED", "SFX rendering failed", 500)
    ));
}

function startQueuedRenderJobs(): void {
  while (runtimeState.running < MAX_CONCURRENT_RENDERS) {
    const job = runtimeState.queue.shift();
    if (!job) return;
    startRenderJob(job);
  }
}

function enqueueRenderJob(job: RenderJob): void {
  if (runtimeState.running < MAX_CONCURRENT_RENDERS) startRenderJob(job);
  else runtimeState.queue.push(job);
}

function cancelUnobservedRenderJob(job: RenderJob): void {
  if (job.waiters.size > 0 || job.state === "settled") return;
  job.controller.abort();
  if (runtimeState.jobs.get(job.hash) === job) runtimeState.jobs.delete(job.hash);
  if (job.state === "queued") {
    const queueIndex = runtimeState.queue.indexOf(job);
    if (queueIndex >= 0) runtimeState.queue.splice(queueIndex, 1);
    settleRenderJob(job, abortedOutcome());
  }
}

function waitForRenderJob(job: RenderJob, signal: AbortSignal): Promise<RenderOutcome> {
  if (signal.aborted) {
    cancelUnobservedRenderJob(job);
    return Promise.resolve(abortedOutcome());
  }
  const waiter = Symbol("sfx-render-waiter");
  job.waiters.add(waiter);
  return new Promise<RenderOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: RenderOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      job.waiters.delete(waiter);
      resolve(outcome);
    };
    const onAbort = () => {
      finish(abortedOutcome());
      cancelUnobservedRenderJob(job);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void job.promise.then(finish);
  });
}

export async function POST(req: Request): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return json({ code: "SFX_PAYLOAD_TOO_LARGE", error: "request body is too large" }, 413);
    }
    return json({ code: "SFX_INVALID_PAYLOAD", error: "could not read request body" }, 400);
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return json({ code: "SFX_INVALID_PAYLOAD", error: "expected JSON body" }, 400);
  }
  const validated = validatePayload(rawPayload);
  if ("error" in validated) {
    return json({ code: "SFX_INVALID_PAYLOAD", error: validated.error }, 400);
  }
  if (!(await engineIsInstalled())) return unavailableResponse();

  const hash = createHash("sha256")
    .update(JSON.stringify({ events: validated.events, durationMs: validated.durationMs }))
    .digest("hex");
  if (req.signal.aborted) return outcomeResponse(abortedOutcome());

  let job = runtimeState.jobs.get(hash);
  let created = false;
  if (job && job.waiters.size >= MAX_WAITERS_PER_JOB) {
    return outcomeResponse(busyOutcome());
  }
  if (!job) {
    if (
      runtimeState.running >= MAX_CONCURRENT_RENDERS
      && runtimeState.queue.length >= MAX_QUEUED_RENDERS
    ) {
      return outcomeResponse(busyOutcome());
    }
    job = createRenderJob(hash, validated);
    runtimeState.jobs.set(hash, job);
    created = true;
  }
  const outcome = waitForRenderJob(job, req.signal);
  if (created) enqueueRenderJob(job);
  return outcomeResponse(await outcome);
}

function generatedWavCandidate(rawPath: string): string | null {
  if (!path.isAbsolute(rawPath) || !FINAL_FILE_PATTERN.test(path.basename(rawPath))) return null;
  const candidate = path.normalize(path.resolve(rawPath));
  return isUnder(SFX_DIR, candidate) ? candidate : null;
}

async function resolveGeneratedWav(candidate: string): Promise<string | null> {
  try {
    const [root, resolved] = await Promise.all([realpath(SFX_DIR), realpath(candidate)]);
    return isUnder(root, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function acquireServingLease(filePath: string): (requestSweep: boolean) => void {
  const identity = cachePathIdentity(filePath);
  runtimeState.servingFiles.set(identity, (runtimeState.servingFiles.get(identity) ?? 0) + 1);
  let released = false;
  return (requestSweep: boolean) => {
    if (released) return;
    released = true;
    const remaining = (runtimeState.servingFiles.get(identity) ?? 1) - 1;
    if (remaining > 0) runtimeState.servingFiles.set(identity, remaining);
    else runtimeState.servingFiles.delete(identity);
    if (requestSweep) void sweepCache().catch(() => {});
  };
}

function leasedFileStream(
  filePath: string,
  release: (requestSweep: boolean) => void,
  range?: { start: number; end: number }
): ReadableStream<Uint8Array> {
  const source = Readable.toWeb(createReadStream(filePath, range)) as unknown as ReadableStream<Uint8Array>;
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          release(true);
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        release(true);
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release(true);
      }
    },
  });
}

function fileStream(
  filePath: string,
  range?: { start: number; end: number }
): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(filePath, range)) as unknown as ReadableStream<Uint8Array>;
}

function wavResponse(
  request: Request,
  size: number,
  createBody: (range?: { start: number; end: number }) => ReadableStream<Uint8Array>
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    });
  }

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }
  const responseHeaders = !range
    ? { ...headers, "Content-Length": String(size) }
    : {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      };
  const status = range ? 206 : 200;
  return new Response(createBody(range ?? undefined), { status, headers: responseHeaders });
}

async function resolveBuiltInWav(rawKey: string): Promise<{ filePath: string; size: number } | null> {
  const metadata = getSfxCatalogEntry(rawKey);
  if (!metadata) return null;
  try {
    const sfxRoot = await realpath(path.join(ENGINE_DIR, "sfx"));
    const filePath = await realpath(path.join(sfxRoot, metadata.filename));
    if (!isUnder(sfxRoot, filePath)) return null;
    const info = await stat(filePath);
    return info.isFile() ? { filePath, size: info.size } : null;
  } catch {
    return null;
  }
}

async function serveBuiltInWav(request: Request, rawKey: string): Promise<Response> {
  const asset = await resolveBuiltInWav(rawKey);
  if (!asset) return new Response("Not found", { status: 404 });
  return wavResponse(request, asset.size, (range) => fileStream(asset.filePath, range));
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const hasKey = params.has("key");
  const hasPath = params.has("path");
  if (hasKey === hasPath) return new Response("Supply exactly one SFX source", { status: 400 });
  if (hasKey) {
    const keys = params.getAll("key");
    return keys.length === 1
      ? serveBuiltInWav(request, keys[0])
      : new Response("Not found", { status: 404 });
  }

  const rawPath = params.get("path");
  if (rawPath === null) return new Response("Supply exactly one SFX source", { status: 400 });
  if (rawPath === "") return new Response("Missing ?path", { status: 400 });
  const candidate = generatedWavCandidate(rawPath);
  if (!candidate) return new Response("Not found", { status: 404 });
  let leasedPath = candidate;
  let release = acquireServingLease(leasedPath);
  let streamOwnsLease = false;
  let validAsset = false;
  try {
    const filePath = await resolveGeneratedWav(candidate);
    if (!filePath) return new Response("Not found", { status: 404 });
    if (filePath !== leasedPath) {
      const releaseResolvedPath = acquireServingLease(filePath);
      release(false);
      release = releaseResolvedPath;
      leasedPath = filePath;
    }

    const wav = await inspectWav(filePath);
    if (!wav) {
      return json({ code: "SFX_INVALID_CACHE_ENTRY", error: "Cached SFX track is invalid" }, 404);
    }
    validAsset = true;
    const response = wavResponse(
      request,
      wav.size,
      (range) => leasedFileStream(filePath, release, range)
    );
    if (request.method === "HEAD" || !response.body) return response;
    streamOwnsLease = true;
    return response;
  } finally {
    if (!streamOwnsLease) release(validAsset);
  }
}

export async function HEAD(request: Request): Promise<Response> {
  const headRequest = request.method === "HEAD"
    ? request
    : new Request(request, { method: "HEAD" });
  const response = await GET(headRequest);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function outcomeResponse(outcome: RenderOutcome): Response {
  return json(outcome.body, outcome.status, outcome.headers);
}
