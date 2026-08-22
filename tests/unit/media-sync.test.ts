import { describe, expect, it } from "vitest";
import { synchronizeMediaTime } from "@/lib/repurpose/media-sync";
import {
  BASE_MEDIA_DRIFT_TOLERANCE_SEC,
  OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC,
} from "@/lib/repurpose/transport-clock";

describe("synchronizeMediaTime", () => {
  it("corrects base media at 151 ms drift but not at 149 ms", () => {
    const media = { currentTime: 10.149 };

    const tolerated = synchronizeMediaTime(media, 10, BASE_MEDIA_DRIFT_TOLERANCE_SEC);
    expect(tolerated.corrected).toBe(false);
    expect(tolerated.driftSec).toBeCloseTo(0.149, 6);
    media.currentTime = 10.151;
    const corrected = synchronizeMediaTime(media, 10, BASE_MEDIA_DRIFT_TOLERANCE_SEC);
    expect(corrected.corrected).toBe(true);
    expect(corrected.driftSec).toBeCloseTo(0.151, 6);
    expect(media.currentTime).toBe(10);
  });

  it("corrects overlay media at 251 ms drift but not at 249 ms", () => {
    const media = { currentTime: 3.249 };

    const tolerated = synchronizeMediaTime(media, 3, OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC);
    expect(tolerated.corrected).toBe(false);
    expect(tolerated.driftSec).toBeCloseTo(0.249, 6);
    media.currentTime = 3.251;
    const corrected = synchronizeMediaTime(media, 3, OVERLAY_MEDIA_DRIFT_TOLERANCE_SEC);
    expect(corrected.corrected).toBe(true);
    expect(corrected.driftSec).toBeCloseTo(0.251, 6);
    expect(media.currentTime).toBe(3);
  });
});
