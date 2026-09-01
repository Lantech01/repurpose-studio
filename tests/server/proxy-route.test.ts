// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:fs");
  vi.doUnmock("@/lib/repurpose/proxy-cache");
  vi.resetModules();
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function sourceFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-proxy-route-"));
  tempRoots.push(root);
  const source = path.join(root, "source.mp4");
  await writeFile(source, "source");
  return source;
}

describe("preview proxy routes", () => {
  it("serializes status without exposing the server-private proxy path", async () => {
    const source = await sourceFile();
    vi.doMock("@/lib/repurpose/proxy-cache", () => ({
      getProxyState: vi.fn().mockResolvedValue({
        status: "ready",
        progress: 1,
        proxyPath: path.join(os.tmpdir(), "private-proxy-cache", "secret.mp4"),
      }),
      startProxyBuild: vi.fn(),
    }));
    const { GET } = await import("@/app/api/repurpose/proxy/route");

    const response = await GET(
      new Request(
        `http://localhost/api/repurpose/proxy?path=${encodeURIComponent(source)}`
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", progress: 1 });
  });

  it("returns 404 when a ready proxy was evicted before the video request", async () => {
    const source = await sourceFile();
    const evictedProxy = path.join(
      os.tmpdir(),
      "repurpose-proxy-route-missing",
      "evicted.mp4"
    );
    vi.doMock("@/lib/repurpose/proxy-cache", () => ({
      getProxyState: vi.fn().mockResolvedValue({
        status: "ready",
        progress: 1,
        proxyPath: evictedProxy,
      }),
      acquireProxyLease: vi.fn(() => vi.fn()),
    }));
    const { GET } = await import("@/app/api/repurpose/video/route");

    const response = await GET(
      new Request(
        `http://localhost/api/repurpose/video?path=${encodeURIComponent(source)}&quality=proxy`
      )
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Proxy not ready");
  });

  it("holds a proxy lease until the response reaches EOF", async () => {
    const source = await sourceFile();
    const proxyPath = path.join(path.dirname(source), "proxy.mp4");
    await writeFile(proxyPath, "proxy-body");
    const release = vi.fn();
    const acquireProxyLease = vi.fn(() => release);
    vi.doMock("@/lib/repurpose/proxy-cache", () => ({
      getProxyState: vi.fn().mockResolvedValue({
        status: "ready",
        progress: 1,
        proxyPath,
      }),
      acquireProxyLease,
    }));
    const { GET } = await import("@/app/api/repurpose/video/route");

    const response = await GET(
      new Request(
        `http://localhost/api/repurpose/video?path=${encodeURIComponent(source)}&quality=proxy`
      )
    );

    expect(response.status).toBe(200);
    expect(acquireProxyLease).toHaveBeenCalledWith(proxyPath);
    expect(release).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("proxy-body");
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("releases a proxy lease when the response body is cancelled", async () => {
    const source = await sourceFile();
    const proxyPath = path.join(path.dirname(source), "proxy.mp4");
    await writeFile(proxyPath, Buffer.alloc(64 * 1024, 1));
    const release = vi.fn();
    vi.doMock("@/lib/repurpose/proxy-cache", () => ({
      getProxyState: vi.fn().mockResolvedValue({
        status: "ready",
        progress: 1,
        proxyPath,
      }),
      acquireProxyLease: vi.fn(() => release),
    }));
    const { GET } = await import("@/app/api/repurpose/video/route");
    const response = await GET(
      new Request(
        `http://localhost/api/repurpose/video?path=${encodeURIComponent(source)}&quality=proxy`
      )
    );

    await response.body?.cancel();

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("holds a proxy lease through a range response", async () => {
    const source = await sourceFile();
    const proxyPath = path.join(path.dirname(source), "proxy.mp4");
    await writeFile(proxyPath, "proxy-body");
    const release = vi.fn();
    vi.doMock("@/lib/repurpose/proxy-cache", () => ({
      getProxyState: vi.fn().mockResolvedValue({
        status: "ready",
        progress: 1,
        proxyPath,
      }),
      acquireProxyLease: vi.fn(() => release),
    }));
    const { GET } = await import("@/app/api/repurpose/video/route");
    const response = await GET(
      new Request(
        `http://localhost/api/repurpose/video?path=${encodeURIComponent(source)}&quality=proxy`,
        { headers: { range: "bytes=0-4" } }
      )
    );

    expect(response.status).toBe(206);
    expect(release).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("proxy");
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("releases a proxy lease when the file stream errors", async () => {
    const source = await sourceFile();
    const proxyPath = path.join(path.dirname(source), "proxy.mp4");
    await writeFile(proxyPath, "proxy-body");
    const release = vi.fn();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        createReadStream: () =>
          new Readable({
            read() {
              this.destroy(new Error("read failed"));
            },
          }),
      };
    });
    vi.doMock("@/lib/repurpose/proxy-cache", () => ({
      getProxyState: vi.fn().mockResolvedValue({
        status: "ready",
        progress: 1,
        proxyPath,
      }),
      acquireProxyLease: vi.fn(() => release),
    }));
    const { GET } = await import("@/app/api/repurpose/video/route");
    const response = await GET(
      new Request(
        `http://localhost/api/repurpose/video?path=${encodeURIComponent(source)}&quality=proxy`
      )
    );

    await expect(response.text()).rejects.toThrow("read failed");
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("releases a proxy lease before returning a bodyless HEAD response", async () => {
    const source = await sourceFile();
    const proxyPath = path.join(path.dirname(source), "proxy.mp4");
    await writeFile(proxyPath, "proxy-body");
    const release = vi.fn();
    vi.doMock("@/lib/repurpose/proxy-cache", () => ({
      getProxyState: vi.fn().mockResolvedValue({
        status: "ready",
        progress: 1,
        proxyPath,
      }),
      acquireProxyLease: vi.fn(() => release),
    }));
    const videoRoute = await import("@/app/api/repurpose/video/route");

    expect(typeof videoRoute.HEAD).toBe("function");
    const response = await videoRoute.HEAD(
      new Request(
        `http://localhost/api/repurpose/video?path=${encodeURIComponent(source)}&quality=proxy`,
        { method: "HEAD" }
      )
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
