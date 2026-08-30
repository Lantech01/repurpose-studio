// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseStartTranscriptionResponse,
  parseTranscriptionErrorResponse,
  parseTranscriptionStatus,
  TRANSCRIPTION_ERROR_MESSAGES,
  type TranscriptionErrorCode,
  type TranscriptionStatus,
} from "@/lib/repurpose/transcription-contract";

const runtimeMock = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  peek: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/repurpose/transcription-runtime.server", () => ({
  getTranscriptionRuntime: () => runtimeMock,
}));

import * as jobsRoute from "@/app/api/repurpose/transcription/jobs/route";
import * as jobRoute from "@/app/api/repurpose/transcription/jobs/[id]/route";

const ID = "00000000-0000-4000-8000-000000000001";
const PATH = `C:\\managed\\${"a".repeat(64)}.mp4`;

function post(body: string, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/repurpose/transcription/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
}

function context(id = ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function activeStatus(): TranscriptionStatus {
  return {
    jobId: ID,
    state: "running",
    phase: "transcribing",
    progress: 0.5,
    device: "cuda",
    warning: null,
    result: null,
    error: null,
  };
}

beforeEach(() => {
  runtimeMock.start.mockReset();
  runtimeMock.get.mockReset();
  runtimeMock.peek.mockReset();
  runtimeMock.release.mockReset();
  runtimeMock.release.mockReturnValue(false);
});

describe("POST /api/repurpose/transcription/jobs", () => {
  it.each([
    ["malformed JSON", "{"],
    ["unknown keys", JSON.stringify({ observerId: ID, path: PATH, language: "pt", output: "C:/private" })],
    ["invalid UUID", JSON.stringify({ observerId: "not-a-uuid", path: PATH, language: "pt" })],
    ["invalid language", JSON.stringify({ observerId: ID, path: PATH, language: "en" })],
    ["empty path", JSON.stringify({ observerId: ID, path: "", language: "pt" })],
  ])("returns a safe 400 for %s", async (_label, body) => {
    const response = await jobsRoute.POST(post(body));
    expect(response.status).toBe(400);
    expect(parseTranscriptionErrorResponse(await response.json(), response.status).error.code)
      .toBe("TRANSCRIPTION_INVALID_REQUEST");
    expect(runtimeMock.start).not.toHaveBeenCalled();
  });

  it("reads at most 16 KiB and rejects an oversized body", async () => {
    const response = await jobsRoute.POST(post(JSON.stringify({
      observerId: ID,
      path: "x".repeat(16 * 1024),
      language: "pt",
    })));
    expect(response.status).toBe(413);
    expect(parseTranscriptionErrorResponse(await response.json(), response.status).error.code)
      .toBe("TRANSCRIPTION_PAYLOAD_TOO_LARGE");
    expect(runtimeMock.start).not.toHaveBeenCalled();
  });

  it("returns decoder-valid 202 and no-store for accepted and idempotent starts", async () => {
    runtimeMock.start.mockResolvedValue({ jobId: ID });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await jobsRoute.POST(post(JSON.stringify({ observerId: ID, path: PATH, language: "pt" })));
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(parseStartTranscriptionResponse(await response.json())).toEqual({ jobId: ID });
    }
  });

  it("returns no 202 when aborted during admission", async () => {
    runtimeMock.start.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "TRANSCRIPTION_CANCELLED" }));
    const controller = new AbortController();
    controller.abort();
    const response = await jobsRoute.POST(post(JSON.stringify({ observerId: ID, path: PATH, language: "pt" }), controller.signal));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(runtimeMock.release).not.toHaveBeenCalled();
  });

  it("releases an attached observer if the request aborts before the response", async () => {
    const controller = new AbortController();
    runtimeMock.start.mockImplementation(async () => {
      controller.abort();
      return { jobId: ID };
    });
    const response = await jobsRoute.POST(post(JSON.stringify({ observerId: ID, path: PATH, language: "pt" }), controller.signal));
    expect(response.status).toBe(204);
    expect(runtimeMock.release).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("returns conflict and busy responses with safe bodies", async () => {
    runtimeMock.start.mockRejectedValueOnce(Object.assign(new Error(`private ${PATH}`), { code: "TRANSCRIPTION_OBSERVER_CONFLICT" }));
    const conflict = await jobsRoute.POST(post(JSON.stringify({ observerId: ID, path: PATH, language: "pt" })));
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(await conflict.json())).not.toContain(PATH);

    runtimeMock.start.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "TRANSCRIPTION_BUSY" }));
    const busy = await jobsRoute.POST(post(JSON.stringify({ observerId: ID, path: PATH, language: "pt" })));
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(parseTranscriptionErrorResponse(await busy.json(), busy.status).error.code).toBe("TRANSCRIPTION_BUSY");
  });

  it.each([
    [400, "TRANSCRIPTION_SOURCE_INVALID"],
    [400, "TRANSCRIPTION_SOURCE_TOO_LONG"],
    [400, "TRANSCRIPTION_AUDIO_MISSING"],
    [409, "TRANSCRIPTION_SOURCE_CHANGED"],
    [500, "TRANSCRIPTION_AUDIO_EXTRACTION_FAILED"],
    [500, "TRANSCRIPTION_ENGINE_FAILED"],
    [500, "TRANSCRIPTION_INVALID_OUTPUT"],
    [503, "TRANSCRIPTION_ENGINE_UNAVAILABLE"],
    [503, "TRANSCRIPTION_MODEL_DOWNLOAD_FAILED"],
    [504, "TRANSCRIPTION_PREPARATION_TIMEOUT"],
    [504, "TRANSCRIPTION_AUDIO_EXTRACTION_TIMEOUT"],
    [504, "TRANSCRIPTION_SETUP_TIMEOUT"],
    [504, "TRANSCRIPTION_TIMEOUT"],
  ] as const)("maps %s %s through the fixed contract", async (status, code) => {
    runtimeMock.start.mockRejectedValue(Object.assign(new Error(`do not expose ${PATH}`), { code }));
    const response = await jobsRoute.POST(post(JSON.stringify({ observerId: ID, path: PATH, language: "pt" })));
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(parseTranscriptionErrorResponse(body, response.status)).toEqual({
      error: { code, message: TRANSCRIPTION_ERROR_MESSAGES[code as TranscriptionErrorCode] },
    });
    expect(JSON.stringify(body)).not.toContain(PATH);
  });
});

describe("GET and DELETE /api/repurpose/transcription/jobs/[id]", () => {
  it("returns decoder-valid no-store active and completed statuses", async () => {
    runtimeMock.get.mockReturnValue(activeStatus());
    let response = await jobRoute.GET(new Request("http://localhost"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parseTranscriptionStatus(await response.json())).toEqual(activeStatus());

    const completed: TranscriptionStatus = {
      jobId: ID,
      state: "completed",
      phase: "finalizing",
      progress: 1,
      device: "cpu",
      warning: null,
      result: { words: [], language: "pt", languageProbability: 1, device: "cpu" },
      error: null,
    };
    runtimeMock.get.mockReturnValue(completed);
    response = await jobRoute.GET(new Request("http://localhost"), context());
    expect(parseTranscriptionStatus(await response.json())).toEqual(completed);
  });

  it("maps an unknown observer to 404 and an invalid route UUID to 400", async () => {
    runtimeMock.get.mockReturnValue(null);
    const missing = await jobRoute.GET(new Request("http://localhost"), context());
    expect(missing.status).toBe(404);
    expect(parseTranscriptionErrorResponse(await missing.json(), missing.status).error.code).toBe("TRANSCRIPTION_NOT_FOUND");

    const invalid = await jobRoute.GET(new Request("http://localhost"), context("not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(parseTranscriptionErrorResponse(await invalid.json(), invalid.status).error.code).toBe("TRANSCRIPTION_INVALID_REQUEST");
    expect(runtimeMock.get).toHaveBeenCalledOnce();
  });

  it("DELETE is idempotent, bodyless, and releases valid observers", async () => {
    runtimeMock.release.mockReturnValueOnce(true).mockReturnValueOnce(false);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await jobRoute.DELETE(new Request("http://localhost", { method: "DELETE" }), context());
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect(runtimeMock.release).toHaveBeenCalledTimes(2);

    const invalid = await jobRoute.DELETE(new Request("http://localhost", { method: "DELETE" }), context("bad"));
    expect(invalid.status).toBe(400);
    expect(parseTranscriptionErrorResponse(await invalid.json(), invalid.status).error.code).toBe("TRANSCRIPTION_INVALID_REQUEST");
  });
});

describe("route configuration", () => {
  it("uses short dynamic Node handlers", () => {
    expect(jobsRoute.runtime).toBe("nodejs");
    expect(jobsRoute.dynamic).toBe("force-dynamic");
    expect(jobsRoute.maxDuration).toBeLessThanOrEqual(60);
    expect(jobRoute.runtime).toBe("nodejs");
    expect(jobRoute.dynamic).toBe("force-dynamic");
  });
});
