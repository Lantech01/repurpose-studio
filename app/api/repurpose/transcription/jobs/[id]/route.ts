import {
  TRANSCRIPTION_ERROR_MESSAGES,
  type TranscriptionErrorCode,
} from "@/lib/repurpose/transcription-contract";
import { getTranscriptionRuntime } from "@/lib/repurpose/transcription-runtime.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(code: Extract<TranscriptionErrorCode, "TRANSCRIPTION_INVALID_REQUEST" | "TRANSCRIPTION_NOT_FOUND">): Response {
  return Response.json(
    { error: { code, message: TRANSCRIPTION_ERROR_MESSAGES[code] } },
    { status: code === "TRANSCRIPTION_NOT_FOUND" ? 404 : 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  if (!UUID.test(id)) return errorResponse("TRANSCRIPTION_INVALID_REQUEST");
  const status = getTranscriptionRuntime().get(id);
  if (!status) return errorResponse("TRANSCRIPTION_NOT_FOUND");
  return Response.json(status, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  if (!UUID.test(id)) return errorResponse("TRANSCRIPTION_INVALID_REQUEST");
  getTranscriptionRuntime().release(id);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
