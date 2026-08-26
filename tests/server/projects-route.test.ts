// @vitest-environment node

import fs from "node:fs";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSnapshot } from "@/lib/repurpose/types";

vi.mock("server-only", () => ({}));

type ProjectsRoute = typeof import("@/app/api/repurpose/projects/route");
type ProjectRoute = typeof import("@/app/api/repurpose/projects/[id]/route");
type ProjectsStore = typeof import("@/lib/repurpose/projects");

const tempRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:os");
  vi.resetModules();
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function snapshot(splitRatio: number): ProjectSnapshot {
  return {
    clips: [],
    duration: 0,
    splitRatio,
    screenGrade: "none",
    faceGrade: "neutral",
    playhead: 0,
    inPoint: null,
    outPoint: null,
    loopPlayback: false,
    footageMeta: null,
  };
}

async function loadRoute(): Promise<{
  route: ProjectsRoute;
  projects: ProjectsStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repurpose-projects-route-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  await mkdir(path.join(home, "Downloads"), { recursive: true });
  vi.resetModules();
  vi.doMock("node:os", () => ({
    default: { homedir: () => home, tmpdir: () => os.tmpdir() },
    homedir: () => home,
    tmpdir: () => os.tmpdir(),
  }));
  const route = (await import(
    "@/app/api/repurpose/projects/route"
  )) as ProjectsRoute;
  const projects = (await import("@/lib/repurpose/projects")) as ProjectsStore;
  return { route, projects };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/repurpose/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/repurpose/projects revision ordering", () => {
  it("lets one writer win a shared base and keeps the losing writer stale", async () => {
    const { route, projects } = await loadRoute();
    const writerA = "writer-aaaaaaaa";
    const writerB = "writer-bbbbbbbb";

    const winner = await route.POST(
      postRequest({
        id: "writer-race",
        name: "Writer race",
        writerId: writerA,
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.6),
      }) as Parameters<typeof route.POST>[0]
    );
    const loser = await route.POST(
      postRequest({
        id: "writer-race",
        name: "Writer race",
        writerId: writerB,
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.3),
      }) as Parameters<typeof route.POST>[0]
    );
    const loserRetry = await route.POST(
      postRequest({
        id: "writer-race",
        name: "Writer race",
        writerId: writerB,
        baseRevision: 0,
        saveRevision: 99,
        snapshot: snapshot(0.2),
      }) as Parameters<typeof route.POST>[0]
    );

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(409);
    expect(loserRetry.status).toBe(409);
    await expect(loser.json()).resolves.toMatchObject({
      error: { code: "PROJECT_SAVE_CONFLICT" },
      project: { saveRevision: 1, saveWriterId: writerA },
    });
    expect(projects.readProject("writer-race")).toMatchObject({
      saveRevision: 1,
      saveWriterId: writerA,
      snapshot: { splitRatio: 0.6 },
    });
  });

  it("keeps a newer save from the current writer when an older request arrives later", async () => {
    const { route, projects } = await loadRoute();
    const writerId = "writer-aaaaaaaa";
    const save = (saveRevision: number, splitRatio: number) =>
      route.POST(
        postRequest({
          id: "same-writer-order",
          name: "Same writer order",
          writerId,
          baseRevision: 0,
          saveRevision,
          snapshot: snapshot(splitRatio),
        }) as Parameters<typeof route.POST>[0]
      );

    const first = await save(1, 0.4);
    const newer = await save(3, 0.8);
    const older = await save(2, 0.2);

    expect(first.status).toBe(200);
    expect(newer.status).toBe(200);
    expect(older.status).toBe(409);
    await expect(older.json()).resolves.toMatchObject({
      error: {
        code: "PROJECT_SAVE_CONFLICT",
        reason: "SUPERSEDED_SAME_WRITER",
      },
      project: { saveRevision: 3, saveWriterId: writerId },
    });
    expect(projects.readProject("same-writer-order")).toMatchObject({
      saveRevision: 3,
      saveWriterId: writerId,
      saveWriterBaseRevision: 0,
      snapshot: { splitRatio: 0.8 },
    });
  });

  it("accepts revision 7 before revision 6 when a new writer has the exact current base", async () => {
    const { route, projects } = await loadRoute();
    const save = (
      writerId: string,
      baseRevision: number,
      saveRevision: number,
      splitRatio: number
    ) =>
      route.POST(
        postRequest({
          id: "takeover-newest-first",
          name: "Takeover newest first",
          writerId,
          baseRevision,
          saveRevision,
          snapshot: snapshot(splitRatio),
        }) as Parameters<typeof route.POST>[0]
      );

    await save("writer-aaaaaaaa", 0, 1, 0.1);
    await save("writer-aaaaaaaa", 0, 5, 0.5);
    const newer = await save("writer-bbbbbbbb", 5, 7, 0.7);
    const older = await save("writer-bbbbbbbb", 5, 6, 0.6);

    expect(newer.status).toBe(200);
    expect(older.status).toBe(409);
    expect(projects.readProject("takeover-newest-first")).toMatchObject({
      saveRevision: 7,
      saveWriterId: "writer-bbbbbbbb",
      saveWriterBaseRevision: 5,
      snapshot: { splitRatio: 0.7 },
    });
  });

  it("finishes at revision 7 when a takeover's revision 6 arrives first", async () => {
    const { route, projects } = await loadRoute();
    const save = (
      writerId: string,
      baseRevision: number,
      saveRevision: number,
      splitRatio: number
    ) =>
      route.POST(
        postRequest({
          id: "takeover-oldest-first",
          name: "Takeover oldest first",
          writerId,
          baseRevision,
          saveRevision,
          snapshot: snapshot(splitRatio),
        }) as Parameters<typeof route.POST>[0]
      );

    await save("writer-aaaaaaaa", 0, 1, 0.1);
    await save("writer-aaaaaaaa", 0, 5, 0.5);
    const older = await save("writer-bbbbbbbb", 5, 6, 0.6);
    const newer = await save("writer-bbbbbbbb", 5, 7, 0.7);

    expect(older.status).toBe(200);
    expect(newer.status).toBe(200);
    expect(projects.readProject("takeover-oldest-first")).toMatchObject({
      saveRevision: 7,
      saveWriterId: "writer-bbbbbbbb",
      saveWriterBaseRevision: 5,
      snapshot: { splitRatio: 0.7 },
    });
  });

  it("rejects an arbitrary high revision from a different writer with a stale base", async () => {
    const { route, projects } = await loadRoute();
    const save = (
      writerId: string,
      baseRevision: number,
      saveRevision: number,
      splitRatio: number
    ) =>
      route.POST(
        postRequest({
          id: "stale-base-jump",
          name: "Stale base jump",
          writerId,
          baseRevision,
          saveRevision,
          snapshot: snapshot(splitRatio),
        }) as Parameters<typeof route.POST>[0]
      );

    await save("writer-aaaaaaaa", 0, 5, 0.5);
    const takeover = await save("writer-bbbbbbbb", 5, 7, 0.7);
    const staleJump = await save("writer-cccccccc", 5, 99, 0.9);

    expect(takeover.status).toBe(200);
    expect(staleJump.status).toBe(409);
    expect(projects.readProject("stale-base-jump")).toMatchObject({
      saveRevision: 7,
      saveWriterId: "writer-bbbbbbbb",
      snapshot: { splitRatio: 0.7 },
    });
  });

  it("rejects an older revision after a newer revision is persisted", async () => {
    const { route } = await loadRoute();
    const writerId = "writer-aaaaaaaa";
    await route.POST(
      postRequest({
        id: "revision-project",
        name: "Revision project",
        writerId,
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.5),
      }) as Parameters<typeof route.POST>[0]
    );
    const newer = await route.POST(
      postRequest({
        id: "revision-project",
        name: "Revision project",
        writerId,
        baseRevision: 1,
        saveRevision: 2,
        snapshot: snapshot(0.7),
      }) as Parameters<typeof route.POST>[0]
    );

    vi.resetModules();
    const reloadedRoute = (await import(
      "@/app/api/repurpose/projects/route"
    )) as ProjectsRoute;
    const reloadedProjects = (await import(
      "@/lib/repurpose/projects"
    )) as ProjectsStore;
    const older = await reloadedRoute.POST(
      postRequest({
        id: "revision-project",
        name: "Revision project",
        writerId,
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.4),
      }) as Parameters<typeof reloadedRoute.POST>[0]
    );

    expect(newer.status).toBe(200);
    expect(older.status).toBe(409);
    expect(reloadedProjects.readProject("revision-project")).toMatchObject({
      saveRevision: 2,
      saveWriterId: writerId,
      saveWriterBaseRevision: 0,
      snapshot: { splitRatio: 0.7 },
    });
  });

  it("allows revisionless saves only while a project remains unrevisioned", async () => {
    const { route, projects } = await loadRoute();

    const first = await route.POST(
      postRequest({
        id: "legacy-project",
        name: "Legacy project",
        snapshot: snapshot(0.4),
      }) as Parameters<typeof route.POST>[0]
    );
    const second = await route.POST(
      postRequest({
        id: "legacy-project",
        name: "Legacy project",
        snapshot: snapshot(0.6),
      }) as Parameters<typeof route.POST>[0]
    );
    const takeover = await route.POST(
      postRequest({
        id: "legacy-project",
        name: "Legacy project",
        writerId: "writer-aaaaaaaa",
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.8),
      }) as Parameters<typeof route.POST>[0]
    );
    const staleLegacySave = await route.POST(
      postRequest({
        id: "legacy-project",
        name: "Legacy project",
        snapshot: snapshot(0.2),
      }) as Parameters<typeof route.POST>[0]
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(takeover.status).toBe(200);
    expect(staleLegacySave.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      project: { saveRevision: 0, saveWriterId: null },
    });
    expect(projects.readProject("legacy-project")).toMatchObject({
      saveRevision: 1,
      saveWriterId: "writer-aaaaaaaa",
      snapshot: { splitRatio: 0.8 },
    });
  });

  it("serves a pre-change disk project and migrates it on the first controlled save", async () => {
    const { projects } = await loadRoute();
    const id = "pre-change-project";
    fs.mkdirSync(projects.PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(projects.PROJECTS_DIR, `${id}.json`),
      JSON.stringify(
        {
          id,
          name: "Pre-change project",
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
          durationSec: 0,
          snapshot: snapshot(0.4),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    vi.resetModules();
    const reloadedRoute = (await import(
      "@/app/api/repurpose/projects/route"
    )) as ProjectsRoute;
    const reloadedProjects = (await import(
      "@/lib/repurpose/projects"
    )) as ProjectsStore;
    expect(reloadedProjects.readProject(id)).toMatchObject({
      saveRevision: 0,
      saveWriterId: null,
      createRequestId: null,
      snapshot: { splitRatio: 0.4 },
    });
    const detailRoute = (await import(
      "@/app/api/repurpose/projects/[id]/route"
    )) as ProjectRoute;
    const served = await detailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id }),
    });
    await expect(served.json()).resolves.toMatchObject({
      project: {
        id,
        saveRevision: 0,
        saveWriterId: null,
        snapshot: { splitRatio: 0.4 },
      },
    });

    const migrated = await reloadedRoute.POST(
      postRequest({
        id,
        name: "Pre-change project",
        writerId: "writer-aaaaaaaa",
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.8),
      }) as Parameters<typeof reloadedRoute.POST>[0]
    );

    expect(migrated.status).toBe(200);
    expect(reloadedProjects.readProject(id)).toMatchObject({
      saveRevision: 1,
      saveWriterId: "writer-aaaaaaaa",
      saveWriterBaseRevision: 0,
      createRequestId: null,
      snapshot: { splitRatio: 0.8 },
    });
  });

  it("returns the original project when a committed create is retried after restart", async () => {
    const { route } = await loadRoute();
    const createRequestId = "create-aaaaaaaaaaaaaaaa";
    const writerId = "writer-aaaaaaaa";
    const first = await route.POST(
      postRequest({
        id: "idempotent-create",
        name: "Idempotent create",
        mode: "create",
        createRequestId,
        writerId,
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.4),
      }) as Parameters<typeof route.POST>[0]
    );
    expect(first.status).toBe(200);

    vi.resetModules();
    const reloadedRoute = (await import(
      "@/app/api/repurpose/projects/route"
    )) as ProjectsRoute;
    const reloadedProjects = (await import(
      "@/lib/repurpose/projects"
    )) as ProjectsStore;
    const retry = await reloadedRoute.POST(
      postRequest({
        id: "renamed-idempotent-create",
        name: "Renamed idempotent create",
        mode: "create",
        createRequestId,
        writerId,
        baseRevision: 0,
        saveRevision: 2,
        snapshot: snapshot(0.8),
      }) as Parameters<typeof reloadedRoute.POST>[0]
    );

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      project: {
        id: "idempotent-create",
        saveRevision: 2,
        saveWriterId: writerId,
      },
    });
    expect(reloadedProjects.readProject("idempotent-create")).toMatchObject({
      createRequestId,
      createWriterId: writerId,
      saveRevision: 2,
      snapshot: { splitRatio: 0.8 },
    });
    await expect(readdir(reloadedProjects.PROJECTS_DIR)).resolves.toEqual([
      "idempotent-create.json",
    ]);
  });

  it("returns the original commit for an exact keyed create replay", async () => {
    const { route, projects } = await loadRoute();
    const createRequestId = "create-exact-replay-aaaa";
    const writerId = "writer-exactreplay";
    const request = (splitRatio: number) =>
      route.POST(
        postRequest({
          id: "exact-create-replay",
          name: "Exact create replay",
          mode: "create",
          createRequestId,
          writerId,
          baseRevision: 0,
          saveRevision: 1,
          snapshot: snapshot(splitRatio),
        }) as Parameters<typeof route.POST>[0]
      );

    const first = await request(0.41);
    const replay = await request(0.89);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      project: {
        id: "exact-create-replay",
        saveRevision: 1,
        saveWriterId: writerId,
      },
    });
    expect(projects.readProject("exact-create-replay")).toMatchObject({
      createRequestId,
      createWriterId: writerId,
      saveRevision: 1,
      snapshot: { splitRatio: 0.41 },
    });
  });

  it("rejects a keyed create retry from a different writer", async () => {
    const { route, projects } = await loadRoute();
    const createRequestId = "create-bbbbbbbbbbbbbbbb";
    await route.POST(
      postRequest({
        id: "owned-create",
        name: "Owned create",
        mode: "create",
        createRequestId,
        writerId: "writer-aaaaaaaa",
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.4),
      }) as Parameters<typeof route.POST>[0]
    );
    const competingRetry = await route.POST(
      postRequest({
        id: "owned-create",
        name: "Owned create",
        mode: "create",
        createRequestId,
        writerId: "writer-bbbbbbbb",
        baseRevision: 1,
        saveRevision: 2,
        snapshot: snapshot(0.8),
      }) as Parameters<typeof route.POST>[0]
    );

    expect(competingRetry.status).toBe(409);
    expect(projects.readProject("owned-create")).toMatchObject({
      createRequestId,
      createWriterId: "writer-aaaaaaaa",
      saveRevision: 1,
      snapshot: { splitRatio: 0.4 },
    });
    await expect(readdir(projects.PROJECTS_DIR)).resolves.toEqual([
      "owned-create.json",
    ]);
  });

  it("rejects malformed create idempotency keys before writing", async () => {
    const { route, projects } = await loadRoute();
    for (const createRequestId of [123, "too-short", "create key with spaces"]) {
      const response = await route.POST(
        postRequest({
          id: "invalid-create-key",
          name: "Invalid create key",
          mode: "create",
          createRequestId,
          writerId: "writer-aaaaaaaa",
          baseRevision: 0,
          saveRevision: 1,
          snapshot: snapshot(0.4),
        }) as Parameters<typeof route.POST>[0]
      );
      expect(response.status).toBe(400);
    }
    expect(projects.readProject("invalid-create-key")).toBeNull();
    await expect(readdir(projects.PROJECTS_DIR)).resolves.toEqual([]);
  });

  it("keeps collision suffixing for legacy creates without an idempotency key", async () => {
    const { route } = await loadRoute();
    const create = () =>
      route.POST(
        postRequest({
          id: "legacy-create",
          name: "Legacy create",
          mode: "create",
          writerId: "writer-aaaaaaaa",
          baseRevision: 0,
          saveRevision: 1,
          snapshot: snapshot(0.4),
        }) as Parameters<typeof route.POST>[0]
      );

    const first = await create();
    const second = await create();

    await expect(first.json()).resolves.toMatchObject({
      project: { id: "legacy-create" },
    });
    await expect(second.json()).resolves.toMatchObject({
      project: { id: "legacy-create-2" },
    });
  });

  it("publishes a project through an atomic same-directory rename", async () => {
    const { route, projects } = await loadRoute();
    const rename = vi.spyOn(fs, "renameSync");

    const response = await route.POST(
      postRequest({
        id: "atomic-project",
        name: "Atomic project",
        writerId: "writer-aaaaaaaa",
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.5),
      }) as Parameters<typeof route.POST>[0]
    );

    expect(response.status).toBe(200);
    expect(rename).toHaveBeenCalledTimes(1);
    const [temporaryPath, finalPath] = rename.mock.calls[0];
    expect(path.dirname(String(temporaryPath))).toBe(path.dirname(String(finalPath)));
    expect(String(temporaryPath)).not.toBe(String(finalPath));
    expect(String(finalPath)).toBe(
      path.join(projects.PROJECTS_DIR, "atomic-project.json")
    );
    await expect(readdir(projects.PROJECTS_DIR)).resolves.toEqual([
      "atomic-project.json",
    ]);
  });

  it("serializes two disk mutations that target the same project lock", async () => {
    const { projects } = await loadRoute();
    const lock = (
      projects as ProjectsStore & {
        withProjectMutationLock?: <T>(
          projectId: string,
          mutation: () => Promise<T> | T
        ) => Promise<T>;
      }
    ).withProjectMutationLock;
    expect(lock).toBeTypeOf("function");
    if (!lock) return;

    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const order: string[] = [];

    const first = lock("locked-project", async () => {
      order.push("first-enter");
      firstEntered();
      await firstMayFinish;
      order.push("first-exit");
    });
    await firstDidEnter;
    expect(
      fs.existsSync(path.join(projects.PROJECTS_DIR, ".locked-project.lock"))
    ).toBe(true);
    const second = lock("locked-project", async () => {
      order.push("second-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(order).toEqual(["first-enter"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    expect(
      fs.existsSync(path.join(projects.PROJECTS_DIR, ".locked-project.lock"))
    ).toBe(false);
  });

  it("recovers only a lock whose recorded owner process is definitely dead", async () => {
    const { projects } = await loadRoute();
    const lock = (
      projects as ProjectsStore & {
        withProjectMutationLock?: <T>(
          projectId: string,
          mutation: () => Promise<T> | T
        ) => Promise<T>;
      }
    ).withProjectMutationLock;
    expect(lock).toBeTypeOf("function");
    if (!lock) return;

    const lockPath = path.join(projects.PROJECTS_DIR, ".dead-lock-project.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 99_999_999,
        token: "owner-from-dead-process",
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8"
    );

    const result = await lock("dead-lock-project", () => "recovered");

    expect(result).toBe("recovered");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not steal an old lock while its recorded owner process is alive", async () => {
    const { projects } = await loadRoute();
    const lock = (
      projects as ProjectsStore & {
        withProjectMutationLock?: <T>(
          projectId: string,
          mutation: () => Promise<T> | T
        ) => Promise<T>;
      }
    ).withProjectMutationLock;
    expect(lock).toBeTypeOf("function");
    if (!lock) return;

    const lockPath = path.join(projects.PROJECTS_DIR, ".live-lock-project.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "external-live-owner",
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8"
    );
    let entered = false;
    const pending = lock("live-lock-project", () => {
      entered = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.rmSync(lockPath, { recursive: true, force: true });
    await pending;

    expect(entered).toBe(true);
  });

  it("does not let two concurrent writers from one base both commit", async () => {
    const { route, projects } = await loadRoute();
    const save = (writerId: string, splitRatio: number) =>
      route.POST(
        postRequest({
          id: "concurrent-cas",
          name: "Concurrent CAS",
          writerId,
          baseRevision: 0,
          saveRevision: 1,
          snapshot: snapshot(splitRatio),
        }) as Parameters<typeof route.POST>[0]
      );

    const responses = await Promise.all([
      save("writer-aaaaaaaa", 0.31),
      save("writer-bbbbbbbb", 0.79),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const persisted = projects.readProject("concurrent-cas");
    expect(persisted?.saveRevision).toBe(1);
    expect([0.31, 0.79]).toContain(persisted?.snapshot.splitRatio);
  });

  it("makes create wait for the final project lock before publishing", async () => {
    const { route, projects } = await loadRoute();
    let release!: () => void;
    let entered!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = projects.withProjectMutationLock("create-final-lock", async () => {
      entered();
      await mayRelease;
    });
    await didEnter;

    let settled = false;
    const creating = route
      .POST(
        postRequest({
          id: "create-final-lock",
          name: "Create final lock",
          mode: "create",
          createRequestId: "create-final-lock-aaaa",
          writerId: "writer-createfinal",
          baseRevision: 0,
          saveRevision: 1,
          snapshot: snapshot(0.45),
        }) as Parameters<typeof route.POST>[0]
      )
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(settled).toBe(false);
    release();
    await held;
    expect((await creating).status).toBe(200);
  });

  it("makes delete wait for the same project mutation lock", async () => {
    const { route, projects } = await loadRoute();
    const detailRoute = (await import(
      "@/app/api/repurpose/projects/[id]/route"
    )) as ProjectRoute;
    await route.POST(
      postRequest({
        id: "delete-serialized",
        name: "Delete serialized",
        writerId: "writer-deleteaaaa",
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.5),
      }) as Parameters<typeof route.POST>[0]
    );
    let release!: () => void;
    let entered!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = projects.withProjectMutationLock("delete-serialized", async () => {
      entered();
      await mayRelease;
    });
    await didEnter;

    let settled = false;
    const deleting = detailRoute
      .DELETE(new Request("http://localhost"), {
        params: Promise.resolve({ id: "delete-serialized" }),
      })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(settled).toBe(false);
    release();
    await held;
    expect((await deleting).status).toBe(200);
    expect(projects.readProject("delete-serialized")).toBeNull();
  });

  it("recovers an old ownerless lock directory after the crash grace", async () => {
    const { projects } = await loadRoute();
    const lockPath = path.join(projects.PROJECTS_DIR, ".ownerless-lock.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    const result = await projects.withProjectMutationLock(
      "ownerless-lock",
      () => "recovered"
    );

    expect(result).toBe("recovered");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects autosave over a corrupt requested id instead of creating a suffix", async () => {
    const { route, projects } = await loadRoute();
    fs.mkdirSync(projects.PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(projects.PROJECTS_DIR, "corrupt-autosave.json"),
      "{not-json",
      "utf8"
    );

    const response = await route.POST(
      postRequest({
        id: "corrupt-autosave",
        name: "Corrupt autosave",
        writerId: "writer-corruptaa",
        baseRevision: 0,
        saveRevision: 1,
        snapshot: snapshot(0.6),
      }) as Parameters<typeof route.POST>[0]
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROJECT_FILE_CORRUPT" },
      project: { id: "corrupt-autosave" },
    });
    expect(fs.existsSync(path.join(projects.PROJECTS_DIR, "corrupt-autosave-2.json"))).toBe(false);
  });

  it("returns a typed conflict when GET finds a corrupt project file", async () => {
    const { projects } = await loadRoute();
    const id = "corrupt-project-get";
    fs.mkdirSync(projects.PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(projects.PROJECTS_DIR, `${id}.json`),
      "{not-json",
      "utf8"
    );
    const detailRoute = (await import(
      "@/app/api/repurpose/projects/[id]/route"
    )) as ProjectRoute;

    const response = await detailRoute.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROJECT_FILE_CORRUPT" },
      project: { id },
    });
  });

  it("keeps collision-suffixed ids within the 100 character validation limit", async () => {
    const { route, projects } = await loadRoute();
    const base = `a${"b".repeat(99)}`;
    const create = () =>
      route.POST(
        postRequest({
          id: base,
          name: "Maximum id",
          mode: "create",
          writerId: "writer-maxid-aaaa",
          baseRevision: 0,
          saveRevision: 1,
          snapshot: snapshot(0.5),
        }) as Parameters<typeof route.POST>[0]
      );
    expect((await create()).status).toBe(200);
    const second = await create();
    const body = (await second.json()) as { project: { id: string } };

    expect(second.status).toBe(200);
    expect(body.project.id.length).toBeLessThanOrEqual(100);
    expect(projects.isValidProjectId(body.project.id)).toBe(true);
    expect(projects.readProject(body.project.id)?.id).toBe(body.project.id);
  });
});
