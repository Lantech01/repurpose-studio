import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  persistenceState,
  blockBrowserZoomMock,
  overlayPasteMock,
  pushMock,
  retryLoadMock,
  resolveSaveConflictMock,
  subscribeOverlayImportMock,
  cancelOverlayImportMock,
  clearOverlayImportMock,
  registerOverlayImportOwnerMock,
  createOverlayImportOwnerMock,
  releaseOverlayImportOwnerMock,
  registeredOwners,
  overlayListeners,
  overlayImportListener,
} = vi.hoisted(() => ({
  persistenceState: {
    footageNeedsReimport: false,
    projectName: "Projeto",
    ready: true,
    loadError: null as string | null,
    saveConflict: null as {
      projectId: string;
      reason: string | null;
      serverRevision: number | null;
      serverWriterId: string | null;
    } | null,
    saveError: null as string | null,
  },
  blockBrowserZoomMock: vi.fn(),
  overlayPasteMock: vi.fn(),
  pushMock: vi.fn(),
  retryLoadMock: vi.fn(),
  resolveSaveConflictMock: vi.fn().mockResolvedValue(true),
  subscribeOverlayImportMock: vi.fn(),
  cancelOverlayImportMock: vi.fn(),
  clearOverlayImportMock: vi.fn(),
  registerOverlayImportOwnerMock: vi.fn(),
  createOverlayImportOwnerMock: vi.fn(),
  releaseOverlayImportOwnerMock: vi.fn(),
  registeredOwners: [] as Array<{ id: number }>,
  overlayListeners: new Map<
    { id: number },
    (state: { phase: string; progress: number | null; error?: string } | null) => void
  >(),
  overlayImportListener: {
    current: null as null | ((state: {
      phase: string;
      progress: number | null;
      error?: string;
    } | null) => void),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/app/repurpose-studio/_components/useProjectPersistence", () => ({
  useProjectPersistence: () => ({
    ...persistenceState,
    retryLoad: retryLoadMock,
    resolveSaveConflict: resolveSaveConflictMock,
  }),
}));

vi.mock("@/app/repurpose-studio/_components/useBlockBrowserZoom", () => ({
  useBlockBrowserZoom: blockBrowserZoomMock,
}));

vi.mock("@/app/repurpose-studio/_components/useOverlayPaste", () => ({
  useOverlayPaste: overlayPasteMock,
}));

vi.mock("@/lib/repurpose/export-short", () => ({
  exportShort: vi.fn(),
}));

vi.mock("@/lib/repurpose/overlay-ingest", () => ({
  subscribeOverlayImport: subscribeOverlayImportMock.mockImplementation(
    (
      listener: typeof overlayImportListener.current,
      owner?: { id: number }
    ) => {
      overlayImportListener.current = listener;
      if (owner && listener) overlayListeners.set(owner, listener);
      listener?.(null);
      return vi.fn();
    }
  ),
  cancelOverlayImport: cancelOverlayImportMock,
  clearOverlayImport: clearOverlayImportMock,
  createOverlayImportOwner: createOverlayImportOwnerMock.mockImplementation(
    () => {
      const owner = { id: registeredOwners.length + 1 };
      registeredOwners.push(owner);
      return owner;
    }
  ),
  registerOverlayImportOwner: registerOverlayImportOwnerMock.mockImplementation(
    (owner: { id: number }) => owner
  ),
  releaseOverlayImportOwner: releaseOverlayImportOwnerMock,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  SelectValue: () => null,
}));

vi.mock("@/app/repurpose-studio/_components/PreviewCanvas", () => ({
  PreviewCanvas: () => <button data-testid="playback-surface">Reproduzir</button>,
}));

vi.mock("@/app/repurpose-studio/_components/Timeline", () => ({
  Timeline: () => <button data-testid="editing-surface">Editar timeline</button>,
}));

vi.mock("@/app/repurpose-studio/_components/TranscriptPanel", () => ({
  TranscriptPanel: () => <div />,
}));
vi.mock("@/app/repurpose-studio/_components/FilesPanel", () => ({
  FilesPanel: () => <div />,
}));
vi.mock("@/app/repurpose-studio/_components/SourcesPanel", () => ({
  SourcesPanel: () => <div />,
}));
vi.mock("@/app/repurpose-studio/_components/ColorAdjustPanel", () => ({
  ColorAdjustPanel: () => <div />,
}));
vi.mock("@/app/repurpose-studio/_components/CaptionPanel", () => ({
  CaptionPanel: () => <div />,
}));
vi.mock("@/app/repurpose-studio/_components/MusicPanel", () => ({
  MusicPanel: () => <div />,
}));
vi.mock("@/app/repurpose-studio/_components/SfxPanel", () => ({
  SfxPanel: () => <div />,
}));

import { RepurposeEditor } from "@/app/repurpose-studio/_components/RepurposeEditor";
import { useRepurposeStore } from "@/lib/repurpose/store";

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  Object.assign(persistenceState, {
    footageNeedsReimport: false,
    projectName: "Projeto",
    ready: true,
    loadError: null,
    saveConflict: null,
    saveError: null,
  });
  pushMock.mockReset();
  blockBrowserZoomMock.mockReset();
  overlayPasteMock.mockReset();
  retryLoadMock.mockReset();
  resolveSaveConflictMock.mockReset().mockResolvedValue(true);
  subscribeOverlayImportMock.mockClear();
  cancelOverlayImportMock.mockReset();
  clearOverlayImportMock.mockReset();
  registerOverlayImportOwnerMock.mockClear();
  createOverlayImportOwnerMock.mockClear();
  releaseOverlayImportOwnerMock.mockReset();
  registeredOwners.length = 0;
  overlayListeners.clear();
  overlayImportListener.current = null;
});

afterEach(cleanup);

describe("RepurposeEditor persistence states", () => {
  test("keeps overlay paste mounted but disabled until project load succeeds", () => {
    Object.assign(persistenceState, { ready: false, loadError: null });
    const rendered = render(<RepurposeEditor projectId="paste-gating-project" />);

    expect(overlayPasteMock).toHaveBeenLastCalledWith(
      false,
      registeredOwners[0]
    );

    Object.assign(persistenceState, {
      ready: false,
      loadError: "Não foi possível carregar o projeto. Tente novamente.",
    });
    rendered.rerender(<RepurposeEditor projectId="paste-gating-project" />);
    expect(overlayPasteMock).toHaveBeenLastCalledWith(
      false,
      registeredOwners[0]
    );

    Object.assign(persistenceState, { ready: true, loadError: null });
    rendered.rerender(<RepurposeEditor projectId="paste-gating-project" />);
    expect(overlayPasteMock).toHaveBeenLastCalledWith(
      true,
      registeredOwners[0]
    );
  });

  test("surfaces shared overlay conversion progress and cancellation", () => {
    render(<RepurposeEditor projectId="overlay-import-project" />);

    act(() => {
      overlayImportListener.current?.({ phase: "converting", progress: 0.55 });
    });

    expect(screen.getByText("Convertendo HEVC para H.264 55%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar conversão" }));
    expect(cancelOverlayImportMock).toHaveBeenCalledWith(registeredOwners[0]);
  });

  test("a stale editor unmount cannot clear a newer editor owner", () => {
    const first = render(<RepurposeEditor projectId="overlap-old" />);
    const oldOwner = registeredOwners[0];
    const second = render(<RepurposeEditor projectId="overlap-new" />);
    const newOwner = registeredOwners[1];

    act(() => {
      overlayListeners.get(newOwner)?.({ phase: "converting", progress: 0.6 });
    });
    expect(screen.getByText("Convertendo HEVC para H.264 60%")).toBeInTheDocument();

    first.unmount();
    expect(releaseOverlayImportOwnerMock).toHaveBeenCalledWith(oldOwner);
    expect(releaseOverlayImportOwnerMock).not.toHaveBeenCalledWith(newOwner);

    act(() => {
      overlayListeners.get(newOwner)?.({ phase: "ready", progress: 1 });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Pronto");
    second.unmount();
  });

  test("shows concise overlay import errors and cancels when editing becomes blocked", () => {
    const rendered = render(<RepurposeEditor projectId="overlay-error-project" />);
    act(() => {
      overlayImportListener.current?.({
        phase: "error",
        progress: null,
        error: "Não foi possível converter o vídeo.",
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível converter o vídeo."
    );

    persistenceState.saveConflict = {
      projectId: "overlay-error-project",
      reason: "BASE_MISMATCH",
      serverRevision: 3,
      serverWriterId: "other-window",
    };
    rendered.rerender(<RepurposeEditor projectId="overlay-error-project" />);
    expect(cancelOverlayImportMock).toHaveBeenCalled();
    expect(clearOverlayImportMock).toHaveBeenCalled();
  });

  test("does not mount editing or playback while the project is hydrating", () => {
    Object.assign(persistenceState, { ready: false, loadError: null });

    render(<RepurposeEditor projectId="hydrating-project" />);

    expect(screen.getByRole("status")).toHaveTextContent("Carregando projeto");
    expect(screen.queryByTestId("editing-surface")).not.toBeInTheDocument();
    expect(screen.queryByTestId("playback-surface")).not.toBeInTheDocument();
  });

  test("shows an accessible Portuguese load alert with retry and keeps the editor blocked", () => {
    Object.assign(persistenceState, {
      ready: false,
      loadError: "Não foi possível carregar o projeto. Tente novamente.",
    });

    render(<RepurposeEditor projectId="failed-project" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível carregar o projeto"
    );
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(retryLoadMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("editing-surface")).not.toBeInTheDocument();
    expect(screen.queryByTestId("playback-surface")).not.toBeInTheDocument();
  });

  test("offers both recoverable save-conflict actions", () => {
    persistenceState.saveConflict = {
      projectId: "conflicted-project",
      reason: "BASE_MISMATCH",
      serverRevision: 8,
      serverWriterId: "writer-competing",
    };

    render(<RepurposeEditor projectId="conflicted-project" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Conflito ao salvar");
    fireEvent.click(screen.getByRole("button", { name: "Recarregar projeto" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar uma cópia" }));
    expect(resolveSaveConflictMock).toHaveBeenNthCalledWith(1, "reload");
    expect(resolveSaveConflictMock).toHaveBeenNthCalledWith(2, "save-copy");
  });

  test("blocks editing surfaces and global input hooks while a save conflict is unresolved", () => {
    const rendered = render(
      <RepurposeEditor projectId="blocked-conflict-project" />
    );
    expect(screen.getByTestId("editing-surface")).toBeInTheDocument();
    expect(screen.getByTestId("playback-surface")).toBeInTheDocument();
    expect(overlayPasteMock).toHaveBeenLastCalledWith(
      true,
      registeredOwners[0]
    );
    expect(blockBrowserZoomMock).toHaveBeenLastCalledWith(true);

    persistenceState.saveConflict = {
      projectId: "blocked-conflict-project",
      reason: "BASE_MISMATCH",
      serverRevision: 8,
      serverWriterId: "writer-competing",
    };
    rendered.rerender(<RepurposeEditor projectId="blocked-conflict-project" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Conflito ao salvar");
    expect(
      screen.getByRole("button", { name: "Recarregar projeto" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Salvar uma cópia" })
    ).toBeInTheDocument();
    expect(overlayPasteMock).toHaveBeenLastCalledWith(
      false,
      registeredOwners[0]
    );
    expect(blockBrowserZoomMock).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("editing-surface")).not.toBeInTheDocument();
    expect(screen.queryByTestId("playback-surface")).not.toBeInTheDocument();
  });

  test("shows actionable project-corruption recovery guidance", () => {
    persistenceState.saveConflict = {
      projectId: "corrupt-project",
      reason: "PROJECT_FILE_CORRUPT",
      serverRevision: 0,
      serverWriterId: null,
    };

    render(<RepurposeEditor projectId="corrupt-project" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "O arquivo do projeto está corrompido"
    );
    expect(
      screen.getByRole("button", { name: "Recarregar projeto" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Salvar uma cópia" })
    ).toBeInTheDocument();
  });

  test("shows a visible warning when edits have no durable save channel", () => {
    persistenceState.saveError =
      "Não foi possível proteger as alterações pendentes neste navegador.";

    render(<RepurposeEditor projectId="unsaved-project" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível proteger as alterações pendentes"
    );
  });

  test("preserves the restored-footage reconnect notice", () => {
    persistenceState.footageNeedsReimport = true;

    render(<RepurposeEditor projectId="reconnect-project" />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Re-select your Screen and Face video files"
    );
  });
});
