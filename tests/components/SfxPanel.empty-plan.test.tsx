import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/repurpose/sfx-placement", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/repurpose/sfx-placement")>(),
  planSfxEvents: () => [],
}));

import { SfxPanel } from "@/app/repurpose-studio/_components/SfxPanel";
import {
  createSfxImportOwner,
  registerSfxImportOwner,
  releaseSfxImportOwner,
} from "@/lib/repurpose/sfx-ingest-client";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { Clip, SfxClip } from "@/lib/repurpose/types";

const scene: Clip = {
  id: "scene", kind: "take", label: "Scene", srcStart: 0, srcEnd: 5,
  timelineStart: 0, timelineEnd: 5, kept: true, isKeeperTake: true,
  occurrences: [{ start: 0, end: 5 }], keeperIndex: 0,
};
const manual: SfxClip = {
  id: "manual", name: "Manual", source: { kind: "built-in", key: "ding" },
  origin: "manual", timelineStart: 1, sourceStart: 0, sourceEnd: 1,
  gain: 1, fadeInSec: 0, fadeOutSec: 0, muted: false,
};
let owner: ReturnType<typeof createSfxImportOwner>;

beforeEach(() => {
  useRepurposeStore.setState(useRepurposeStore.getInitialState(), true);
  useRepurposeStore.setState({ clips: [scene], duration: 5, sfxClips: [manual], past: [], future: [] });
  owner = registerSfxImportOwner(createSfxImportOwner("empty-plan"));
});

afterEach(() => {
  releaseSfxImportOwner(owner);
  cleanup();
});

it("reports an empty automatic plan without replacing manual clips", async () => {
  render(<SfxPanel projectId="empty-plan" sfxImportOwner={owner} />);

  fireEvent.click(screen.getByRole("button", { name: "Generate automatic effects" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no automatic sound-effect beats/i));
  expect(useRepurposeStore.getState()).toMatchObject({
    sfxClips: [manual],
    sfxGenerating: false,
    past: [],
  });
});
