// The timeline domain: a workspace's append-only event log (`timeline.jsonl`,
// written by every mutation point), aggregated for reading, plus the rows that
// are only ever true NOW — a box working a task, a PR waiting to be merged —
// which are built at read time and never stored.
import {
  findWorkspaceContaining,
  listWorkspaces,
  readReconciledTasks,
  readTasks,
  readTimeline,
  readWorkspace,
  recordTimelineEvent,
  sortTasksByOrder,
  stampFields,
  workspaceForPath,
  type TimelineEvent,
  type TimelineEventInput,
  type TimelineStamp,
  type WorkTask,
} from '@agentbox/relay';
import { reconcileContext, type BackendDeps, type DiffStat, type TimelineBoxFact } from './deps';
import { createGithubPrSync, type GithubPrSync } from './github-prs';
import type {
  HubBackend,
  TimelineBackend,
  TimelineItem,
  TimelineLiveItem,
  TimelineMeta,
  TimelineQuery,
  TimelineResponse,
  TimelineSummary,
} from '../boxes/backend-types';

/** A manager's task creates within this window, from one turn, read as one plan. */
export const PLAN_WINDOW_MS = 10 * 60 * 1000;
export const PLAN_MIN_TASKS = 3;
/** A move to `in_progress` this soon after an assignment is that assignment, not news. */
const ASSIGN_STATUS_WINDOW_MS = 60 * 1000;
const DIFF_CACHE_MS = 60 * 1000;
export const TIMELINE_DEFAULT_LIMIT = 100;

function newestFirst(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function taskIdsOf(ev: TimelineEvent): string[] {
  if (ev.taskIds?.length) return ev.taskIds;
  return ev.task ? [ev.task.id] : [];
}

function samePr(a: TimelineEvent['pr'], b: TimelineEvent['pr']): boolean {
  if (!a || !b || a.number !== b.number) return false;
  return !a.repo || !b.repo || a.repo === b.repo;
}

/**
 * Events as a reader wants them, newest first:
 * - 3+ `task.created` from one manager turn within 10 minutes become one `plan`;
 * - a `task.status → in_progress` right after that task's assignment is dropped;
 * - a `pr.merged` preceded by a message about that PR is `approvedByYou`.
 */
export function aggregateTimeline(events: TimelineEvent[]): TimelineItem[] {
  const asc = [...events].sort(newestFirst).reverse();
  const drop = new Set<string>();

  const groups: TimelineEvent[][] = [];
  const openGroup = new Map<string, TimelineEvent[]>();
  for (const ev of asc) {
    if (ev.type !== 'task.created' || !ev.managerId || ev.turn === undefined) continue;
    const key = `${ev.managerId}|${String(ev.turn)}`;
    const group = openGroup.get(key);
    if (group && Date.parse(ev.at) - Date.parse(group[0]!.at) <= PLAN_WINDOW_MS) {
      group.push(ev);
    } else {
      const fresh = [ev];
      openGroup.set(key, fresh);
      groups.push(fresh);
    }
  }
  const plans: TimelineItem[] = [];
  for (const group of groups) {
    if (group.length < PLAN_MIN_TASKS) continue;
    for (const ev of group) drop.add(ev.id);
    const first = group[0]!;
    const prompt = group.find((ev) => ev.prompt)?.prompt;
    const projects = new Set(group.map((ev) => ev.projectId));
    plans.push({
      id: first.id,
      at: first.at,
      type: 'plan',
      actor: first.actor,
      managerId: first.managerId!,
      turn: first.turn!,
      ...(prompt ? { prompt } : {}),
      ...(projects.size === 1 && first.projectId ? { projectId: first.projectId } : {}),
      taskIds: group.flatMap(taskIdsOf),
      count: group.length,
    });
  }

  const assignedAt = new Map<string, number>();
  for (const ev of asc) {
    if (ev.type === 'task.assigned') {
      for (const id of taskIdsOf(ev)) assignedAt.set(id, Date.parse(ev.at));
    } else if (ev.type === 'task.status' && ev.task?.to === 'in_progress') {
      const at = assignedAt.get(ev.task.id);
      if (at !== undefined && Date.parse(ev.at) - at <= ASSIGN_STATUS_WINDOW_MS) drop.add(ev.id);
    }
  }

  const messages = asc.filter((ev) => ev.type === 'manager.message' && ev.pr);
  const items: TimelineItem[] = [];
  for (const ev of asc) {
    if (drop.has(ev.id)) continue;
    if (ev.type === 'pr.merged' && messages.some((m) => samePr(m.pr, ev.pr) && m.at <= ev.at)) {
      items.push({ ...ev, approvedByYou: true });
    } else {
      items.push(ev);
    }
  }
  return [...items, ...plans].sort(newestFirst);
}

/** Ready PRs not merged or closed since, newest first, with whether a message approved them. */
export function liveReadyItems(
  events: TimelineEvent[],
  prState?: (repo: string, number: number) => string | undefined,
): TimelineLiveItem[] {
  const sorted = [...events].sort(newestFirst);
  const finished = new Set<string>();
  for (const ev of sorted) {
    if ((ev.type === 'pr.merged' || ev.type === 'pr.closed') && ev.pr) {
      finished.add(`${ev.pr.repo}#${String(ev.pr.number)}`);
    }
  }
  const seen = new Set<string>();
  const out: TimelineLiveItem[] = [];
  for (const ev of sorted) {
    if (ev.type !== 'pr.ready' || !ev.pr) continue;
    const key = `${ev.pr.repo}#${String(ev.pr.number)}`;
    if (finished.has(key) || seen.has(key)) continue;
    seen.add(key);
    // A PR that went red (or conflicted) after the log recorded it ready is no
    // longer awaiting anyone; the log cannot un-append, the last sync can say so.
    const state = prState?.(ev.pr.repo, ev.pr.number);
    if (state && state !== 'ready') continue;
    const approved = sorted.some((m) => m.type === 'manager.message' && samePr(m.pr, ev.pr));
    out.push({
      id: `live:pr:${key}`,
      type: 'pr.ready',
      at: ev.at,
      pr: ev.pr,
      ...(ev.boxId ? { boxId: ev.boxId } : {}),
      ...(ev.boxName ? { boxName: ev.boxName } : {}),
      ...(ev.branch ? { branch: ev.branch } : {}),
      ...(ev.managerId ? { managerId: ev.managerId } : {}),
      ...(ev.taskIds?.length ? { taskIds: ev.taskIds } : {}),
      awaiting: true,
      ...(approved ? { approved: true } : {}),
    });
  }
  return out;
}

export function buildTimelineSummary(
  events: TimelineEvent[],
  since: string,
  live: TimelineLiveItem[],
  pendingApprovals: number,
): TimelineSummary {
  let merged = 0;
  let additions = 0;
  let deletions = 0;
  let tasksDone = 0;
  for (const ev of events) {
    if (ev.at < since) continue;
    if (ev.type === 'pr.merged') {
      merged += 1;
      additions += ev.pr?.additions ?? 0;
      deletions += ev.pr?.deletions ?? 0;
    } else if (ev.type === 'task.status' && ev.task?.to === 'done') {
      tasksDone += 1;
    }
  }
  const awaitingPrs = live.filter((l) => l.type === 'pr.ready' && !l.approved).length;
  return {
    since,
    merged,
    additions,
    deletions,
    tasksDone,
    awaiting: awaitingPrs + pendingApprovals,
  };
}

/** `N files changed, A insertions(+), D deletions(-)`, any part optional. */
export function parseShortstat(out: string): DiffStat {
  const num = (re: RegExp): number => Number(re.exec(out)?.[1] ?? 0);
  return {
    filesChanged: num(/(\d+) files? changed/u),
    additions: num(/(\d+) insertions?\(\+\)/u),
    deletions: num(/(\d+) deletions?\(-\)/u),
  };
}

export interface TimelineBackendOptions {
  sync?: GithubPrSync;
  now?: () => number;
}

export function createTimelineBackend(
  deps: BackendDeps,
  opts: TimelineBackendOptions = {},
): TimelineBackend {
  const sync = opts.sync ?? createGithubPrSync(deps);
  const now = opts.now ?? Date.now;
  const diffCache = new Map<string, { at: number; value: DiffStat | null }>();

  async function diffOf(box: TimelineBoxFact): Promise<DiffStat | null> {
    if (!deps.boxDiffStat || box.state !== 'running') return null;
    const hit = diffCache.get(box.id);
    if (hit && now() - hit.at < DIFF_CACHE_MS) return hit.value;
    const value = await deps.boxDiffStat(box.id).catch(() => null);
    diffCache.set(box.id, { at: now(), value });
    return value;
  }

  async function liveBoxItems(
    boxes: TimelineBoxFact[],
    tasks: WorkTask[],
    events: TimelineEvent[],
  ): Promise<TimelineLiveItem[]> {
    const out: TimelineLiveItem[] = [];
    for (const box of boxes) {
      const mine = sortTasksByOrder(tasks.filter((t) => t.boxId === box.id));
      const current = mine.find((t) => t.status === 'in_progress');
      if (!current) continue;
      const diff = await diffOf(box);
      const since = events.find(
        (ev) =>
          (ev.type === 'task.assigned' && taskIdsOf(ev).includes(current.id)) ||
          (ev.type === 'box.created' && ev.boxId === box.id),
      );
      out.push({
        id: `live:task:${box.id}`,
        type: 'task.in_progress',
        at: since?.at ?? current.updatedAt,
        boxId: box.id,
        boxName: box.name,
        ...(box.agent ? { agent: box.agent } : {}),
        ...(box.branches[0] ? { branch: box.branches[0] } : {}),
        ...(current.managerId ? { managerId: current.managerId } : {}),
        task: { id: current.id, title: current.title },
        taskIds: mine.filter((t) => t.status !== 'done').map((t) => t.id),
        ...(diff ? diff : {}),
      });
    }
    return out;
  }

  return {
    async getTimeline(wsId: string, q: TimelineQuery = {}): Promise<TimelineResponse | null> {
      const ws = await readWorkspace(wsId);
      if (!ws) return null;
      const github = sync.kick(ws);
      const [events, workspaces, facts, ctx] = await Promise.all([
        readTimeline(wsId),
        listWorkspaces(),
        deps.boxFacts ? deps.boxFacts().catch(() => []) : Promise.resolve([]),
        reconcileContext(deps),
      ]);
      const tasks = await readReconciledTasks(wsId, ctx);
      const boxes = facts.filter(
        (b) => findWorkspaceContaining(workspaces, b.projectRoot)?.id === wsId,
      );
      let items = aggregateTimeline(events);
      if (q.before) items = items.filter((i) => i.at < q.before!);
      items = items.slice(0, q.limit ?? TIMELINE_DEFAULT_LIMIT);
      const live = [
        ...(await liveBoxItems(boxes, tasks, events)),
        ...liveReadyItems(events, (repo, n) => sync.prState(repo, n)),
      ];
      const boxIds = new Set(boxes.map((b) => b.id));
      const pending = (deps.pendingApprovalBoxIds?.() ?? []).filter((id) => boxIds.has(id)).length;
      return {
        items,
        live,
        ...(q.since ? { summary: buildTimelineSummary(events, q.since, live, pending) } : {}),
        github,
      };
    },
  };
}

// ── box events, recorded around the hub's own box routes ──

/** The fields every box event carries, from what the hub knows about the box. */
async function boxEventBase(
  fact: TimelineBoxFact,
  wsId: string,
): Promise<Omit<TimelineEventInput, 'type' | 'actor'>> {
  // A plain read: reconciling here with only this box live would unassign every other box's tasks.
  const tasks = await readTasks(wsId).catch(() => []);
  const taskIds = tasks.filter((t) => t.boxId === fact.id).map((t) => t.id);
  return {
    boxId: fact.id,
    boxName: fact.name,
    ...(fact.agent ? { agent: fact.agent } : {}),
    ...(fact.branches[0] ? { branch: fact.branches[0] } : {}),
    projectId: fact.projectId,
    ...(taskIds.length ? { taskIds } : {}),
  };
}

export interface BoxTimelineSeams {
  deps: BackendDeps;
  /** A manager's stamp (turn + prompt), for a create that names its manager. */
  managerStamp(managerId: string): Promise<TimelineStamp | undefined>;
}

/**
 * Wrap the box routes that change what a workspace's timeline says: create,
 * start/stop/destroy, and the two pushes. Wrapped rather than threaded through
 * each method's many return paths; every record is best-effort and after the
 * operation answered, so it can never turn a success into a failure.
 */
export function withBoxTimeline(hub: HubBackend, seams: BoxTimelineSeams): HubBackend {
  const { deps } = seams;

  async function factOf(id: string): Promise<TimelineBoxFact | undefined> {
    if (!deps.boxFacts || id.startsWith('job:')) return undefined;
    return (await deps.boxFacts().catch(() => [])).find((b) => b.id === id);
  }

  async function recordAround<R extends { ok: boolean }>(
    id: string,
    type: TimelineEvent['type'],
    meta: TimelineMeta | undefined,
    op: () => Promise<R>,
  ): Promise<R> {
    // Read before the op: a destroyed box has no record left to name it by.
    const fact = await factOf(id).catch(() => undefined);
    const res = await op();
    if (!res.ok || !fact) return res;
    try {
      const ws = await workspaceForPath(fact.projectRoot);
      if (ws) {
        await recordTimelineEvent(ws.id, {
          type,
          ...stampFields(meta?.stamp),
          ...(await boxEventBase(fact, ws.id)),
        });
        deps.notify();
      }
    } catch {
      /* best-effort */
    }
    return res;
  }

  const create = hub.create.bind(hub);
  const start = hub.start.bind(hub);
  const stop = hub.stop.bind(hub);
  const destroy = hub.destroy.bind(hub);
  const gitPush = hub.gitPush.bind(hub);
  const gitPushHost = hub.gitPushHost.bind(hub);

  hub.create = async (input, meta) => {
    const res = await create(input, meta);
    if (!res.ok || !input.projectId) return res;
    try {
      const ws = (await listWorkspaces()).find((w) => w.projectIds.includes(input.projectId!));
      if (ws) {
        const stamp =
          meta?.stamp?.actor === 'manager'
            ? meta.stamp
            : input.managerId
              ? ((await seams.managerStamp(input.managerId).catch(() => undefined)) ?? meta?.stamp)
              : meta?.stamp;
        const name = input.name?.trim();
        const branch = input.opts?.useBranch ?? (name ? `agentbox/${name}` : undefined);
        await recordTimelineEvent(ws.id, {
          type: 'box.created',
          ...stampFields(stamp),
          ...(input.managerId && !stamp?.managerId ? { managerId: input.managerId } : {}),
          key: `job:${res.jobId}:created`,
          ...(name ? { boxName: name } : {}),
          ...(input.agent !== 'none' ? { agent: input.agent } : {}),
          ...(branch ? { branch } : {}),
          projectId: input.projectId,
        });
        deps.notify();
      }
    } catch {
      /* best-effort */
    }
    return res;
  };
  hub.start = (id, meta) => recordAround(id, 'box.started', meta, () => start(id, meta));
  hub.stop = (id, meta) => recordAround(id, 'box.stopped', meta, () => stop(id, meta));
  hub.destroy = (id, o, meta) =>
    recordAround(id, 'box.destroyed', meta, () => destroy(id, o, meta));
  hub.gitPush = (id, input, meta) =>
    recordAround(id, 'git.push', meta, () => gitPush(id, input, meta));
  hub.gitPushHost = (id, input, meta) =>
    recordAround(id, 'git.push', meta, () => gitPushHost(id, input, meta));
  return hub;
}
