import { useRepurposeStore } from "./store";

const SFX_EXTENSIONS = new Set(["wav", "mp3", "m4a"]);
const SFX_MIME_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
]);

export interface SfxImportOwner {
  readonly id: number;
  readonly projectId: string;
}

export interface SfxImportResult {
  assetId: string;
  clipId: string;
}

interface SfxImportOperation {
  owner: SfxImportOwner;
  controller: AbortController;
  projectEpoch: number;
  atTime: number;
}

let ownerId = 0;
let activeOwner: SfxImportOwner | null = null;
let activeOperation: SfxImportOperation | null = null;

function abortError(): DOMException {
  return new DOMException("The SFX import was cancelled", "AbortError");
}

export function classifySfxFile(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return SFX_EXTENSIONS.has(extension) || SFX_MIME_TYPES.has(file.type.toLowerCase());
}

export function createSfxImportOwner(projectId: string): SfxImportOwner {
  return { id: ++ownerId, projectId };
}

export function registerSfxImportOwner(owner: SfxImportOwner): SfxImportOwner {
  activeOperation?.controller.abort();
  activeOperation = null;
  activeOwner = owner;
  return owner;
}

export function releaseSfxImportOwner(owner: SfxImportOwner): void {
  if (activeOperation?.owner === owner) {
    activeOperation.controller.abort();
    activeOperation = null;
  }
  if (activeOwner === owner) activeOwner = null;
}

export function cancelSfxImport(owner: SfxImportOwner): void {
  if (activeOperation?.owner === owner) activeOperation.controller.abort();
}

function assertOwned(operation: SfxImportOperation): void {
  if (
    operation.controller.signal.aborted
    || activeOperation !== operation
    || activeOwner !== operation.owner
    || useRepurposeStore.getState().projectEpoch !== operation.projectEpoch
  ) throw abortError();
}

function uploadName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (stem.length >= 2 ? stem : "sound-effect").slice(0, 61);
}

async function upload(file: File, signal: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", uploadName(file.name));
  const response = await fetch("/api/repurpose/asset", { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(`Sound-effect upload failed (${response.status}).`);
  const body = await response.json() as { ok?: boolean; path?: string; error?: string };
  if (!body.ok || typeof body.path !== "string" || body.path.length === 0) {
    throw new Error(body.error || "Sound-effect upload returned no saved path.");
  }
  return body.path;
}

export async function probeSfxDuration(url: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const Ctor = typeof window === "undefined"
    ? undefined
    : window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("This browser cannot decode the selected sound effect.");
  const context = new Ctor();
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Saved sound effect could not be read (${response.status}).`);
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    signal.throwIfAborted();
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new Error("The selected sound effect has no usable duration.");
    }
    return buffer.duration;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error instanceof Error
      ? new Error(`Could not decode the selected sound effect: ${error.message}`)
      : new Error("Could not decode the selected sound effect.");
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function importSfxFile(
  file: File,
  atTime: number,
  owner: SfxImportOwner,
  dependencies: { probeDuration?: (url: string, signal: AbortSignal) => Promise<number> } = {}
): Promise<SfxImportResult> {
  if (!classifySfxFile(file)) {
    throw new Error("Choose a .wav, .mp3, or .m4a sound-effect file.");
  }
  if (activeOwner !== owner) throw abortError();
  activeOperation?.controller.abort();
  const operation: SfxImportOperation = {
    owner,
    controller: new AbortController(),
    projectEpoch: useRepurposeStore.getState().projectEpoch,
    atTime,
  };
  activeOperation = operation;
  try {
    const sourcePath = await upload(file, operation.controller.signal);
    assertOwned(operation);
    const url = `/api/repurpose/asset?path=${encodeURIComponent(sourcePath)}`;
    const duration = await (dependencies.probeDuration ?? probeSfxDuration)(url, operation.controller.signal);
    assertOwned(operation);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("The selected sound effect has no usable duration.");
    }
    const result = useRepurposeStore.getState().addImportedSfxClip({
      name: file.name || "Imported sound effect",
      sourcePath,
      srcDuration: duration,
      atTime: operation.atTime,
    });
    if (!result) throw new Error("The sound effect cannot be placed outside this reel.");
    assertOwned(operation);
    return result;
  } finally {
    if (activeOperation === operation) activeOperation = null;
  }
}
