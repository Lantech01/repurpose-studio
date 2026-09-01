import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VideoImportProgress } from "@/app/repurpose-studio/_components/VideoImportProgress";
import type { VideoImportPhase } from "@/lib/repurpose/types";

afterEach(cleanup);

describe("VideoImportProgress", () => {
  it.each([
    ["copying", 0.42, "Copiando arquivo 42%"],
    ["inspecting", null, "Inspecionando mídia"],
    ["checking-browser", null, "Verificando compatibilidade no Chrome"],
    ["converting", 0.67, "Convertendo HEVC para H.264 67%"],
    ["building-proxy", null, "Criando proxy de prévia"],
    ["ready", 1, "Pronto"],
    ["cancelled", null, "Importação cancelada."],
  ] satisfies Array<[VideoImportPhase, number | null, string]>) (
    "renders accessible copy for %s",
    (phase, progress, copy) => {
      render(<VideoImportProgress state={{ phase, progress }} />);

      expect(screen.getByText(copy)).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    }
  );

  it("exposes progress semantics and cancellation only during conversion", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <VideoImportProgress
        state={{ phase: "converting", progress: 0.25 }}
        onCancel={onCancel}
      />
    );

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar conversão" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <VideoImportProgress
        state={{ phase: "copying", progress: 0.25 }}
        onCancel={onCancel}
      />
    );
    expect(screen.queryByRole("button", { name: "Cancelar conversão" })).toBeNull();
  });

  it.each(["copying", "converting"] as const)(
    "starts %s at an actionable zero percent",
    (phase) => {
      render(<VideoImportProgress state={{ phase, progress: null }} />);

      expect(screen.getByText(/0%$/)).toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "0"
      );
    }
  );

  it("shows a caller-supplied concise error without leaking diagnostic details", () => {
    render(
      <VideoImportProgress
        state={{
          phase: "error",
          progress: null,
          error: "Não foi possível converter o vídeo.",
        }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível converter o vídeo."
    );
    expect(screen.queryByText(/C:\\/)).toBeNull();
    expect(screen.queryByText(/ffmpeg/i)).toBeNull();
  });
});
