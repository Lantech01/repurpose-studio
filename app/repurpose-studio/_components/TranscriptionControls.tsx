"use client";

import {
  CheckCircle,
  Cpu,
  MicrophoneStage,
  Warning,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TranscriptionLanguage } from "@/lib/repurpose/transcription-contract";

import type { TranscriptApplicationNotice } from "./useTranscriptApplication";
import type { UseTranscriptionResult } from "./useTranscription";

const PHASE_LABELS = {
  preparing: "Preparando transcrição",
  "extracting-audio": "Extraindo áudio do Face",
  "downloading-model": "Baixando modelo local",
  transcribing: "Transcrevendo áudio",
  finalizing: "Finalizando transcrição",
} as const;

export function TranscriptionControls({
  transcription,
  legacyFace,
  notice,
  hasPendingApplication,
  waitingForScreen,
}: {
  transcription: UseTranscriptionResult;
  legacyFace: boolean;
  notice: TranscriptApplicationNotice | null;
  hasPendingApplication: boolean;
  waitingForScreen: boolean;
}) {
  const { status } = transcription;
  const active = status?.state === "queued" || status?.state === "running";
  const retryable =
    Boolean(transcription.error) ||
    status?.state === "failed" ||
    status?.state === "cancelled";
  const progress = active ? status.progress : null;
  const device = status?.device;

  return (
    <section className="rounded-lg border border-border/80 bg-secondary/35 p-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <MicrophoneStage size={13} weight="bold" />
        Transcrição local
      </div>

      <div className="flex gap-2">
        <Select
          value={transcription.language}
          onValueChange={(value) =>
            transcription.setLanguage(value as TranscriptionLanguage)
          }
          disabled={!transcription.available || active}
        >
          <SelectTrigger
            size="sm"
            aria-label="Idioma da transcrição"
            className="min-w-0 flex-1 bg-background/55 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pt">Português</SelectItem>
            <SelectItem value="auto">Detectar automaticamente</SelectItem>
          </SelectContent>
        </Select>

        {!active && !retryable && (
          <Button
            size="sm"
            className="bg-[#FF6B35] text-white hover:bg-[#E95B29]"
            disabled={!transcription.available}
            onClick={() => void transcription.start()}
          >
            {status?.state === "completed"
              ? "Transcrever novamente"
              : "Transcrever áudio"}
          </Button>
        )}
        {retryable && (
          <Button
            size="sm"
            className="bg-[#FF6B35] text-white hover:bg-[#E95B29]"
            disabled={!transcription.available}
            onClick={() => void transcription.retry()}
          >
            Tentar novamente
          </Button>
        )}
      </div>

      {!transcription.available && legacyFace && (
        <p className="mt-2 text-[11px] leading-4 text-[#FF8F6B]">
          Reimporte o vídeo Face para transcrever
        </p>
      )}

      {transcription.available && !status && !transcription.error && (
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          As dependências locais do Python e o modelo fixado podem ser baixados neste
          computador na primeira execução. O áudio e o vídeo nunca saem deste computador;
          depois, as próximas execuções funcionam offline.
        </p>
      )}

      {active && (
        <div className="mt-2.5 space-y-2" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-medium text-foreground">
              {status.state === "queued" ? "Na fila para transcrição" : PHASE_LABELS[status.phase]}
            </span>
            {device && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Cpu size={12} />
                {device === "cuda" ? "GPU NVIDIA" : "CPU"}
              </span>
            )}
          </div>
          {progress === null ? (
            <div
              role="progressbar"
              aria-label="Progresso da transcrição"
              className="h-1 overflow-hidden rounded-full bg-border"
            >
              <div className="h-full w-1/3 animate-pulse rounded-full bg-[#FF6B35]" />
            </div>
          ) : (
            <progress
              aria-label="Progresso da transcrição"
              className="h-1 w-full accent-[#FF6B35]"
              max={1}
              value={progress}
            />
          )}
          {status.phase === "downloading-model" && (
            <p className="text-[10px] leading-4 text-muted-foreground">
              Preparação local: o áudio permanece neste computador.
            </p>
          )}
          {status.warning && (
            <p className="flex items-start gap-1.5 text-[11px] leading-4 text-amber-400">
              <Warning size={13} weight="fill" className="mt-px shrink-0" />
              {status.warning.message}
            </p>
          )}
          <Button
            size="xs"
            variant="outline"
            className="w-full"
            onClick={() => void transcription.cancel()}
          >
            Cancelar
          </Button>
        </div>
      )}

      {transcription.error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-[#FF8F6B]">
          <Warning size={13} weight="fill" className="mt-px shrink-0" />
          {transcription.error}
        </p>
      )}

      {status?.state === "failed" && !transcription.error && (
        <p className="mt-2 text-[11px] leading-4 text-[#FF8F6B]">
          {status.error.message}
        </p>
      )}
      {status?.state === "cancelled" && (
        <p className="mt-2 text-[11px] text-muted-foreground">Transcrição cancelada.</p>
      )}

      {status?.state === "completed" && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground">
          <CheckCircle size={13} weight="fill" className="mt-px shrink-0 text-emerald-400" />
          <div>
            <p>
              {notice === "no-speech"
                ? "Nenhuma fala detectada"
                : notice === "no-shared-speech"
                  ? "Nenhuma fala coincide com a duração compartilhada dos vídeos"
                  : waitingForScreen
                    ? "Aguardando vídeo Screen para aplicar a transcrição."
                    : hasPendingApplication
                      ? "Transcrição concluída; aguardando sua decisão."
                      : `${status.result.words.length} palavras transcritas. Legendas ativadas.`}
            </p>
            {transcription.language === "auto" && status.result.language && (
              <p>
                Idioma detectado: {status.result.language}
                {status.result.languageProbability === null
                  ? ""
                  : ` (${Math.round(status.result.languageProbability * 100)}%)`}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
