import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import { backgroundSettled } from '../lib/backend/background';
import { createManagerBackend } from '../lib/backend/managers';
import { createWorkspaceBackend } from '../lib/backend/workspaces';
import { createGithubPrSync } from '../lib/backend/github-prs';
import {
  aggregateTimeline,
  branchUrlOf,
  buildTimelineSummary,
  createTimelineBackend,
  liveReadyItems,
  parseShortstat,
  repoUrlOfPrUrl,
  stampInWorkspace,
  withBoxTimeline,
  type RepoWebLookup,
} from '../lib/backend/timeline';
import type { BackendDeps, TimelineBoxFact } from '../lib/backend/deps';
import type { HubBackend } from '../lib/boxes/backend-types';
import { hashProjectPath } from '@agentbox/config';
import {
  readTimeline,
  readWorkspace,
  recordTimelineEvent,
  resolveWorkspaceDir,
  timelineFile,
  type TimelineEvent,
} from '@agentbox/relay';

const S1 = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const S2 = '6fdc0ee0-ce9a-4e30-962d-bc630388d8bc';
const S3 = '7fdc0ee0-ce9a-4e30-962d-bc630388d8bc';
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

  it('matches a message by repo and number, and a repo-less one only when the number is unambiguous', () => {
    const other = pr(409, { repo: 'o/other', url: 'https://github.com/o/other/pull/409' });
    const merged = ev({ type: 'pr.merged', actor: 'github', pr: pr(409) });
    const wrongRepo = ev({ type: 'manager.message', actor: 'human', pr: other });
    expect(
      aggregateTimeline([wrongRepo, merged]).find((i) => i.type === 'pr.merged')?.approvedByYou,
    ).toBeUndefined();

    const bare = ev({ type: 'manager.message', actor: 'human', pr: pr(409, { repo: '' }) });
    const single = aggregateTimeline([
      bare,
      ev({ type: 'pr.merged', actor: 'github', pr: pr(409) }),
    ]);
    expect(single.find((i) => i.type === 'pr.merged')?.approvedByYou).toBe(true);

    const ambiguous = aggregateTimeline([
      ev({ type: 'pr.ready', actor: 'github', pr: other }),
      bare,
      ev({ type: 'pr.merged', actor: 'github', pr: pr(409) }),
    ]);
    expect(ambiguous.find((i) => i.type === 'pr.merged')?.approvedByYou).toBeUndefined();
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
    // No sync since the hub started: only a PR the sync already confirmed is live.
    expect(liveReadyItems([ready409], () => undefined, false)).toEqual([]);
    expect(liveReadyItems([ready409], () => 'ready', false)).toHaveLength(1);
    const summary = buildTimelineSummary(
      [ready409],
      '2000-01-01T00:00:00.000Z',
      liveReadyItems([ready409], () => undefined, false),
      0,
    );
    expect(summary.awaiting).toBe(0);
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
    boxFact: async (id) => boxes.find((b) => b.id === id),
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
    await backgroundSettled();
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
    expect(h.spawned).toContainEqual([
      'send-keys',
      '-t',
      session,
      '-l',
      '--',
      'Approved: merge PR #409',
    ]);
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
    expect(h.spawned).toContainEqual(['send-keys', '-t', '%5', '-l', '--', 'hello']);
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

describe('diffs on the live rows', () => {
  it('leaves the diff off a row whose exec is slow, and shares one exec between reads', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    for (const id of ['box1', 'box2']) {
      h.boxes.push({
        id,
        name: id,
        branches: [`agentbox/${id}`],
        state: 'running',
        projectRoot: root,
        projectId: 'p1',
      });
    }
    for (const [title, boxId] of [
      ['A', 'box1'],
      ['B', 'box2'],
    ] as const) {
      const t = await workspaces.addTask(wsId, { title });
      if (!t.ok) throw new Error(t.error);
      const a = await workspaces.assignTasks(wsId, [t.task.id], { boxId });
      if (!a.ok) throw new Error(a.error);
    }
    await backgroundSettled();
    let release: (v: {
      filesChanged: number;
      additions: number;
      deletions: number;
    }) => void = () => {};
    const slow = new Promise<{ filesChanged: number; additions: number; deletions: number }>(
      (resolve) => {
        release = resolve;
      },
    );
    const calls: string[] = [];
    h.deps.boxDiffStat = async (box) => {
      calls.push(box.id);
      return box.id === 'box1' ? slow : { filesChanged: 1, additions: 2, deletions: 3 };
    };
    const timeline = createTimelineBackend(h.deps, { diffTimeoutMs: 30 });
    const [first, second] = await Promise.all([
      timeline.getTimeline(wsId),
      timeline.getTimeline(wsId),
    ]);
    for (const res of [first, second]) {
      const rows = res!.live.filter((l) => l.type === 'task.in_progress');
      expect(rows.find((l) => l.boxId === 'box1')?.filesChanged).toBeUndefined();
      expect(rows.find((l) => l.boxId === 'box2')?.filesChanged).toBe(1);
    }
    expect(calls.sort()).toEqual(['box1', 'box2']);
    release({ filesChanged: 9, additions: 9, deletions: 9 });
    const later = await timeline.getTimeline(wsId);
    expect(later!.live.find((l) => l.boxId === 'box1')?.filesChanged).toBe(9);
    expect(calls).toHaveLength(2);
  });
});

describe('stamps from routes that do not name a workspace', () => {
  function fakeHub(): HubBackend {
    const okResult = async () => ({ ok: true as const });
    return {
      create: async () => ({ ok: true as const, jobId: 'job1' }),
      start: okResult,
      stop: okResult,
      destroy: okResult,
      gitPush: okResult,
      gitPushHost: okResult,
    } as unknown as HubBackend;
  }

  it("never writes another workspace's manager into a log, and a create keeps its named manager", async () => {
    const h = harness();
    const { managers } = backends(h);
    const root1 = await folder();
    const root2 = await folder();
    const detect = async (sessionId: string, cwd: string) => {
      const d = await managers.detectManager({ agent: 'claude', sessionId, cwd, host: 'laptop' });
      if (!d.ok) throw new Error(d.error);
      return d;
    };
    const a = await detect(S1, root1);
    const c = await detect(S3, root1);
    const b = await detect(S2, root2);
    expect(a.workspace.id).not.toBe(b.workspace.id);
    const ws1 = a.workspace.id;

    const foreign = await stampInWorkspace(
      { session: { agent: 'claude', sessionId: S2 } },
      ws1,
      managers.timelineStamp,
    );
    expect(foreign).toEqual({ actor: 'human' });
    expect(
      await stampInWorkspace(
        { stamp: { actor: 'manager', managerId: b.manager.id } },
        ws1,
        managers.timelineStamp,
      ),
    ).toEqual({ actor: 'human' });

    h.boxes.push({
      id: 'box1',
      name: 'box-one',
      branches: ['agentbox/box-one'],
      state: 'running',
      projectRoot: root1,
      projectId: 'p1',
    });
    const hub = withBoxTimeline(fakeHub(), { deps: h.deps, stampFor: managers.timelineStamp });
    await hub.start('box1', { session: { agent: 'claude', sessionId: S2 } });
    await hub.stop('box1', { session: { agent: 'claude', sessionId: S1 } });
    const projectId = (await readWorkspace(ws1))!.projectIds[0]!;
    await hub.create(
      { projectId, managerId: c.manager.id, agent: 'claude', name: 'made' } as Parameters<
        HubBackend['create']
      >[0],
      { session: { agent: 'claude', sessionId: S1 } },
    );
    await backgroundSettled();

    const events = await readTimeline(ws1);
    const started = events.find((e) => e.type === 'box.started');
    expect(started).toMatchObject({ actor: 'human', boxName: 'box-one' });
    expect(started?.managerId).toBeUndefined();
    expect(started?.turn).toBeUndefined();
    expect(events.find((e) => e.type === 'box.stopped')).toMatchObject({
      actor: 'manager',
      managerId: a.manager.id,
      turn: 41,
    });
    expect(events.find((e) => e.type === 'box.created')).toMatchObject({
      actor: 'manager',
      managerId: c.manager.id,
    });
    expect((await readTimeline(b.workspace.id)).some((e) => e.type.startsWith('box.'))).toBe(false);
  });
});

describe('a message about a PR in a workspace over several repos', () => {
  it('ties the message to the repo it names, and to none when the number alone is ambiguous', async () => {
    const h = harness();
    const { workspaces, managers } = backends(h);
    const added = await workspaces.addWorkspace({ path: await folder() });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    const { recordTimelineEvent } = await import('@agentbox/relay');
    await recordTimelineEvent(wsId, { type: 'pr.ready', actor: 'github', pr: pr(12) });
    await recordTimelineEvent(wsId, {
      type: 'pr.ready',
      actor: 'github',
      pr: pr(12, { repo: 'o/web', url: 'https://github.com/o/web/pull/12' }),
    });
    const started = await managers.startManager(wsId, { agent: 'claude' });
    if (!started.ok) throw new Error(started.error);
    const named = await managers.sendManagerMessage(started.manager.id, {
      text: 'merge it',
      prNumber: 12,
      repo: 'o/web',
    });
    if (!named.ok) throw new Error(named.error);
    expect(named.event?.pr).toMatchObject({ repo: 'o/web', number: 12, title: 'PR 12' });
    const bare = await managers.sendManagerMessage(started.manager.id, {
      text: 'merge 12',
      prNumber: 12,
    });
    if (!bare.ok) throw new Error(bare.error);
    expect(bare.event?.pr).toMatchObject({ repo: '', number: 12 });
    const live = liveReadyItems(await readTimeline(wsId));
    expect(live.find((l) => l.pr?.repo === 'o/web')?.approved).toBe(true);
    expect(live.find((l) => l.pr?.repo === 'o/r')?.approved).toBeUndefined();
  });
});

describe('branch links', () => {
  const none: RepoWebLookup = {
    repo: () => undefined,
    project: () => undefined,
    box: () => undefined,
  };
  const lookup: RepoWebLookup = {
    repo: (r) =>
      r === 'acme/storefront-web' ? 'https://github.com/acme/storefront-web' : undefined,
    project: (id) => (id === 'p1' ? 'https://ghe.acme.dev/acme/api' : undefined),
    box: (id) => (id === 'box1' ? 'https://github.com/acme/box-repo' : undefined),
  };

  it("takes a PR row's repo from its URL, on whatever host it names", () => {
    expect(repoUrlOfPrUrl('https://ghe.acme.dev/acme/api/pull/12')).toBe(
      'https://ghe.acme.dev/acme/api',
    );
    expect(repoUrlOfPrUrl('https://github.com/acme/api/issues/12')).toBeUndefined();
    const row = {
      pr: pr(409, {
        repo: 'acme/storefront-web',
        url: 'https://github.com/acme/storefront-web/pull/409',
        head: 'feat/checkout-copy',
      }),
      projectId: 'p1',
      boxId: 'box1',
    };
    expect(branchUrlOf(row, none)).toBe(
      'https://github.com/acme/storefront-web/tree/feat/checkout-copy',
    );
  });

  it('falls back to a repo the sync resolved, then the project, then the box', () => {
    const noUrl = pr(1, { repo: 'acme/storefront-web', url: '', head: 'feat/a' });
    expect(branchUrlOf({ pr: noUrl, projectId: 'p1' }, lookup)).toBe(
      'https://github.com/acme/storefront-web/tree/feat/a',
    );
    expect(branchUrlOf({ pr: { ...noUrl, repo: 'other/repo' }, projectId: 'p1' }, lookup)).toBe(
      'https://ghe.acme.dev/acme/api/tree/feat/a',
    );
    expect(branchUrlOf({ branch: 'agentbox/x', projectId: 'p1', boxId: 'box1' }, lookup)).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/x',
    );
    expect(branchUrlOf({ branch: 'agentbox/x', projectId: 'gone', boxId: 'box1' }, lookup)).toBe(
      'https://github.com/acme/box-repo/tree/agentbox/x',
    );
  });

  it('encodes each branch segment and keeps the slashes', () => {
    expect(branchUrlOf({ branch: 'feat/100% done#2/ü', boxId: 'box1' }, lookup)).toBe(
      'https://github.com/acme/box-repo/tree/feat/100%25%20done%232/%C3%BC',
    );
  });

  it('is absent with no branch, or no known repo', () => {
    expect(branchUrlOf({ projectId: 'p1', boxId: 'box1' }, lookup)).toBeUndefined();
    expect(
      branchUrlOf({ branch: 'feat/a', projectId: 'gone', boxId: 'gone' }, lookup),
    ).toBeUndefined();
    const message = { pr: { repo: '', number: 4, title: '', url: '', base: '', head: '' } };
    expect(branchUrlOf(message, lookup)).toBeUndefined();
    expect(
      branchUrlOf({ branch: 'feat/a', pr: pr(2, { url: '', repo: 'x/y' }) }, none),
    ).toBeUndefined();
  });

  it('adds branchUrl to items and live rows from the cache, and never stores it', async () => {
    const h = harness();
    const { workspaces } = backends(h);
    const root = await folder();
    const added = await workspaces.addWorkspace({ path: root });
    if (!added.ok) throw new Error(added.error);
    const wsId = added.workspace.id;
    h.boxes.push({
      id: 'box1',
      name: 'checkout-copy',
      branches: ['agentbox/checkout-copy'],
      state: 'running',
      projectRoot: root,
      projectId: hashProjectPath(root),
    });
    await recordTimelineEvent(wsId, {
      type: 'box.created',
      actor: 'human',
      boxName: 'fresh',
      branch: 'agentbox/fresh',
      projectId: hashProjectPath(root),
    });
    const task = await workspaces.addTask(wsId, { title: 'Copy' });
    if (!task.ok) throw new Error(task.error);
    const assigned = await workspaces.assignTasks(wsId, [task.task.id], { boxId: 'box1' });
    if (!assigned.ok) throw new Error(assigned.error);
    await backgroundSettled();

    const cold = createTimelineBackend(h.deps, { sync: createGithubPrSync(h.deps) });
    const before = await cold.getTimeline(wsId);
    expect(before!.items.some((i) => i.branchUrl)).toBe(false);
    expect(before!.live.some((l) => l.branchUrl)).toBe(false);

    h.gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api') return { exitCode: 0, stdout: 'me\n', stderr: '' };
      if (args[0] === 'repo') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            nameWithOwner: 'acme/api',
            url: 'https://ghe.acme.dev/acme/api',
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            title: 'Copy',
            url: 'https://ghe.acme.dev/acme/api/pull/7',
            headRefName: 'agentbox/checkout-copy',
            baseRefName: 'main',
            state: 'OPEN',
            author: { login: 'someone' },
          },
        ]),
        stderr: '',
      };
    });
    const sync = createGithubPrSync(h.deps);
    const ws = (await readWorkspace(wsId))!;
    expect(await sync.syncNow(ws)).toBe('ok');
    expect(sync.webUrlForRepo('acme/api')).toBe('https://ghe.acme.dev/acme/api');
    h.gh.mockClear();

    const res = await createTimelineBackend(h.deps, { sync }).getTimeline(wsId);
    expect(res!.items.find((i) => i.type === 'pr.opened')?.branchUrl).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/checkout-copy',
    );
    expect(res!.items.find((i) => i.type === 'box.created')?.branchUrl).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/fresh',
    );
    expect(res!.live.find((l) => l.type === 'task.in_progress')?.branchUrl).toBe(
      'https://ghe.acme.dev/acme/api/tree/agentbox/checkout-copy',
    );
    expect(h.gh.mock.calls.some(([args]) => args[0] === 'repo')).toBe(false);
    const raw = await readFile(timelineFile((await resolveWorkspaceDir(wsId))!), 'utf8');
    expect(raw).not.toContain('branchUrl');
  });
});
