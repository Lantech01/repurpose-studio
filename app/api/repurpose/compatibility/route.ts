import { compatibilityCache, type CompatibilityCache } from "@/lib/repurpose/compatibility-cache.server";
import { MediaInspectionError, inspectMedia } from "@/lib/repurpose/media-inspection.server";
import { resolveAllowedVideoPath } from "@/lib/repurpose/media-paths.server";
import type { MediaInspection } from "@/lib/repurpose/media-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FINGERPRINT = /^[a-f0-9]{64}$/;

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json() as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function inspectionError(error: unknown): Response {
  const code = error instanceof MediaInspectionError ? error.code : (error as { code?: unknown }).code;
  if (code === "FFPROBE_UNAVAILABLE") return errorResponse("FFPROBE_UNAVAILABLE", "Media inspection is unavailable.", 503);
  if (code === "MEDIA_PROBE_TIMEOUT") return errorResponse("MEDIA_PROBE_TIMEOUT", "Media inspection timed out.", 504);
  if (code === "MEDIA_PROBE_ABORTED") return errorResponse("MEDIA_PROBE_ABORTED", "Media inspection was cancelled.", 408);
  if (code === "MEDIA_CHANGED") return errorResponse("MEDIA_CHANGED", "The media changed during inspection. Try again.", 409);
  return errorResponse("MEDIA_INVALID", "This file is not a readable video.", 422);
}

function createCompatibilityRouteHandlers(dependencies: {
  cache: Pick<CompatibilityCache, "get" | "start" | "cancel">;
  resolvePath: (requestedPath: string) => Promise<string | null>;
  inspect: (mediaPath: string, options: { signal: AbortSignal }) => Promise<MediaInspection>;
}) {
  return {
    async GET(request: Request): Promise<Response> {
      const fingerprint = new URL(request.url).searchParams.get("fingerprint") ?? "";
      if (!FINGERPRINT.test(fingerprint)) {
        return errorResponse("COMPATIBILITY_FINGERPRINT_INVALID", "A valid media fingerprint is required.", 400);
      }
      return Response.json(dependencies.cache.get(fingerprint));
    },

    async POST(request: Request): Promise<Response> {
      const body = await jsonObject(request);
      const requestedPath = typeof body?.path === "string" ? body.path : "";
      const expectedFingerprint = body?.fingerprint;
      if (!requestedPath || (expectedFingerprint !== undefined
        && (typeof expectedFingerprint !== "string" || !FINGERPRINT.test(expectedFingerprint)))) {
        return errorResponse("COMPATIBILITY_INPUT_INVALID", "Select a valid local video file.", 400);
      }
      const originalPath = await dependencies.resolvePath(requestedPath);
      if (!originalPath) return errorResponse("MEDIA_PATH_INVALID", "Select a local video file.", 400);

      let inspection: MediaInspection;
      try {
        inspection = await dependencies.inspect(originalPath, { signal: request.signal });
      } catch (error) {
        return inspectionError(error);
      }
      if (typeof expectedFingerprint === "string" && expectedFingerprint !== inspection.fingerprint) {
        return errorResponse("MEDIA_CHANGED", "The media changed during inspection. Try again.", 409);
      }
      try {
        const state = await dependencies.cache.start({ originalPath, inspection });
        return Response.json(state, { status: state.status === "ready" ? 200 : 202 });
      } catch {
        return errorResponse("COMPATIBILITY_START_FAILED", "Video conversion could not be started.", 500);
      }
    },

    async DELETE(request: Request): Promise<Response> {
      const body = await jsonObject(request);
      const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : "";
      if (!FINGERPRINT.test(fingerprint)) {
        return errorResponse("COMPATIBILITY_FINGERPRINT_INVALID", "A valid media fingerprint is required.", 400);
      }
      return Response.json(await dependencies.cache.cancel(fingerprint));
    },
  };
}

const handlers = createCompatibilityRouteHandlers({
  cache: compatibilityCache,
  resolvePath: resolveAllowedVideoPath,
  inspect: inspectMedia,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
