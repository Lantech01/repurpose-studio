import path from "node:path";

import { VIDEO_EXTENSIONS } from "@/lib/repurpose/media-paths.server";
import { storeUploadedVideo } from "@/lib/repurpose/media-upload.server";
import type { VideoRole } from "@/lib/repurpose/media-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_ROLES: ReadonlySet<VideoRole> = new Set(["face", "screen", "overlay", "library"]);

function parseName(rawName: string | null): string | null {
  if (!rawName || rawName !== path.basename(rawName) || rawName.includes("\\") || rawName.includes("\0")) {
    return null;
  }
  return VIDEO_EXTENSIONS.has(path.extname(rawName).toLowerCase()) ? rawName : null;
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const name = parseName(url.searchParams.get("name"));
  const role = url.searchParams.get("role");
  if (!name || !role || !VIDEO_ROLES.has(role as VideoRole) || !request.body) {
    return new Response("Invalid footage upload", { status: 400 });
  }

  try {
    return Response.json(
      await storeUploadedVideo({
        body: request.body,
        name,
        role: role as VideoRole,
        signal: request.signal,
      })
    );
  } catch {
    return new Response("Footage upload failed", { status: 500 });
  }
}
