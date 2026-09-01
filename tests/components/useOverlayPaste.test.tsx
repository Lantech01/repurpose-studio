import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { ingestOverlayFileMock } = vi.hoisted(() => ({
  ingestOverlayFileMock: vi.fn(),
}));

vi.mock("@/lib/repurpose/overlay-ingest", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/repurpose/overlay-ingest")
  >();
  return {
    ...original,
    ingestOverlayFile: ingestOverlayFileMock,
  };
});

import { useOverlayPaste } from "@/app/repurpose-studio/_components/useOverlayPaste";
import {
  clearOverlayImport,
  subscribeOverlayImport,
  surfaceOverlayImportError,
} from "@/lib/repurpose/overlay-ingest";
import { useRepurposeStore } from "@/lib/repurpose/store";

function Harness() {
  useOverlayPaste(true);
  return null;
}

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  ingestOverlayFileMock.mockReset().mockResolvedValue({
    id: "ovl-1",
    needsReconnect: false,
  });
});

afterEach(() => {
  cleanup();
  clearOverlayImport();
});

it("pastes an empty-MIME video when its extension is supported", async () => {
  render(<Harness />);
  const file = new File(["video"], "clipboard.MOV", { type: "" });
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [
        {
          kind: "file",
          type: "",
          getAsFile: () => file,
        },
      ],
    },
  });

  act(() => {
    window.dispatchEvent(event);
  });

  await waitFor(() => {
    expect(ingestOverlayFileMock).toHaveBeenCalledWith(
      file,
      0,
      undefined,
      undefined
    );
  });
  expect(event.defaultPrevented).toBe(true);
});

it("keeps a centrally published paste error visible while mounted", async () => {
  const failure = new Error("ffmpeg C:\\secret\\clipboard.mov");
  ingestOverlayFileMock.mockImplementation(() => {
    surfaceOverlayImportError(failure);
    return Promise.reject(failure);
  });
  const states: Array<{ phase: string; error?: string } | null> = [];
  const unsubscribe = subscribeOverlayImport((state) => states.push(state));
  render(<Harness />);
  const file = new File(["video"], "clipboard.mov", { type: "video/quicktime" });
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [
        {
          kind: "file",
          type: "video/quicktime",
          getAsFile: () => file,
        },
      ],
    },
  });

  act(() => {
    window.dispatchEvent(event);
  });

  await waitFor(() => {
    expect(states.at(-1)).toEqual({
      phase: "error",
      progress: null,
      error: "Não foi possível importar uma ou mais mídias.",
    });
  });
  unsubscribe();
});

it("does not republish a paste rejection after unmount and global clear", async () => {
  const failure = new Error("ffmpeg C:\\secret\\clipboard.mov");
  let rejectPaste!: (error: Error) => void;
  ingestOverlayFileMock.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectPaste = reject;
      })
  );
  const rendered = render(<Harness />);
  const file = new File(["video"], "clipboard.mov", { type: "video/quicktime" });
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [
        {
          kind: "file",
          type: "video/quicktime",
          getAsFile: () => file,
        },
      ],
    },
  });
  act(() => {
    window.dispatchEvent(event);
  });
  await waitFor(() => expect(rejectPaste).toBeDefined());

  rendered.unmount();
  clearOverlayImport();
  await act(async () => {
    rejectPaste(failure);
    await Promise.resolve();
  });
  const nextEditorListener = vi.fn();
  const unsubscribe = subscribeOverlayImport(nextEditorListener);

  expect(nextEditorListener).toHaveBeenLastCalledWith(null);
  unsubscribe();
});
