export const APPROVED_SFX_KEYS = [
  "mouse_click",
  "double_click",
  "keyboard",
  "whoosh",
  "air_hit",
  "ding",
  "notification",
  "camera_shutter",
  "digital_shutter",
  "riser",
  "impact",
  "digital_readout",
] as const;

export type ApprovedSfxKey = (typeof APPROVED_SFX_KEYS)[number];
