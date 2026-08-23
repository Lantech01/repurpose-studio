import { MediaInspectionError, inspectMedia } from "@/lib/repurpose/media-inspection.server";
import { resolveAllowedVideoPath } from "@/lib/repurpose/media-paths.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const requestedPath = new URL(request.url).searchParams.get("path") ?? "";
  const mediaPath = await resolveAllowedVideoPath(requestedPath);
  if (!mediaPath) return errorResponse("MEDIA_PATH_INVALID", "Select a local video file.", 400);

  try {
    return Response.json(await inspectMedia(mediaPath));
  } catch (cause) {
    if (cause instanceof MediaInspectionError) {
      const status = cause.code === "FFPROBE_UNAVAILABLE" ? 503 : 422;
      return errorResponse(cause.code, cause.message, status);
    }
    return errorResponse("MEDIA_INVALID", "This file is not a readable video.", 422);
  }
}
