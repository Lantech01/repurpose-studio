export function focusSfxTimelineTarget(clipId: string | null): void {
  requestAnimationFrame(() => {
    const selection = clipId === null
      ? null
      : Array.from(document.querySelectorAll<HTMLElement>("[data-sfx-select-id]"))
          .find((element) => element.dataset.sfxSelectId === clipId) ?? null;
    const fallback = document.querySelector<HTMLElement>("[data-sfx-focus-fallback]");
    (selection ?? fallback)?.focus();
  });
}
