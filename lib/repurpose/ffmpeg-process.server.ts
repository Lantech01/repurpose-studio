import { spawn, type ChildProcess } from "node:child_process";

import type { MediaInspection } from "@/lib/repurpose/media-types";

export const MAX_PROCESS_DIAGNOSTIC_CHARS = 64 * 1024;

export function boundProcessDiagnostic(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-MAX_PROCESS_DIAGNOSTIC_CHARS);
}

export type CompatibilityEncoder =
  | "h264_nvenc"
  | "h264_qsv"
  | "h264_amf"
  | "h264_videotoolbox"
  | "libx264";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnedProcess {
  completion: Promise<ProcessResult>;
  kill: () => void | Promise<void>;
}

export interface ProcessAdapter {
  run: (
    executable: string,
    args: string[],
    options?: { onStdout?: (chunk: string) => void },
  ) => SpawnedProcess;
}

type OwnedChild = Pick<ChildProcess, "pid" | "exitCode" | "kill" | "once" | "removeListener">;

interface TerminationOptions {
  graceMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  killProcessGroup?: typeof process.kill;
}

function waitForChildClose(child: OwnedChild): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const closed = () => resolve();
    child.once("close", closed);
    if (child.exitCode !== null) {
      child.removeListener("close", closed);
      resolve();
    }
  });
}

function appendCause(primary: unknown, secondary: unknown): unknown {
  if (primary instanceof Error) {
    primary.cause = primary.cause === undefined
      ? secondary
      : new AggregateError([primary.cause, secondary], "Multiple process termination failures");
  }
  return primary;
}

export async function terminateOwnedProcessTree(
  child: OwnedChild,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
  options: TerminationOptions = {},
): Promise<void> {
  const childClosed = waitForChildClose(child);
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) {
    child.kill("SIGKILL");
    await childClosed;
    return;
  }
  const graceMs = options.graceMs ?? 2_000;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  if (platform === "win32") {
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawnProcess(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, shell: false, stdio: "ignore" },
      );
    } catch (error) {
      child.kill("SIGKILL");
      await childClosed;
      throw error;
    }

    let taskkillError: unknown;
    const taskkillCompleted = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        taskkillError = error;
        resolve();
      };
      killer.once("error", finish);
      killer.once("close", (code) => finish(code === 0 ? undefined : new Error(`taskkill exited with code ${code ?? -1}`)));
    });
    let escalationError: unknown;
    const escalation = setTimer(() => {
      try {
        killer.kill("SIGKILL");
      } catch (error) {
        escalationError = error;
      }
      try {
        child.kill("SIGKILL");
      } catch (error) {
        escalationError = escalationError ? appendCause(escalationError, error) : error;
      }
    }, graceMs);
    await taskkillCompleted;
    if (taskkillError) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        taskkillError = appendCause(taskkillError, error);
      }
    }
    await childClosed;
    clearTimer(escalation);
    if (taskkillError) throw taskkillError;
    if (escalationError) throw escalationError;
    return;
  }

  const killProcessGroup = options.killProcessGroup ?? process.kill;
  let terminationError: unknown;
  try {
    killProcessGroup(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") terminationError = error;
    try {
      child.kill("SIGTERM");
    } catch (fallbackError) {
      terminationError = terminationError ? appendCause(terminationError, fallbackError) : fallbackError;
    }
  }
  const escalation = setTimer(() => {
    try {
      killProcessGroup(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        terminationError = terminationError ? appendCause(terminationError, error) : error;
      }
    }
  }, graceMs);
  await childClosed;
  clearTimer(escalation);
  if (terminationError) throw terminationError;
}

export interface CompatibilityEncodeRequest {
  inputPath: string;
  outputPath: string;
  inspection: MediaInspection;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}

export interface CompatibilityEncoderRunner {
  encode: (request: CompatibilityEncodeRequest) => Promise<{ encoder: CompatibilityEncoder }>;
}

export class FfmpegProcessError extends Error {
  constructor(
    public readonly code: "FFMPEG_UNAVAILABLE" | "COMPATIBILITY_ENCODE_FAILED" | "COMPATIBILITY_CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "FfmpegProcessError";
  }
}

const PLATFORM_ENCODERS: Record<"win32" | "darwin" | "linux", readonly CompatibilityEncoder[]> = {
  win32: ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"],
  darwin: ["h264_videotoolbox", "libx264"],
  linux: ["h264_nvenc", "h264_qsv", "libx264"],
};

const ENCODER_ARGUMENTS: Record<CompatibilityEncoder, readonly string[]> = {
  h264_nvenc: ["-preset", "p7", "-cq", "18", "-b:v", "0"],
  h264_qsv: ["-preset", "medium", "-global_quality", "18"],
  h264_amf: ["-quality", "quality", "-qp_i", "18", "-qp_p", "18"],
  h264_videotoolbox: ["-q:v", "65"],
  libx264: ["-preset", "medium", "-crf", "18"],
};

export function createNodeProcessAdapter(options: {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
} = {}): ProcessAdapter {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  return {
    run(executable, args, options = {}) {
      let child: ReturnType<typeof spawn> | undefined;
      let stdout = "";
      let stderr = "";
      let callbackFailed = false;
      let callbackError: unknown;
      let processError: unknown;
      let termination: Promise<void> | undefined;
      const terminate = () => {
        if (!child || child.exitCode !== null) return Promise.resolve();
        if (!termination) {
          termination = terminateOwnedProcessTree(child, platform, spawnProcess);
          void termination.catch(() => undefined);
        }
        return termination;
      };
      const completion = new Promise<ProcessResult>((resolve, reject) => {
        try {
          child = spawnProcess(executable, args, {
            windowsHide: true,
            shell: false,
            detached: platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          reject(error);
          return;
        }
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout = boundProcessDiagnostic(stdout, chunk);
          try {
            options.onStdout?.(chunk);
          } catch (error) {
            if (callbackFailed) return;
            callbackFailed = true;
            callbackError = error;
            void terminate();
          }
        });
        child.stderr?.on("data", (chunk: string) => { stderr = boundProcessDiagnostic(stderr, chunk); });
        child.once("error", (error) => { processError ??= error; });
        child.once("close", (code) => {
          void (async () => {
            try {
              await termination;
            } catch (error) {
              const primary = callbackError ?? processError;
              if (primary) reject(appendCause(primary, error));
              else reject(error);
              return;
            }
            if (callbackError) reject(callbackError);
            else if (processError) reject(processError);
            else resolve({ code: code ?? -1, stdout, stderr });
          })();
        });
      });
      return {
        completion,
        kill: terminate,
      };
    },
  };
}

function platformKey(platform: NodeJS.Platform): "win32" | "darwin" | "linux" {
  if (platform === "win32" || platform === "darwin") return platform;
  return "linux";
}

export function encoderCandidates(platform: NodeJS.Platform, listed: ReadonlySet<string>): CompatibilityEncoder[] {
  return PLATFORM_ENCODERS[platformKey(platform)].filter((encoder) => listed.has(encoder));
}

function parseEncoderListing(output: string): Set<string> {
  const encoders = new Set<string>();
  for (const match of output.matchAll(/\b(?:h264_nvenc|h264_qsv|h264_amf|h264_videotoolbox|libx264)\b/g)) {
    encoders.add(match[0]);
  }
  return encoders;
}

export function parseFfmpegProgress(output: string, durationSec: number): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const values = [...output.matchAll(/(?:^|\r?\n)out_time_(?:ms|us)=(\d+(?:\.\d+)?)(?=\r?\n|$)/g)];
  const raw = Number(values.at(-1)?.[1]);
  if (!Number.isFinite(raw)) return null;
  return Math.min(1, Math.max(0, raw / 1_000_000 / durationSec));
}

export function buildCompatibilityArguments(input: {
  inputPath: string;
  outputPath: string;
  encoder: CompatibilityEncoder;
  inspection: MediaInspection;
}): string[] {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-noautorotate",
    "-i", input.inputPath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", input.encoder,
    ...ENCODER_ARGUMENTS[input.encoder],
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
  ];
  args.push("-progress", "pipe:1", "-nostats", input.outputPath);
  return args;
}

function cancelled(): FfmpegProcessError {
  return new FfmpegProcessError("COMPATIBILITY_CANCELLED", "Video conversion was cancelled.");
}

export function createFfmpegProcessRunner(options: {
  adapter?: ProcessAdapter;
  ffmpegPath?: string;
  platform?: NodeJS.Platform;
} = {}): CompatibilityEncoderRunner {
  const adapter = options.adapter ?? createNodeProcessAdapter({ platform: options.platform });
  const executable = options.ffmpegPath ?? "ffmpeg";
  const platform = options.platform ?? process.platform;
  let discovered: Set<string> | undefined;
  let discovery: {
    process: SpawnedProcess;
    completion: Promise<Set<string>>;
    waiters: number;
    settled: boolean;
  } | undefined;

  const discover = (signal: AbortSignal): Promise<Set<string>> => {
    if (signal.aborted) return Promise.reject(cancelled());
    if (discovered) return Promise.resolve(discovered);
    if (!discovery) {
      let process: SpawnedProcess;
      try {
        process = adapter.run(executable, ["-hide_banner", "-encoders"]);
      } catch {
        return Promise.reject(new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable."));
      }
      const attempt = {
        process,
        completion: Promise.resolve(new Set<string>()),
        waiters: 0,
        settled: false,
      };
      attempt.completion = process.completion
        .then((result) => {
          if (result.code !== 0) {
            throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
          }
          const encoders = parseEncoderListing(`${result.stdout}\n${result.stderr}`);
          if (discovery === attempt) discovered = encoders;
          return encoders;
        }, () => {
          throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
        })
        .finally(() => {
          attempt.settled = true;
          if (discovery === attempt) discovery = undefined;
        });
      discovery = attempt;
    }

    const attempt = discovery;
    attempt.waiters += 1;
    return new Promise<Set<string>>((resolve, reject) => {
      let waiting = true;
      const finish = () => {
        if (!waiting) return false;
        waiting = false;
        signal.removeEventListener("abort", handleAbort);
        attempt.waiters -= 1;
        return true;
      };
      const handleAbort = () => {
        if (!finish()) return;
        if (!attempt.settled && attempt.waiters === 0 && discovery === attempt) {
          discovery = undefined;
          attempt.process.kill();
        }
        reject(cancelled());
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) {
        handleAbort();
        return;
      }
      void attempt.completion.then(
        (encoders) => {
          if (finish()) resolve(encoders);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  };

  return {
    async encode(request) {
      if (request.signal.aborted) throw cancelled();
      const candidates = encoderCandidates(platform, await discover(request.signal));
      if (request.signal.aborted) throw cancelled();
      if (candidates.length === 0) {
        throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "No H.264 encoder is available.");
      }

      for (const encoder of candidates) {
        if (request.signal.aborted) throw cancelled();
        let progressBuffer = "";
        let spawned: SpawnedProcess;
        try {
          spawned = adapter.run(
            executable,
            buildCompatibilityArguments({ ...request, encoder }),
            {
              onStdout(chunk) {
                progressBuffer = `${progressBuffer}${chunk}`.slice(-2_048);
                const progress = parseFfmpegProgress(progressBuffer, request.inspection.durationSec);
                if (progress !== null) request.onProgress(progress);
              },
            },
          );
        } catch {
          throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
        }
        const handleAbort = () => spawned.kill();
        request.signal.addEventListener("abort", handleAbort, { once: true });
        try {
          const result = await spawned.completion;
          if (request.signal.aborted) throw cancelled();
          if (result.code === 0) return { encoder };
        } catch (error) {
          if (request.signal.aborted) throw cancelled();
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            throw new FfmpegProcessError("FFMPEG_UNAVAILABLE", "Video conversion is unavailable.");
          }
        } finally {
          request.signal.removeEventListener("abort", handleAbort);
        }
      }
      throw new FfmpegProcessError("COMPATIBILITY_ENCODE_FAILED", "Video conversion failed.");
    },
  };
}

export const ffmpegProcessRunner = createFfmpegProcessRunner();
