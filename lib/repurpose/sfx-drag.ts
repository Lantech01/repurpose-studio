import type { ApprovedSfxKey } from "./sfx-effects";

export const SFX_DRAG_MIME = "application/x-repurpose-sfx";
export type SfxDragPayload = { builtInKey: ApprovedSfxKey } | { assetId: string };
