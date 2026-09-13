import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import { createManagerBackend } from '../lib/backend/managers';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import { createGithubPrSync } from '../lib/backend/github-prs';
import {
  aggregateTimeline,
  buildTimelineSummary,
  createTimelineBackend,
  liveReadyItems,
  parseShortstat,
} from '../lib/backend/timeline';
import type { BackendDeps, TimelineBoxFact } from '../lib/backend/deps';
import { readTimeline, readWorkspace, type TimelineEvent } from '@agentbox/relay';

const S1 = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const MGR = '0123456789abcdef';

let seq = 0;
function ev(over: Partial<TimelineEvent> & Pick<TimelineEvent, 'type'>): TimelineEvent {
  seq += 1;
  return {
    id: `id${String(seq).padStart(4, '0')}`,
    at: new Date(Date.UTC(2026, 8, 13, 10, 0, seq)).toISOString(),
    actor: 'manager',
    ...over,
  };
}

function created(taskId: string, over: Partial<TimelineEvent> = {}): TimelineEvent {
  return ev({
    type: 'task.created',
    managerId: MGR,
    turn: 12,
    prompt: 'plan the checkout work',
    task: { id: taskId, title: taskId, to: 'todo' },
    taskIds: [taskId],
    ...over,
  });
}

const pr = (number: number, over: Partial<NonNullable<TimelineEvent['pr']>> = {}) => ({
  repo: 'o/r',
  number,
  title: `PR ${String(number)}`,
  url: `https://github.com/o/r/pull/${String(number)}`,
  base: 'main',
  head: `agentbox/b${String(number)}`,
  ...over,
});

describe('aggregateTimeline', () => {
  it('collapses 3+ task creates from one manager turn into one plan item', () => {
    const items = aggregateTimeline([created('T-1'), created('T-2'), created('T-3')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'plan',
      count: 3,
      managerId: MGR,
      turn: 12,
      prompt: 'plan the checkout work',
      taskIds: ['T-1', 'T-2', 'T-3'],
    });
  });

  it('leaves two creates, other turns and creates outside the window alone', () => {
    expect(aggregateTimeline([created('T-1'), created('T-2')]).map((i) => i.type)).toEqual([
      'task.created',
      'task.created',
    ]);
    const spread = aggregateTimeline([
      created('T-1'),
      created('T-2', { turn: 13 }),
      created('T-3', { at: '2026-09-13T11:00:00.000Z' }),
    ]);
    expect(spread.every((i) => i.type === 'task.created')).toBe(true);
  });

  it('drops a move to in_progress that is just the assignment, and marks an approved merge', () => {
    const items = aggregateTimeline([
      ev({ type: 'task.assigned', taskIds: ['T-4'] }),
      ev({ type: 'task.status', task: { id: 'T-4', title: 'x', from: 'todo', to: 'in_progress' } }),
      ev({
        type: 'manager.message',
        actor: 'human',
        managerId: MGR,
        pr: pr(409),
        text: 'Approved',
      }),
      ev({ type: 'pr.merged', actor: 'github', pr: pr(409) }),
      ev({ type: 'pr.merged', actor: 'github', pr: pr(405) }),
    ]);
    expect(items.map((i) => i.type)).toEqual([
      'pr.merged',
      'pr.merged',
      'manager.message',
      'task.assigned',
    ]);
    expect(items.find((i) => i.pr?.number === 409)?.approvedByYou).toBe(true);
    expect(items.find((i) => i.pr?.number === 405)?.approvedByYou).toBeUndefined();
  });
});

describe('live rows and summary', () => {
  it('keeps a ready PR live until it merges, and marks it approved once messaged', () => {
    const ready409 = ev({ type: 'pr.ready', actor: 'github', pr: pr(409), boxId: 'b1' });
    const ready405 = ev({ type: 'pr.ready', actor: 'github', pr: pr(405) });
    const merged405 = ev({ type: 'pr.merged', actor: 'github', pr: pr(405) });
    expect(liveReadyItems([ready409, ready405, merged405])).toEqual([
      expect.objectContaining({ type: 'pr.ready', boxId: 'b1', awaiting: true }),
    ]);
    const message = ev({ type: 'manager.message', actor: 'human', pr: pr(409) });
    expect(liveReadyItems([ready409, message])[0]?.approved).toBe(true);
    // The last sync saw it go red: not awaiting anyone any more.
    expect(liveReadyItems([ready409], () => 'open')).toEqual([]);
  });

  it('sums merges and finished tasks since a time, and counts what awaits you', () => {
    const events = [
      ev({
        type: 'pr.merged',
        pr: pr(1, { additions: 100, deletions: 20 }),
        at: '2026-09-13T09:00:00.000Z',
      }),
      ev({
        type: 'pr.merged',
        pr: pr(2, { additions: 5, deletions: 1 }),
        at: '2026-09-13T12:00:00.000Z',
      }),
      ev({
        type: 'task.status',
        task: { id: 'T-1', title: 'x', to: 'done' },
        at: '2026-09-13T12:00:00.000Z',
      }),
    ];
    const live = liveReadyItems([ev({ type: 'pr.ready', pr: pr(3) })]);
    expect(buildTimelineSummary(events, '2026-09-13T10:00:00.000Z', live, 2)).toEqual({
      since: '2026-09-13T10:00:00.000Z',
      merged: 1,
      additions: 5,
      deletions: 1,
      tasksDone: 1,
      awaiting: 3,
    });
  });

  it('parses git diff --shortstat', () => {
    expect(parseShortstat(' 3 files changed, 84 insertions(+), 31 deletions(-)\n')).toEqual({
      filesChanged: 3,
      additions: 84,
      deletions: 31,
    });
    expect(parseShortstat(' 1 file changed, 1 deletion(-)')).toEqual({
      filesChanged: 1,
      additions: 0,
      deletions: 1,
    });
  });
});

// ── against the store ──

interface Harness {
  deps: BackendDeps;
  spawned: string[][];
  tmux: Set<string>;
  alive: Set<number>;
  boxes: TimelineBoxFact[];
  gh: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const spawned: string[][] = [];
  const tmux = new Set<string>();
  const alive = new Set<number>();
  const boxes: TimelineBoxFact[] = [];
  const gh = vi.fn(async (_args: string[]) => ({ exitCode: 1, stdout: '', stderr: 'no gh' }));
  const deps: BackendDeps = {
    notify: vi.fn(),
    liveBoxIds: async () => new Set(boxes.map((b) => b.id)),
    jobs: async () => [],
    hostname: () => 'laptop',
    isPidAlive: (pid) => alive.has(pid),
    processStartTime: async () => undefined,
    managerExec: async (_file, args) => {
      spawned.push(args);
      if (args[0] === 'new-session') tmux.add(args[3]!);
      if (args[0] === 'has-session' && !tmux.has(args[2]!.slice(1))) throw new Error('no session');
      return { exitCode: 0 };
    },
    boxFacts: async () => boxes,
    boxDiffStat: async () => ({ filesChanged: 3, additions: 84, deletions: 31 }),
    pendingApprovalBoxIds: () => [],
    ghExec: gh,
  };
  return { deps, spawned, tmux, alive, boxes, gh };
}

function backends(h: Harness) {
  const workspaces = createWorkspaceBackend(h.deps);
  const managers = createManagerBackend(h.deps, {
    workspaceView: (id) => workspaces.getWorkspace(id),
    sessionTurn: async () => ({ turn: 41, prompt: 'hold B until A merges' }),
    sleep: async () => {},
  });
  return { workspaces, managers };
}

async function folder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hubtl-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox'), { recursive: true, force: true });
});

describe('timeline writes and reads', () => {
  it('logs a manager plan, a note and gave-more-work, and shows the box working live', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const root = await folder();
    h.alive.add(4242);
    const detected = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 4242,
      host: 'laptop',
    });
    if (!detected.ok) throw new Error(detected.error);
    const wsId = detected.workspace.id;
    const stamp = await managers.timelineStamp({ agent: 'claude', sessionId: S1 }, wsId);
    expect(stamp).toEqual({
      actor: 'manager',
      managerId: detected.manager.id,
      turn: 41,
      prompt: 'hold B until A merges',
    });
    expect(
      await managers.timelineStamp({ agent: 'claude', sessionId: S1 }, 'ffffffffffffffff'),
    ).toBeUndefined();

    for (const title of ['A', 'B', 'C']) {
      const r = await workspaces.addTask(wsId, { title }, { stamp });
      if (!r.ok) throw new Error(r.error);
    }
    h.boxes.push({
      id: 'box1',
      name: 'payment-retries',
      branches: ['agentbox/payment-retries'],
      state: 'running',
      agent: 'claude',
      projectRoot: root,
      projectId: 'p1',
    });
    const assigned = await workspaces.assignTasks(
      wsId,
      ['T-1'],
      { boxId: 'box1' },
      {
        stamp,
        note: 'A first: B depends on it',
      },
    );
    if (!assigned.ok) throw new Error(assigned.error);
    const note = await managers.addManagerNote(detected.manager.id, {
      text: 'holding B until A merges',
      kind: 'replan',
    });
    if (!note.ok) throw new Error(note.error);
    expect(note.event).toMatchObject({ type: 'manager.note', turn: 41, noteKind: 'replan' });

    const timeline = createTimelineBackend(h.deps);
    const res = await timeline.getTimeline(wsId, { since: '2000-01-01T00:00:00.000Z' });
    expect(res?.github).toBe('syncing');
    const types = res!.items.map((i) => i.type);
    expect(types).toContain('plan');
    expect(types).toContain('manager.joined');
    expect(res!.items.find((i) => i.type === 'plan')).toMatchObject({
      count: 3,
      turn: 41,
      managerId: detected.manager.id,
    });
    expect(res!.items.find((i) => i.type === 'task.assigned')).toMatchObject({
      boxRunning: true,
      boxName: 'payment-retries',
      taskIds: ['T-1'],
    });
    expect(res!.items.filter((i) => i.type === 'manager.note').map((i) => i.text)).toEqual([
      'holding B until A merges',
      'A first: B depends on it',
    ]);
    expect(res!.live).toEqual([
      expect.objectContaining({
        type: 'task.in_progress',
        boxId: 'box1',
        task: { id: 'T-1', title: 'A' },
        filesChanged: 3,
      }),
    ]);
    expect(res!.summary).toMatchObject({ merged: 0, tasksDone: 0, awaiting: 0 });
  });

  it('syncs PRs from GitHub once, however often it runs', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    h.boxes.push({
      id: 'box1',
      name: 'checkout-copy',
      branches: ['agentbox/checkout-copy'],
      state: 'running',
      projectRoot: root,
      projectId: 'p1',
    });
    const prs = [
      {
        number: 405,
        title: 'Retry failed charges',
        url: 'https://github.com/o/r/pull/405',
        headRefName: 'agentbox/checkout-copy',
        baseRefName: 'main',
        state: 'MERGED',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        mergedAt: new Date(Date.now() - 60_000).toISOString(),
        additions: 196,
        deletions: 52,
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        mergeStateStatus: 'UNKNOWN',
        autoMergeRequest: { enabledAt: 'x' },
        mergedBy: { login: 'me' },
        author: { login: 'someone' },
      },
      {
        number: 409,
        title: 'Checkout copy',
        url: 'https://github.com/o/r/pull/409',
        headRefName: 'feature/by-me',
        baseRefName: 'main',
        state: 'OPEN',
        createdAt: new Date(Date.now() - 600_000).toISOString(),
        additions: 84,
        deletions: 31,
        statusCheckRollup: [{ state: 'SUCCESS' }],
        mergeStateStatus: 'CLEAN',
        author: { login: 'me' },
      },
      {
        number: 410,
        title: 'Someone else, unknown branch',
        url: 'https://github.com/o/r/pull/410',
        headRefName: 'other',
        baseRefName: 'main',
        state: 'OPEN',
        author: { login: 'stranger' },
      },
    ];
    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api') return { exitCode: 0, stdout: 'me\n', stderr: '' };
      if (args[0] === 'repo') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r' }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: JSON.stringify(prs), stderr: '' };
    });
    const sync = createGithubPrSync(h.deps);
    const ws = (await readWorkspace(added.workspace.id))!;
    expect(await sync.syncNow(ws)).toBe('ok');
    expect(await sync.syncNow(ws)).toBe('ok');
    const events = await readTimeline(ws.id);
    expect(events.filter((e) => e.type === 'pr.merged')).toHaveLength(1);
    expect(events.find((e) => e.type === 'pr.merged')).toMatchObject({
      actor: 'github',
      boxId: 'box1',
      boxName: 'checkout-copy',
      pr: { number: 405, additions: 196, deletions: 52, autoMerge: true, mergedBy: 'me' },
    });
    expect(events.find((e) => e.type === 'pr.ready')?.pr?.number).toBe(409);
    expect(events.some((e) => e.pr?.number === 410)).toBe(false);

    const timeline = createTimelineBackend(h.deps, { sync });
    const res = await timeline.getTimeline(ws.id);
    expect(res!.live.find((l) => l.type === 'pr.ready')).toMatchObject({
      pr: expect.objectContaining({ number: 409 }),
      awaiting: true,
    });
  });

  it('reports GitHub unavailable when gh is not logged in', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const sync = createGithubPrSync(h.deps);
    expect(await sync.syncNow((await readWorkspace(added.workspace.id))!)).toBe('unavailable');
  });
});

describe('sendManagerMessage', () => {
  it('types into a running hub-run manager and logs the message with its PR', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const started = await managers.startManager(added.workspace.id, { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const res = await managers.sendManagerMessage(started.manager.id, {
      text: 'Approved: merge PR #409',
      prNumber: 409,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.delivered).toBe('session');
    const session = `=agentbox-manager-${started.manager.id}:`;
    expect(h.spawned).toContainEqual(['send-keys', '-t', session, '-l', 'Approved: merge PR #409']);
    expect(h.spawned).toContainEqual(['send-keys', '-t', session, 'Enter']);
    expect(res.event).toMatchObject({
      type: 'manager.message',
      actor: 'human',
      pr: { number: 409 },
    });
  });

  it('refuses an external manager with no pane as unreachable, and types into one with a pane', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await folder();
    h.alive.add(7);
    const bare = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 7,
      host: 'laptop',
    });
    if (!bare.ok) throw new Error(bare.error);
    const refused = await managers.sendManagerMessage(bare.manager.id, { text: 'hello' });
    expect(refused).toMatchObject({ ok: false, code: 'manager_unreachable' });

    const paned = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 7,
      host: 'laptop',
      tmuxPane: '%5',
    });
    if (!paned.ok) throw new Error(paned.error);
    const sent = await managers.sendManagerMessage(paned.manager.id, { text: 'hello' });
    expect(sent).toMatchObject({ ok: true, delivered: 'pane' });
    expect(h.spawned).toContainEqual(['send-keys', '-t', '%5', '-l', 'hello']);
  });

  it('resumes a stopped manager with the message as its prompt', async () => {
    const h = harness();
    const { managers } = backends(h);
    const root = await folder();
    const detected = await managers.detectManager({
      agent: 'claude',
      sessionId: S1,
      cwd: root,
      pid: 8,
      host: 'laptop',
    });
    if (!detected.ok) throw new Error(detected.error);
    const res = await managers.sendManagerMessage(detected.manager.id, { text: 'keep going' });
    expect(res).toMatchObject({ ok: true, delivered: 'resumed' });
    const start = h.spawned.find((a) => a[0] === 'new-session');
    expect(start?.at(-1)).toContain(`'--resume' '${S1}' 'keep going'`);
  });
});
