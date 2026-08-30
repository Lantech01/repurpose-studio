import {
  parseStartTranscriptionRequest,
  TRANSCRIPTION_ERROR_MESSAGES,
  type TranscriptionErrorCode,
} from "@/lib/repurpose/transcription-contract";
import { getTranscriptionRuntime } from "@/lib/repurpose/transcription-runtime.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_REQUEST_BYTES = 16 * 1024;

const ERROR_STATUS: Readonly<Partial<Record<TranscriptionErrorCode, number>>> = {
  TRANSCRIPTION_INVALID_REQUEST: 400,
  TRANSCRIPTION_SOURCE_INVALID: 400,
  TRANSCRIPTION_SOURCE_TOO_LONG: 400,
  TRANSCRIPTION_AUDIO_MISSING: 400,
  TRANSCRIPTION_OBSERVER_CONFLICT: 409,
  TRANSCRIPTION_SOURCE_CHANGED: 409,
  TRANSCRIPTION_PAYLOAD_TOO_LARGE: 413,
  TRANSCRIPTION_BUSY: 429,
  TRANSCRIPTION_AUDIO_EXTRACTION_FAILED: 500,
  TRANSCRIPTION_ENGINE_FAILED: 500,
  TRANSCRIPTION_INVALID_OUTPUT: 500,
  TRANSCRIPTION_ENGINE_UNAVAILABLE: 503,
  TRANSCRIPTION_MODEL_DOWNLOAD_FAILED: 503,
  TRANSCRIPTION_PREPARATION_TIMEOUT: 504,
  TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT: 504,
  TRANSCRIPTION_SETUP_TIMEOUT: 504,
  TRANSCRIPTION_TIMEOUT: 504,
};

function noStoreHeaders(extra?: Record<string, string>): HeadersInit {
  return { "Cache-Control": "no-store", ...extra };
}

function errorResponse(code: TranscriptionErrorCode): Response {
  const supportedCode = ERROR_STATUS[code] ? code : "TRANSCRIPTION_ENGINE_FAILED";
  return Response.json(
    { error: { code: supportedCode, message: TRANSCRIPTION_ERROR_MESSAGES[supportedCode] } },
    {
      status: ERROR_STATUS[supportedCode],
      headers: noStoreHeaders(supportedCode === "TRANSCRIPTION_BUSY" ? { "Retry-After": "5" } : undefined),
    },
  );
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw Object.assign(new Error("request too large"), { code: "TRANSCRIPTION_PAYLOAD_TOO_LARGE" });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request): Promise<Response> {
  if (request.signal.aborted) return new Response(null, { status: 204, headers: noStoreHeaders() });
  let parsed;
  try {
    const encoded = await readBoundedBody(request);
    parsed = parseStartTranscriptionRequest(JSON.parse(new TextDecoder().decode(encoded)));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 204, headers: noStoreHeaders() });
    const code = (error as { code?: unknown }).code;
    return errorResponse(code === "TRANSCRIPTION_PAYLOAD_TOO_LARGE"
      ? "TRANSCRIPTION_PAYLOAD_TOO_LARGE"
      : "TRANSCRIPTION_INVALID_REQUEST");
  }
  if (request.signal.aborted) return new Response(null, { status: 204, headers: noStoreHeaders() });

  const transcriptionRuntime = getTranscriptionRuntime();
  try {
    const response = await transcriptionRuntime.start(parsed, request.signal);
    if (request.signal.aborted) {
      transcriptionRuntime.release(response.jobId);
      return new Response(null, { status: 204, headers: noStoreHeaders() });
    }
    return Response.json(response, { status: 202, headers: noStoreHeaders() });
  } catch (error) {
    if (request.signal.aborted || (error as { code?: unknown }).code === "TRANSCRIPTION_CANCELLED") {
      return new Response(null, { status: 204, headers: noStoreHeaders() });
    }
    return errorResponse((error as { code?: TranscriptionErrorCode }).code ?? "TRANSCRIPTION_ENGINE_FAILED");
  }
}
