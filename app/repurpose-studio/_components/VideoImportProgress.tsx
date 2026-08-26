"use client";

import { CircleNotch, Warning } from "@phosphor-icons/react";
import type { VideoImportPhase } from "@/lib/repurpose/types";

export interface VideoImportProgressState {
  phase: VideoImportPhase;
  progress: number | null;
  error?: string;
}

const PHASE_LABELS: Record<VideoImportPhase, string> = {
  copying: "Copiando arquivo",
  inspecting: "Inspecionando mídia",
  "checking-browser": "Verificando compatibilidade no Chrome",
  converting: "Convertendo HEVC para H.264",
  "building-proxy": "Criando proxy de prévia",
  ready: "Pronto",
  cancelled: "Importação cancelada.",
  error: "Não foi possível importar o vídeo.",
};

export function VideoImportProgress({
  state,
  onCancel,
  className = "",
}: {
  state: VideoImportProgressState;
  onCancel?: () => void;
  className?: string;
}) {
  const showsPercentage =
    state.phase === "copying" || state.phase === "converting";
  const percentage =
    state.progress === null
      ? showsPercentage
        ? 0
        : null
      : Math.round(Math.min(1, Math.max(0, state.progress)) * 100);
  const label = state.phase === "error" && state.error
    ? state.error
    : PHASE_LABELS[state.phase];
  const isError = state.phase === "error";

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px] ${
        isError
          ? "border-red-500/40 bg-red-500/10 text-red-300"
          : "border-[#FF6B35]/30 bg-[#FF6B35]/10 text-[#FF8F6B]"
      } ${className}`}
    >
      {isError ? (
        <Warning size={13} weight="fill" className="shrink-0" />
      ) : state.phase !== "ready" && state.phase !== "cancelled" ? (
        <CircleNotch size={13} weight="bold" className="shrink-0 animate-spin" />
      ) : null}
      <span className="min-w-0 flex-1">
        {label}{showsPercentage ? ` ${percentage}%` : ""}
      </span>
      {percentage !== null && (
        <span
          role="progressbar"
          aria-label={PHASE_LABELS[state.phase]}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          className="sr-only"
        />
      )}
      {state.phase === "converting" && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded border border-current/40 px-1.5 py-0.5 font-semibold hover:bg-white/10"
        >
          Cancelar conversão
        </button>
      )}
    </div>
  );
}
