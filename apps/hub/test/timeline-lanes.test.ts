import { describe, expect, it } from 'vitest';
import type { TimelineBoxFact } from '../lib/backend/deps';
import { assignLanes } from '../lib/backend/timeline-lanes';
import type { TimelineItem, TimelineLiveItem } from '../lib/boxes/backend-types';

let seq = 0;
function ev(over: Partial<TimelineItem> & Pick<TimelineItem, 'type'>): TimelineItem {
  seq += 1;
  return {
    id: `id${String(seq).padStart(4, '0')}`,
    at: new Date(Date.UTC(2026, 8, 13, 10, 0, seq)).toISOString(),
    actor: 'hub',
    ...over,
  };
}

const pr = (number: number, head: string, base = 'main') => ({
  repo: 'o/r',
  number,
  title: `PR ${String(number)}`,
  url: `https://github.com/o/r/pull/${String(number)}`,
  base,
  head,
});

function fact(id: string, state?: string): TimelineBoxFact {
  return {
    id,
    name: id,
    branches: [],
    ...(state ? { state } : {}),
    projectRoot: '/p',
    projectId: 'p1',
  };
}

/** Assigns over events given oldest first, in the newest-first order the API reads them. */
function lanes(
  events: TimelineItem[],
  live: TimelineLiveItem[] = [],
  boxes: TimelineBoxFact[] = [],
): void {
  assignLanes([...events].reverse(), live, boxes);
}

/** A box `box.created` at queue time (no id) and its job's `box.ready`. */
function boxCreate(boxId: string, job: string, base?: string): [TimelineItem, TimelineItem] {
  return [
    ev({
      type: 'box.created',
      key: `job:${job}:created`,
      boxName: boxId,
      branch: `agentbox/${boxId}`,
      ...(base ? { base } : {}),
    }),
    ev({ type: 'box.ready', key: `job:${job}:ready`, boxId, branch: `agentbox/${boxId}` }),
  ];
}

describe('assignLanes', () => {
  it('forks a box off the trunk, and joins its job-keyed create to the box lane', () => {
    const [created, ready] = boxCreate('a', 'j1', 'main');
    lanes([created, ready]);
    expect(created.lane).toEqual({
      id: 'box:a',
      kind: 'box',
      from: 'trunk',
      branch: 'agentbox/a',
    });
    expect(ready.lane).toEqual({ id: 'box:a', kind: 'box' });
  });

  it("forks a box off another box's branch", () => {
    const a = boxCreate('a', 'j1', 'main');
    const b = boxCreate('b', 'j2', 'agentbox/a');
    lanes([...a, ...b]);
    expect(b[0].lane).toMatchObject({ id: 'box:b', from: 'box:a', branch: 'agentbox/b' });
  });

  it('forks off the trunk when nothing records a base', () => {
    const created = ev({ type: 'box.ready', boxId: 'old', branch: 'agentbox/old' });
    lanes([created]);
    expect(created.lane).toMatchObject({ id: 'box:old', from: 'trunk' });
  });

  it('merges into the trunk, finding the lane by branch when the merge names no box', () => {
    const a = boxCreate('a', 'j1', 'main');
    const push = ev({ type: 'git.push', boxId: 'a', branch: 'agentbox/a' });
    const opened = ev({ type: 'pr.opened', boxId: 'a', pr: pr(1, 'agentbox/a') });
    const merged = ev({ type: 'pr.merged', actor: 'github', pr: pr(1, 'agentbox/a') });
    lanes([...a, push, opened, merged]);
    expect(push.lane).toEqual({ id: 'box:a', kind: 'box' });
    expect(merged.lane).toEqual({ id: 'box:a', kind: 'box', into: 'trunk' });
  });

  it("merges into another box's lane when the PR's base is that box's branch", () => {
    const a = boxCreate('a', 'j1', 'main');
    const b = boxCreate('b', 'j2', 'agentbox/a');
    const merged = ev({ type: 'pr.merged', boxId: 'b', pr: pr(2, 'agentbox/b', 'agentbox/a') });
    lanes([...a, ...b, merged]);
    expect(merged.lane).toMatchObject({ id: 'box:b', into: 'box:a' });
  });

  it('prefers the box a PR names over the lane that carried its branch', () => {
    const a = boxCreate('a', 'j1', 'main');
    const b = boxCreate('b', 'j2', 'main');
    const opened = ev({ type: 'pr.opened', boxId: 'b', pr: pr(3, 'agentbox/a') });
    lanes([...a, ...b, opened]);
    expect(opened.lane?.id).toBe('box:b');
  });

  it('continues a running box after its merge, labelled with its new branch', () => {
    const a = boxCreate('a', 'j1', 'main');
    const merged = ev({ type: 'pr.merged', boxId: 'a', pr: pr(1, 'agentbox/a') });
    const again = ev({ type: 'git.push', boxId: 'a', branch: 'feat/a-2' });
    const sameBranch = ev({ type: 'git.push', boxId: 'a', branch: 'feat/a-2' });
    lanes([...a, merged, again, sameBranch], [], [fact('a', 'running')]);
    expect(merged.lane).toEqual({ id: 'box:a', kind: 'box', into: 'trunk' });
    expect(again.lane).toEqual({ id: 'box:a', kind: 'box', branch: 'feat/a-2' });
    expect(sameBranch.lane).toEqual({ id: 'box:a', kind: 'box', open: true });
  });

  it('labels a box.branch switch', () => {
    const a = boxCreate('a', 'j1', 'main');
    const moved = ev({ type: 'box.branch', boxId: 'a', branch: 'feat/x', base: 'agentbox/a' });
    lanes([...a, moved]);
    expect(moved.lane).toEqual({ id: 'box:a', kind: 'box', branch: 'feat/x' });
  });

  it("keeps the trunk's branch on the trunk after a box checks it out", () => {
    const a = boxCreate('a', 'j1', 'main');
    const onMain = ev({ type: 'box.branch', boxId: 'a', branch: 'main', base: 'agentbox/a' });
    const b = boxCreate('b', 'j2', 'main');
    const merged = ev({ type: 'pr.merged', boxId: 'b', pr: pr(4, 'agentbox/b') });
    lanes([...a, onMain, ...b, merged]);
    expect(b[0].lane?.from).toBe('trunk');
    expect(merged.lane?.into).toBe('trunk');
  });

  it('gives a box-less host PR a branch lane', () => {
    const opened = ev({ type: 'pr.opened', actor: 'github', pr: pr(7, 'chore/stripe-node-17') });
    const merged = ev({ type: 'pr.merged', actor: 'github', pr: pr(7, 'chore/stripe-node-17') });
    lanes([opened, merged]);
    expect(opened.lane).toEqual({
      id: 'branch:chore/stripe-node-17',
      kind: 'branch',
      from: 'trunk',
      branch: 'chore/stripe-node-17',
    });
    expect(merged.lane).toEqual({
      id: 'branch:chore/stripe-node-17',
      kind: 'branch',
      into: 'trunk',
    });
  });

  it('puts workspace events, plans and a create whose job has not finished on the trunk', () => {
    const rows = [
      ev({ type: 'manager.joined', managerId: 'm' }),
      ev({ type: 'plan', managerId: 'm', turn: 1, count: 3, taskIds: ['T-1', 'T-2', 'T-3'] }),
      ev({ type: 'task.created', task: { id: 'T-4', title: 'x' } }),
      ev({ type: 'manager.note', text: 'n' }),
      ev({ type: 'manager.message', text: 'ok', pr: pr(1, '') }),
      ev({ type: 'box.created', key: 'job:pending:created', boxName: 'p', branch: 'agentbox/p' }),
    ];
    lanes(rows);
    for (const row of rows) expect(row.lane).toEqual({ id: 'trunk', kind: 'trunk' });
  });

  it('marks the newest row of a running box open, and never a destroyed one', () => {
    const run = boxCreate('run', 'j1', 'main');
    const gone = boxCreate('gone', 'j2', 'main');
    const destroyed = ev({ type: 'box.destroyed', boxId: 'gone' });
    lanes([...run, ...gone, destroyed], [], [fact('run', 'running'), fact('gone', 'running')]);
    expect(run[1].lane?.open).toBe(true);
    expect(run[0].lane?.open).toBeUndefined();
    expect(destroyed.lane?.open).toBeUndefined();
  });

  it('ends a stopped box at its merge, and keeps a stopped box with unmerged work open', () => {
    const done = boxCreate('done', 'j1', 'main');
    const merged = ev({ type: 'pr.merged', boxId: 'done', pr: pr(1, 'agentbox/done') });
    const stopped = ev({ type: 'box.stopped', boxId: 'done' });
    const parked = boxCreate('parked', 'j2', 'main');
    const parkedStop = ev({ type: 'box.stopped', boxId: 'parked' });
    lanes(
      [...done, merged, stopped, ...parked, parkedStop],
      [],
      [fact('done', 'stopped'), fact('parked', 'stopped')],
    );
    expect(stopped.lane?.open).toBeUndefined();
    expect(parkedStop.lane?.open).toBe(true);
  });

  it('gives live rows their lane, open, and opens the lane behind them', () => {
    const a = boxCreate('a', 'j1', 'main');
    const opened = ev({ type: 'pr.opened', actor: 'github', pr: pr(8, 'feat/host') });
    const working: TimelineLiveItem = {
      id: 'live:task:a',
      type: 'task.in_progress',
      at: '2026-09-13T12:00:00.000Z',
      boxId: 'a',
      branch: 'agentbox/a',
    };
    const ready: TimelineLiveItem = {
      id: 'live:pr:o/r#8',
      type: 'pr.ready',
      at: '2026-09-13T12:00:00.000Z',
      pr: pr(8, 'feat/host'),
    };
    lanes([...a, opened], [working, ready], [fact('a', 'stopped')]);
    expect(working.lane).toEqual({ id: 'box:a', kind: 'box', open: true });
    expect(ready.lane).toEqual({ id: 'branch:feat/host', kind: 'branch', open: true });
    expect(a[1].lane?.open).toBe(true);
    expect(opened.lane?.open).toBe(true);
  });

  it('forks a lane seen only on a live row', () => {
    const working: TimelineLiveItem = {
      id: 'live:task:new',
      type: 'task.in_progress',
      at: '2026-09-13T12:00:00.000Z',
      boxId: 'new',
      branch: 'agentbox/new',
    };
    lanes([], [working]);
    expect(working.lane).toEqual({
      id: 'box:new',
      kind: 'box',
      from: 'trunk',
      branch: 'agentbox/new',
      open: true,
    });
  });
});
