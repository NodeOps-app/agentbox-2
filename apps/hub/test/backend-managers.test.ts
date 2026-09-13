import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import { createManagerBackend } from '../lib/backend/managers';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import type { BackendDeps } from '../lib/backend/deps';
import type { QueueJob } from '@agentbox/relay';

const S1 = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const S2 = '01a09ad5-8f51-7ec0-b8f4-2daa8be67500';

interface Harness {
  deps: BackendDeps & { notify: ReturnType<typeof vi.fn> };
  spawned: string[][];
  alive: Set<number>;
  tmux: Set<string>;
}

// Every process seam is faked: a regression in a guard must never start a real
// agent or tmux session on the machine running the suite.
function harness(over: { boxIds?: string[]; jobs?: Partial<QueueJob>[] } = {}): Harness {
  const spawned: string[][] = [];
  const alive = new Set<number>();
  const tmux = new Set<string>();
  const deps = {
    notify: vi.fn(),
    liveBoxIds: async () => new Set(over.boxIds ?? []),
    jobs: async () => (over.jobs ?? []) as QueueJob[],
    hostname: () => 'laptop',
    isPidAlive: (pid: number) => alive.has(pid),
    managerExec: async (_file: string, args: string[]) => {
      spawned.push(args);
      if (args[0] === 'new-session') tmux.add(args[3]!);
      if (args[0] === 'kill-session') tmux.delete(args[2]!.slice(1));
      if (args[0] === 'has-session' && !tmux.has(args[2]!.slice(1))) throw new Error('no session');
      return { exitCode: 0 };
    },
  };
  return { deps, spawned, alive, tmux };
}

function backends(h: Harness) {
  const workspaces = createWorkspaceBackend(h.deps);
  const managers = createManagerBackend(h.deps, {
    workspaceView: (id) => workspaces.getWorkspace(id),
  });
  return { workspaces, managers };
}

async function makeFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubmgr-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

describe('detectManager', () => {
  it('creates a workspace at the cwd when none contains it, then refreshes the same record', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const root = await makeFolder();
    h.alive.add(4242);
    const first = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 4242,
      host: 'laptop',
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.created).toBe(true);
    expect(first.workspace).toMatchObject({ root, managers: { running: 1, total: 1 } });
    expect(first.manager).toMatchObject({ kind: 'external', status: 'running', pid: 4242 });
    expect(h.deps.notify).toHaveBeenCalled();

    const again = await managers.detectManager({ agent: 'claude', sessionId: S1, cwd: root });
    if (!again.ok) throw new Error(again.error);
    expect(again.created).toBe(false);
    expect(again.manager.id).toBe(first.manager.id);
    expect(await workspaces.listWorkspaces()).toHaveLength(1);
    expect(h.spawned).toEqual([]);
  });

  it('reuses the workspace containing the cwd, and attaches a box in the same call', async () => {
    const h = harness({ boxIds: ['b1'] });
    const { workspaces, managers } = backends(h);
    const root = await makeFolder();
    await mkdir(join(root, 'sub'));
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const res = await managers.detectManager({
      agent: 'codex',
      sessionId: S2,
      cwd: join(root, 'sub'),
      boxId: 'b1',
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.created).toBe(true);
    expect(res.workspace.id).toBe(added.workspace.id);
    expect(res.manager.boxIds).toEqual(['b1']);
    expect((await managers.managerByBox()).get('b1')).toBe(res.manager.id);
  });
});

describe('liveness and lifecycle', () => {
  async function external(h: Harness) {
    const { managers, workspaces } = backends(h);
    const root = await makeFolder();
    h.alive.add(99);
    const res = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 99,
      host: 'laptop',
    });
    if (!res.ok) throw new Error(res.error);
    return { managers, workspaces, manager: res.manager, root };
  }

  it('flips to stopped when the pid dies, and filters by status', async () => {
    const h = harness();
    const { managers, manager } = await external(h);
    expect((await managers.listManagers({ status: 'running' })).map((m) => m.id)).toEqual([
      manager.id,
    ]);
    h.alive.delete(99);
    expect((await managers.getManager(manager.id))?.status).toBe('stopped');
    expect(await managers.listManagers({ status: 'running' })).toEqual([]);
  });

  it('refuses to resume, stop, forget or unregister around a live external session', async () => {
    const h = harness();
    const { managers, workspaces, manager } = await external(h);
    expect(await managers.resumeManager(manager.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('still running in a terminal'),
    });
    expect(await managers.stopManager(manager.id)).toMatchObject({ ok: false });
    expect(await managers.removeManager(manager.id)).toMatchObject({ ok: false });
    expect(await workspaces.removeWorkspace(manager.workspaceId)).toMatchObject({ ok: false });
    expect(h.spawned.filter((a) => a[0] === 'new-session')).toEqual([]);
  });

  it('resumes a stopped external session in tmux as a hub manager, then stops it', async () => {
    const h = harness();
    const { managers, manager, root } = await external(h);
    h.alive.delete(99);
    const resumed = await managers.resumeManager(manager.id);
    if (!resumed.ok) throw new Error(resumed.error);
    const start = h.spawned.find((a) => a[0] === 'new-session')!;
    expect(start.slice(0, 6)).toEqual([
      'new-session',
      '-d',
      '-s',
      `agentbox-manager-${manager.id}`,
      '-c',
      root,
    ]);
    expect(start[9]).toContain(`'claude' '--resume' '${S1}'`);
    expect(resumed.manager).toMatchObject({ kind: 'hub', status: 'running' });
    expect(resumed.manager.attachCommand).toBe(`tmux attach -t =agentbox-manager-${manager.id}`);

    const stopped = await managers.stopManager(manager.id);
    if (!stopped.ok) throw new Error(stopped.error);
    expect(stopped.manager.status).toBe('stopped');
    expect(await managers.removeManager(manager.id)).toEqual({ ok: true });
    expect(await managers.getManager(manager.id)).toBeNull();
  });

  it('answers unknown-manager errors the envelope maps to 404', async () => {
    const { managers } = backends(harness());
    for (const res of [
      await managers.resumeManager('ffffffffffffffff'),
      await managers.stopManager('ffffffffffffffff'),
      await managers.removeManager('ffffffffffffffff'),
      await managers.attachJob('ffffffffffffffff', 'j1'),
    ]) {
      expect(res).toMatchObject({ ok: false, error: 'unknown manager ffffffffffffffff' });
    }
    expect(await managers.listWorkspaceManagers('deadbeef')).toBeNull();
    expect(await managers.listManagerSessions('deadbeef')).toBeNull();
  });
});

describe('startManager', () => {
  it('starts several hub managers in one workspace, and resumes a held session instead of duplicating it', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace({ path: await makeFolder() });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    const a = await managers.startManager(wsId, { agent: 'claude' });
    const b = await managers.startManager(wsId, { agent: 'codex' });
    if (!a.ok || !b.ok) throw new Error('start failed');
    expect(a.manager.id).not.toBe(b.manager.id);
    expect((await workspaces.getWorkspace(wsId))?.managers).toEqual({ running: 2, total: 2 });

    // The hub-run claude reports its session id from inside its own tmux.
    await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: added.workspace.root,
      managerId: a.manager.id,
    });
    expect(await managers.startManager(wsId, { agent: 'claude', sessionId: S1 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('already running'),
    });
    const restarted = await managers.startManager(wsId, {
      agent: 'claude',
      sessionId: S1,
      restart: true,
    });
    if (!restarted.ok) throw new Error(restarted.error);
    expect(restarted.manager.id).toBe(a.manager.id);
    expect(await managers.listWorkspaceManagers(wsId)).toHaveLength(2);
  });

  it('rejects a session resume for an agent whose format we cannot resume', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace({ path: await makeFolder() });
    if (!added.ok) throw new Error(added.error);
    const res = await managers.startManager(added.workspace.id, {
      agent: 'opencode',
      sessionId: 's1',
    });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('only supported for claude, codex'),
    });
    expect(h.spawned.filter((a) => a[0] === 'new-session')).toEqual([]);
  });
});

describe('box pointers', () => {
  it('attaches a create job and heals it to the box the worker recorded', async () => {
    const h = harness({
      boxIds: ['box-9'],
      jobs: [{ id: 'job-1', status: 'done', boxId: 'box-9' }],
    });
    const { managers, workspaces } = backends(h);
    const root = await makeFolder();
    const res = await managers.detectManager({ agent: 'claude', sessionId: S1, cwd: root });
    if (!res.ok) throw new Error(res.error);
    expect(await managers.attachJob(res.manager.id, 'job-1')).toEqual({ ok: true });
    const byBox = await managers.managerByBox();
    expect(byBox.get('box-9')).toBe(res.manager.id);
    expect((await managers.getManager(res.manager.id))?.boxIds).toEqual(['box-9']);

    // A task assigned to that box joins the manager that made it.
    await workspaces.addTask(res.workspace.id, { title: 'x' });
    const assigned = await workspaces.assignTasks(res.workspace.id, ['T-1'], { boxId: 'box-9' });
    if (!assigned.ok) throw new Error(assigned.error);
    expect(assigned.tasks[0]?.managerId).toBe(res.manager.id);
    expect(
      await workspaces.listTasks(res.workspace.id, { managerId: res.manager.id }),
    ).toHaveLength(1);
    expect((await managers.getManager(res.manager.id))?.taskCounts).toEqual({ open: 1, done: 0 });
  });
});
