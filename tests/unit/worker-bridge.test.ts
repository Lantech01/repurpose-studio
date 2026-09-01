import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  disposeWarmWorker,
  prespawnWorker,
} from "@/lib/export/workerBridge";

class WorkerStub {
  static instances: WorkerStub[] = [];

  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();

  constructor() {
    WorkerStub.instances.push(this);
  }
}

describe("export worker lifecycle", () => {
  beforeEach(() => {
    disposeWarmWorker();
    WorkerStub.instances = [];
    vi.stubGlobal("Worker", WorkerStub);
    vi.stubGlobal("ImageBitmap", class ImageBitmapStub {});
  });

  afterEach(() => {
    disposeWarmWorker();
    vi.unstubAllGlobals();
  });

  it("contains a pre-spawn startup error and discards the failed worker", () => {
    prespawnWorker();
    const worker = WorkerStub.instances[0];
    const error = new Event("error", { cancelable: true }) as ErrorEvent;

    expect(worker.onerror).toBeTypeOf("function");
    worker.onerror!(error);

    expect(error.defaultPrevented).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
