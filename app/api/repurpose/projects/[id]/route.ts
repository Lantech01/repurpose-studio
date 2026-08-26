import 'server-only';

import { NextResponse } from 'next/server';

import {
  deleteProject,
  isValidProjectId,
  ProjectMutationLockTimeoutError,
  projectFileExists,
  readProject,
  withProjectMutationLock,
} from '@/lib/repurpose/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// GET -> the FULL ProjectFile (incl snapshot) for one project.
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isValidProjectId(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const project = readProject(id);
  if (!project) {
    if (projectFileExists(id)) {
      return NextResponse.json(
        {
          error: {
            code: 'PROJECT_FILE_CORRUPT',
            message: 'Project file is corrupt and must be recovered.',
          },
          project: { id },
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ project });
}

// DELETE -> remove one project. 404 if it did not exist.
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isValidProjectId(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  try {
    return await withProjectMutationLock(id, async () => {
      if (!(await deleteProject(id))) {
        return NextResponse.json({ error: 'not found' }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    if (error instanceof ProjectMutationLockTimeoutError) {
      return NextResponse.json(
        { error: { code: error.code, message: 'Project is busy; retry delete.' } },
        { status: 503 },
      );
    }
    throw error;
  }
}
