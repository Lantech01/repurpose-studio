import { shouldCorrectDrift } from "./transport-clock";

export function synchronizeMediaTime(
  media: Pick<HTMLMediaElement, "currentTime">,
  targetSourceSec: number,
  toleranceSec: number
): { corrected: boolean; driftSec: number } {
  const driftSec = Math.abs(media.currentTime - targetSourceSec);
  const corrected = shouldCorrectDrift(media.currentTime, targetSourceSec, toleranceSec);
  if (corrected) media.currentTime = targetSourceSec;
  return { corrected, driftSec };
}
