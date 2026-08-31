// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";

import { collectBrowserErrors } from "@/tests/e2e/helpers/project";

function fakePage(): {
  page: Page;
  emit(event: string, value: unknown): void;
} {
  const listeners = new Map<string, Array<(value: never) => void>>();
  return {
    page: {
      on(event: string, listener: (value: never) => void) {
        const registered = listeners.get(event) ?? [];
        registered.push(listener);
        listeners.set(event, registered);
        return this;
      },
      url: () => "http://127.0.0.1:3001/repurpose-studio",
    } as unknown as Page,
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) listener(value as never);
    },
  };
}

function thumbnail404() {
  return {
    status: () => 404,
    url: () => "http://127.0.0.1:3001/api/repurpose/thumb?id=missing",
    request: () => ({ method: () => "GET" }),
  };
}

describe("browser error collection", () => {
  it("fails on a thumbnail 404 by default", () => {
    const fixture = fakePage();
    const collector = collectBrowserErrors(fixture.page);
    fixture.emit("response", thumbnail404());
    expect(() => collector.assertEmpty()).toThrow(/unexpected browser console, HTTP, or request failures/);
  });

  it("allows a thumbnail 404 only when the collector explicitly registers its path", () => {
    const fixture = fakePage();
    const collector = collectBrowserErrors(fixture.page, {
      expectedOptional404Paths: ["/api/repurpose/thumb"],
    });
    fixture.emit("response", thumbnail404());
    expect(() => collector.assertEmpty()).not.toThrow();
  });
});
