export interface TimelinePointerStart {
  clientX: number;
  pointerId: number;
  captureTarget: HTMLElement;
}

export interface TimelinePointerLifecycle {
  complete: () => void;
  cancel: () => void;
}

export interface TimelinePointerOwnership {
  canStartTimelineDrag: (pointerId: number) => boolean;
  beginWordRangeDrag: (
    pointer: TimelinePointerStart,
    lifecycle: TimelinePointerLifecycle
  ) => boolean;
  ownsWordRangeDrag: (pointerId: number) => boolean;
  completeWordRangeDrag: (pointerId: number) => boolean;
  cancelWordRangeDrag: (pointerId: number) => boolean;
}
