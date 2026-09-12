import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import type { BackendDeps } from '../lib/backend/deps';
import type { QueueJob } from '@agentbox/relay';

// The slice's whole point: it is drivable with three seams and no relay handle.
function makeDeps(
  over: Partial<{ boxIds: string[]; jobs: Partial<QueueJob>[] }> = {},
): BackendDeps & {
  notify: ReturnType<typeof vi.fn>;
} {
  const notify = vi.fn();
  return {
    notify,
    liveBoxIds: async () => new Set(over.boxIds ?? []),
    jobs: async () => (over.jobs ?? []) as QueueJob[],
  };
}

async function makeFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubws-')));
  await mkdir(join(root, 'app', '.git'), { recursive: true });
  await mkdir(join(root, 'api', '.git'), { recursive: true });
  return root;
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

describe('addWorkspace', () => {
  it('registers a folder, discovers its projects and notifies', async () => {
    const deps = makeDeps();
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const res = await backend.addWorkspace({ path: root });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workspace.projectIds).toHaveLength(2);
    expect(res.workspace.taskCounts).toEqual({ open: 0, done: 0 });
    expect(res.workspace.manager).toBeNull();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(await backend.listWorkspaces()).toHaveLength(1);
  });

  it('refuses a relative path and a path that is not a directory', async () => {
    const backend = createWorkspaceBackend(makeDeps());
    expect(await backend.addWorkspace({ path: 'relative' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('absolute'),
    });
    expect(await backend.addWorkspace({ path: '/definitely/not/here' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a directory'),
    });
  });

  it('answers not-found shaped errors for an unknown workspace', async () => {
    const backend = createWorkspaceBackend(makeDeps());
    expect(await backend.getWorkspace('deadbeef')).toBeNull();
    expect(await backend.listTasks('deadbeef')).toBeNull();
    // The route maps this string to a 404 via failFromAction.
    expect(await backend.rescanWorkspace('deadbeef')).toMatchObject({
      ok: false,
      error: 'unknown workspace deadbeef',
    });
  });
});

describe('tasks', () => {
  async function seeded() {
    const deps = makeDeps({ boxIds: ['box1'] });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const res = await backend.addWorkspace({ path: root });
    if (!res.ok) throw new Error(res.error);
    deps.notify.mockClear();
    return { backend, deps, wsId: res.workspace.id };
  }

  it('adds, lists in order, updates and completes', async () => {
    const { backend, deps, wsId } = await seeded();
    await backend.addTask(wsId, { title: 'first' });
    await backend.addTask(wsId, { title: 'second' });
    const tasks = await backend.listTasks(wsId);
    expect(tasks?.map((t) => t.title)).toEqual(['first', 'second']);
    await backend.updateTask(wsId, 'T-2', { status: 'blocked' });
    expect((await backend.getTask(wsId, 'T-2'))?.status).toBe('blocked');
    const done = await backend.completeTask(wsId, 'T-1');
    expect(done).toMatchObject({ ok: true });
    expect((await backend.getWorkspace(wsId))?.taskCounts).toEqual({ open: 1, done: 1 });
    // Every mutation fires the live-update fan-out.
    expect(deps.notify.mock.calls.length).toBe(4);
  });

  it('filters by status, project and box', async () => {
    const { backend, wsId } = await seeded();
    await backend.addTask(wsId, { title: 'a', projectId: 'p1' });
    await backend.addTask(wsId, { title: 'b' });
    await backend.assignTasks(wsId, ['T-2'], { boxId: 'box1' });
    expect((await backend.listTasks(wsId, { projectId: 'p1' }))?.map((t) => t.id)).toEqual(['T-1']);
    expect((await backend.listTasks(wsId, { boxId: 'box1' }))?.map((t) => t.id)).toEqual(['T-2']);
    expect((await backend.listTasks(wsId, { status: 'todo' }))?.map((t) => t.id)).toEqual(['T-1']);
  });

  it('refuses an assignment to a box or job that does not exist', async () => {
    const { backend, wsId } = await seeded();
    await backend.addTask(wsId, { title: 'a' });
    expect(await backend.assignTasks(wsId, ['T-1'], { boxId: 'ghost' })).toMatchObject({
      ok: false,
      error: 'unknown box ghost',
    });
    expect(await backend.assignTasks(wsId, ['T-1'], { boxJobId: 'ghost' })).toMatchObject({
      ok: false,
      error: 'unknown job ghost',
    });
  });

  it('reorders and refuses a partial order', async () => {
    const { backend, wsId } = await seeded();
    for (const t of ['a', 'b', 'c']) await backend.addTask(wsId, { title: t });
    const res = await backend.reorderTasks(wsId, ['T-3', 'T-2', 'T-1']);
    expect(res.ok && res.tasks.map((t) => t.id)).toEqual(['T-3', 'T-2', 'T-1']);
    expect(await backend.reorderTasks(wsId, ['T-1'])).toMatchObject({ ok: false });
  });

  it('answers unknown-task errors the routes can map to 404', async () => {
    const { backend, wsId } = await seeded();
    expect(await backend.completeTask(wsId, 'T-9')).toMatchObject({
      ok: false,
      error: 'unknown task T-9',
    });
    expect(await backend.removeTask(wsId, 'T-9')).toMatchObject({
      ok: false,
      error: 'unknown task T-9',
    });
    expect(await backend.updateTask(wsId, 'T-9', { title: 'x' })).toMatchObject({ ok: false });
  });
});

describe('reconciliation through the backend', () => {
  it('promotes a pending create job to its box id once the worker records it', async () => {
    const deps = makeDeps({ jobs: [{ id: 'j1', kind: 'create', status: 'queued' }] });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const added = await backend.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    await backend.addTask(wsId, { title: 'a', boxJobId: 'j1' });
    expect((await backend.listTasks(wsId))?.[0]).toMatchObject({ boxJobId: 'j1' });

    // The worker finishes: the job now carries a box id and the box is live.
    const after = createWorkspaceBackend(
      makeDeps({
        boxIds: ['box9'],
        jobs: [{ id: 'j1', kind: 'create', status: 'done', boxId: 'box9' }],
      }),
    );
    const healed = await after.listTasks(wsId);
    expect(healed?.[0]).toMatchObject({ boxId: 'box9' });
    expect(healed?.[0]?.boxJobId).toBeUndefined();
  });

  it('returns a task to the backlog when its box is destroyed', async () => {
    const deps = makeDeps({ boxIds: ['box1'] });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const added = await backend.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    await backend.addTask(wsId, { title: 'a', boxId: 'box1' });
    const gone = createWorkspaceBackend(makeDeps({ boxIds: [] }));
    const healed = await gone.listTasks(wsId);
    expect(healed?.[0]?.boxId).toBeUndefined();
    // Reconciliation heals assignment, never progress.
    expect(healed?.[0]?.status).toBe('in_progress');
  });
});

describe('getData hooks', () => {
  it('maps projects to their workspace and rolls tasks up per box and per job', async () => {
    const deps = makeDeps({
      boxIds: ['box1'],
      jobs: [{ id: 'j1', kind: 'create', status: 'running' }],
    });
    const backend = createWorkspaceBackend(deps);
    const root = await makeFolder();
    const added = await backend.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    const projectId = added.workspace.projectIds[0]!;

    await backend.addTask(wsId, { title: 'a', boxId: 'box1' });
    await backend.addTask(wsId, { title: 'b', boxId: 'box1' });
    await backend.completeTask(wsId, 'T-1');
    await backend.addTask(wsId, { title: 'c', boxJobId: 'j1' });

    expect((await backend.workspaceIdByProject()).get(projectId)).toBe(wsId);
    const { byBox, byJob } = await backend.taskSummaries();
    expect(byBox.get('box1')).toEqual({ total: 2, done: 1, current: { id: 'T-2', title: 'b' } });
    expect(byJob.get('j1')?.total).toBe(1);
    expect(byBox.get('nothing')).toBeUndefined();
  });
});

describe('manager', () => {
  it('is "never" before a start and refuses an unknown workspace', async () => {
    const backend = createWorkspaceBackend(makeDeps());
    const root = await makeFolder();
    const added = await backend.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    expect((await backend.getManager(added.workspace.id))?.status).toBe('never');
    expect(await backend.getManager('deadbeef')).toBeNull();
    expect(await backend.listManagerSessions('deadbeef')).toBeNull();
    expect(await backend.stopManager('deadbeef')).toMatchObject({ ok: false });
  });

  it('rejects a session resume for an agent whose format we cannot resume', async () => {
    // The exec seam is stubbed on purpose: if the resumable guard ever regresses,
    // this test would otherwise fall through to a real `tmux new-session` and
    // leave a coding agent running on whoever's machine ran the suite.
    const spawned: string[][] = [];
    const backend = createWorkspaceBackend({
      ...makeDeps(),
      managerExec: async (_file: string, args: string[]) => {
        spawned.push(args);
        return { exitCode: 0 };
      },
    });
    const root = await makeFolder();
    const added = await backend.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const res = await backend.startManager(added.workspace.id, {
      agent: 'opencode',
      sessionId: 's1',
    });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('only supported for claude, codex'),
    });
    expect(spawned).toEqual([]);
  });
});
