import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import {
  findProjectByCreateRequestId,
  isValidProjectId,
  listProjects,
  ProjectMutationLockTimeoutError,
  projectFileExists,
  readProject,
  uniqueId,
  withProjectMutationLock,
  writeProject,
  type ProjectFile,
} from '@/lib/repurpose/projects';
import type { ProjectSnapshot } from '@/lib/repurpose/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET -> list all projects as lightweight metadata (newest-first).
export async function GET() {
  return NextResponse.json({ projects: listProjects() });
}

interface PostBody {
  id?: unknown;
  name?: unknown;
  snapshot?: unknown;
  createdAt?: unknown;
  durationSec?: unknown;
  writerId?: unknown;
  baseRevision?: unknown;
  saveRevision?: unknown;
  createRequestId?: unknown;
  /**
   * "create" makes a collision-free project unless createRequestId resolves an
   * earlier attempt from the same writer. Anything else is an autosave upsert.
   */
  mode?: unknown;
}

// POST -> create or upsert a project.
//   - mode:"create" -> reuse a matching keyed attempt, otherwise collision-suffix.
//   - otherwise (autosave) -> upsert the given id in place (idempotent re-save).
// The returned id is authoritative (may be suffixed) and the client trusts it.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PostBody;

  if (!isValidProjectId(body.id)) {
    return NextResponse.json({ error: 'valid id required' }, { status: 400 });
  }
  const requestedId = body.id;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (!body.snapshot || typeof body.snapshot !== 'object') {
    return NextResponse.json(
      { error: 'snapshot object required' },
      { status: 400 },
    );
  }

  const snapshot = body.snapshot as ProjectSnapshot;
  const now = new Date().toISOString();

  const durationSec =
    typeof body.durationSec === 'number' && Number.isFinite(body.durationSec)
      ? body.durationSec
      : typeof snapshot.duration === 'number'
        ? snapshot.duration
        : 0;

  const isCreate = body.mode === 'create';
  const createRequestId =
    typeof body.createRequestId === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(body.createRequestId)
      ? body.createRequestId
      : null;
  if (
    body.createRequestId !== undefined &&
    (!isCreate || createRequestId === null)
  ) {
    return NextResponse.json(
      { error: 'valid createRequestId requires mode create' },
      { status: 400 },
    );
  }
  const hasSaveControl =
    body.writerId !== undefined ||
    body.baseRevision !== undefined ||
    body.saveRevision !== undefined;
  const writerId =
    typeof body.writerId === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(body.writerId)
      ? body.writerId
      : null;
  const baseRevision =
    typeof body.baseRevision === 'number' &&
    Number.isSafeInteger(body.baseRevision) &&
    body.baseRevision >= 0
      ? body.baseRevision
      : null;
  const requestedSaveRevision =
    typeof body.saveRevision === 'number' &&
    Number.isSafeInteger(body.saveRevision) &&
    body.saveRevision > 0
      ? body.saveRevision
      : null;
  if (
    hasSaveControl &&
    (writerId === null || baseRevision === null || requestedSaveRevision === null)
  ) {
    return NextResponse.json(
      { error: 'valid writerId, baseRevision, and saveRevision required' },
      { status: 400 },
    );
  }
  if (createRequestId !== null && writerId === null) {
    return NextResponse.json(
      { error: 'keyed create requires valid writer save control' },
      { status: 400 },
    );
  }

  const projectResponse = (file: ProjectFile) =>
    NextResponse.json({
      project: {
        id: file.id,
        name: file.name,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        durationSec: file.durationSec,
        saveRevision: file.saveRevision,
        saveWriterId: file.saveWriterId,
      },
    });

  const mutateProject = async (id: string, existing: ProjectFile | null) => {
      const currentRevision = existing?.saveRevision ?? 0;
      const conflict = (reason: string) =>
        NextResponse.json(
          {
            error: {
              code: 'PROJECT_SAVE_CONFLICT',
              reason,
              message: 'Project was saved by another writer or a newer request.',
            },
            project: existing
              ? {
                  id: existing.id,
                  saveRevision: existing.saveRevision,
                  saveWriterId: existing.saveWriterId,
                }
              : { id, saveRevision: 0, saveWriterId: null },
          },
          { status: 409 },
        );
      if (
        createRequestId !== null &&
        existing &&
        existing.createWriterId !== writerId
      ) {
        return conflict('CREATE_WRITER_MISMATCH');
      }

      // The create request key, writer, and revision identify one committed
      // operation. Replaying it returns that commit without overwriting its
      // snapshot or timestamps. A larger revision continues through normally.
      if (
        createRequestId !== null &&
        existing &&
        existing.createWriterId === writerId &&
        existing.saveRevision === requestedSaveRevision
      ) {
        return projectResponse(existing);
      }

      let saveRevision = 0;
      let saveWriterId: string | null = null;
      let saveWriterBaseRevision = 0;
      if (!hasSaveControl) {
        if (existing && existing.saveRevision > 0) {
          return conflict('REVISION_CONTROL_REQUIRED');
        }
      } else {
        const nextRevision = requestedSaveRevision as number;
        const requestBase = baseRevision as number;
        const requestWriter = writerId as string;
        if (!existing || existing.saveRevision === 0) {
          if (requestBase !== currentRevision) {
            return conflict('BASE_MISMATCH');
          }
          if (nextRevision <= currentRevision) {
            return conflict('STALE_REVISION');
          }
          saveWriterId = requestWriter;
          saveWriterBaseRevision = requestBase;
        } else if (existing.saveWriterId === requestWriter) {
          const baseIsInWriterChain =
            requestBase >= existing.saveWriterBaseRevision &&
            requestBase <= existing.saveRevision;
          if (!baseIsInWriterChain) {
            return conflict('WRITER_CHAIN_MISMATCH');
          }
          if (nextRevision <= existing.saveRevision) {
            return conflict('SUPERSEDED_SAME_WRITER');
          }
          saveWriterId = requestWriter;
          saveWriterBaseRevision = existing.saveWriterBaseRevision;
        } else {
          if (requestBase !== existing.saveRevision) {
            return conflict('BASE_MISMATCH');
          }
          if (nextRevision <= existing.saveRevision) {
            return conflict('STALE_REVISION');
          }
          saveWriterId = requestWriter;
          saveWriterBaseRevision = requestBase;
        }
        saveRevision = nextRevision;
      }

      // Preserve the original createdAt on re-save; else prefer the client's
      // provided createdAt (if a non-empty string), else stamp now.
      const createdAt = existing
        ? existing.createdAt
        : typeof body.createdAt === 'string' && body.createdAt.trim()
          ? body.createdAt
          : now;

      const file: ProjectFile = {
        id,
        name,
        createdAt,
        updatedAt: now,
        durationSec,
        saveRevision,
        saveWriterId,
        saveWriterBaseRevision,
        createRequestId: existing?.createRequestId ?? createRequestId,
        createWriterId:
          existing?.createWriterId ??
          (createRequestId !== null ? writerId : null),
        snapshot,
      };
      await writeProject(file);
      return projectResponse(file);
  };

  try {
    if (isCreate) {
      // Creation needs a global allocation lock and the same final-id lock used
      // by autosave/delete. Holding them in this fixed order prevents both a
      // suffix race and a last-rename-wins race on the chosen project file.
      if (requestedId === 'project-create-lock') {
        return NextResponse.json({ error: 'reserved project id' }, { status: 400 });
      }
      return await withProjectMutationLock('project-create-lock', async () => {
        while (true) {
          const keyed = createRequestId
            ? findProjectByCreateRequestId(createRequestId)
            : null;
          const candidateId = keyed?.id ?? uniqueId(requestedId);
          const attempt = await withProjectMutationLock(candidateId, () => {
            const keyedInside = createRequestId
              ? findProjectByCreateRequestId(createRequestId)
              : null;
            if (keyedInside && keyedInside.id !== candidateId) {
              return null;
            }
            const existing = keyedInside ?? readProject(candidateId);
            // A non-keyed create, or a keyed create not yet committed, must not
            // adopt a project that an autosave published after allocation.
            if (!keyedInside && projectFileExists(candidateId)) {
              return null;
            }
            return mutateProject(candidateId, existing);
          });
          if (attempt) return attempt;
        }
      });
    }

    return await withProjectMutationLock<Response>(requestedId, () => {
      const existing = readProject(requestedId);
      if (!existing && projectFileExists(requestedId)) {
        return NextResponse.json(
          {
            error: {
              code: 'PROJECT_FILE_CORRUPT',
              message: 'Project file is corrupt and must be recovered before saving.',
            },
            project: { id: requestedId, saveRevision: 0, saveWriterId: null },
          },
          { status: 409 },
        );
      }
      return mutateProject(requestedId, existing);
    });
  } catch (error) {
    if (error instanceof ProjectMutationLockTimeoutError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: 'Project is busy; retry the save.',
          },
        },
        { status: 503 },
      );
    }
    throw error;
  }
}
