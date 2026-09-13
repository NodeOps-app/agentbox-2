// GitHub pull requests into the workspace timeline. The in-box `gh` shim records
// the PRs a box opens or merges; this sync covers everything else — the manager
// merging from the host, a merge on github.com, auto-merge landing later — by
// polling `gh pr list` for the repos behind the workspace's projects. The dedupe
// keys are shared with the shim (`prTimelineEvents`), so both paths land once.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  appendTimelineEvent,
  findWorkspaceContaining,
  GH_PR_JSON_FIELDS,
  isPrReady,
  listWorkspaces,
  prTimelineEvents,
  readTasks,
  readTimeline,
  scanWorkspaceProjects,
  TIMELINE_RETENTION_MS,
  type GhPrJson,
  type TimelineEvent,
  type WorkspaceRecord,
} from '@agentbox/relay';
import type { BackendDeps, GhExec } from './deps';

/** `unavailable`: no `gh`, not logged in, or no GitHub repo behind the workspace. */
export type GithubSyncStatus = 'ok' | 'syncing' | 'unavailable';

export type PrLiveState = 'ready' | 'open' | 'merged' | 'closed';

export interface GithubPrSync {
  /** Start a sync when the last one is older than the interval; answers the current status. */
  kick(ws: WorkspaceRecord): GithubSyncStatus;
  /** Run one sync now and wait for it (tests, and a caller that needs it done). */
  syncNow(ws: WorkspaceRecord): Promise<GithubSyncStatus>;
  /** The state a PR had at the last sync, when this hub has seen it. */
  prState(repo: string, number: number): PrLiveState | undefined;
}

export const GITHUB_SYNC_INTERVAL_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;
const PR_LIST_LIMIT = 50;

const defaultGhExec: GhExec = async (args, opts) => {
  const r = await execa('gh', args, {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    reject: false,
    timeout: GH_TIMEOUT_MS,
  });
  return {
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
};

interface WorkspaceSyncState {
  lastAt: number;
  running: Promise<GithubSyncStatus> | null;
  status: GithubSyncStatus | null;
}

interface RepoRef {
  /** `owner/name`: the dedupe key's repo. */
  nameWithOwner: string;
  /** What `--repo` takes: `HOST/owner/name` off github.com. */
  arg: string;
}

export function createGithubPrSync(
  deps: BackendDeps,
  opts: { now?: () => number; intervalMs?: number } = {},
): GithubPrSync {
  const gh = deps.ghExec ?? defaultGhExec;
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? GITHUB_SYNC_INTERVAL_MS;
  const states = new Map<string, WorkspaceSyncState>();
  /** Keyed by project folder; `null` = not a GitHub repo, cached so it is not asked again. */
  const repoByRoot = new Map<string, RepoRef | null>();
  let ghUser: { login: string | null; at: number } | null = null;
  const prStates = new Map<string, PrLiveState>();

  async function currentUser(): Promise<string | null> {
    if (ghUser && (ghUser.login !== null || now() - ghUser.at < interval)) return ghUser.login;
    const r = await gh(['api', 'user', '--jq', '.login']).catch(() => null);
    const login = r && r.exitCode === 0 ? r.stdout.trim() || null : null;
    ghUser = { login, at: now() };
    return login;
  }

  async function repoOf(root: string): Promise<RepoRef | null> {
    if (repoByRoot.has(root)) return repoByRoot.get(root) ?? null;
    if (!(await stat(join(root, '.git')).catch(() => null))) {
      repoByRoot.set(root, null);
      return null;
    }
    const r = await gh(['repo', 'view', '--json', 'nameWithOwner,url'], { cwd: root }).catch(
      () => null,
    );
    let ref: RepoRef | null = null;
    if (r && r.exitCode === 0) {
      try {
        const parsed = JSON.parse(r.stdout) as { nameWithOwner?: string; url?: string };
        if (parsed.nameWithOwner) {
          const host = parsed.url ? new URL(parsed.url).host : 'github.com';
          ref = {
            nameWithOwner: parsed.nameWithOwner,
            arg: host === 'github.com' ? parsed.nameWithOwner : `${host}/${parsed.nameWithOwner}`,
          };
        }
      } catch {
        ref = null;
      }
    }
    // A failed lookup is cached only when gh answered: a timeout says nothing
    // about whether the folder is a GitHub repo.
    if (r) repoByRoot.set(root, ref);
    return ref;
  }

  async function sync(ws: WorkspaceRecord): Promise<GithubSyncStatus> {
    const user = await currentUser();
    if (user === null) return 'unavailable';
    const roots = await scanWorkspaceProjects(ws.root);
    const repos = new Map<string, RepoRef>();
    for (const root of roots) {
      const ref = await repoOf(root);
      if (ref) repos.set(ref.nameWithOwner, ref);
    }
    if (repos.size === 0) return 'unavailable';

    const [events, facts, tasks, workspaces] = await Promise.all([
      readTimeline(ws.id),
      deps.boxFacts ? deps.boxFacts().catch(() => []) : Promise.resolve([]),
      readTasks(ws.id).catch(() => []),
      listWorkspaces(),
    ]);
    const boxes = facts.filter(
      (b) => findWorkspaceContaining(workspaces, b.projectRoot)?.id === ws.id,
    );
    const known = new Set<string>();
    for (const b of boxes) for (const br of b.branches) known.add(br);
    for (const ev of events) if (ev.branch) known.add(ev.branch);
    const since = ws.createdAt.slice(0, 10);
    const floor = now() - TIMELINE_RETENTION_MS;
    let appended = 0;

    for (const ref of repos.values()) {
      const r = await gh([
        'pr',
        'list',
        '--repo',
        ref.arg,
        '--state',
        'all',
        '--limit',
        String(PR_LIST_LIMIT),
        '--search',
        `updated:>=${since}`,
        '--json',
        GH_PR_JSON_FIELDS,
      ]).catch(() => null);
      if (!r || r.exitCode !== 0) continue;
      let prs: GhPrJson[];
      try {
        prs = JSON.parse(r.stdout) as GhPrJson[];
      } catch {
        continue;
      }
      for (const pr of prs) {
        prStates.set(
          `${ref.nameWithOwner}#${String(pr.number)}`,
          pr.state === 'MERGED'
            ? 'merged'
            : pr.state === 'CLOSED'
              ? 'closed'
              : isPrReady(pr)
                ? 'ready'
                : 'open',
        );
        // A PR is the workspace's when its branch is one the workspace worked
        // on, or when the gh user opened it — which is how the manager's own
        // host-side PRs get in.
        if (!known.has(pr.headRefName) && pr.author?.login !== user) continue;
        const box = boxes.find((b) => b.branches.includes(pr.headRefName));
        const seen = events.find((ev) => ev.branch === pr.headRefName && ev.boxId);
        const boxTaskIds = box
          ? tasks.filter((t) => t.boxId === box.id).map((t) => t.id)
          : undefined;
        const taskIds = boxTaskIds?.length ? boxTaskIds : seen?.taskIds;
        const base: Omit<TimelineEvent, 'id' | 'at' | 'type' | 'pr' | 'key'> = {
          actor: 'github',
          ...(box ? { boxId: box.id, boxName: box.name } : {}),
          ...(!box && seen?.boxId ? { boxId: seen.boxId } : {}),
          ...(!box && seen?.boxName ? { boxName: seen.boxName } : {}),
          ...(seen?.managerId ? { managerId: seen.managerId } : {}),
          ...(taskIds?.length ? { taskIds } : {}),
        };
        for (const ev of prTimelineEvents(
          pr,
          ref.nameWithOwner,
          base,
          new Date(now()).toISOString(),
        )) {
          // An event older than the log keeps is dropped by the next compaction
          // anyway; appending it would only re-add what was compacted away.
          if (ev.at && Date.parse(ev.at) < floor) continue;
          if (await appendTimelineEvent(ws.id, ev).catch(() => null)) appended += 1;
        }
      }
    }
    if (appended > 0) deps.notify();
    return 'ok';
  }

  function stateOf(wsId: string): WorkspaceSyncState {
    let st = states.get(wsId);
    if (!st) {
      st = { lastAt: 0, running: null, status: null };
      states.set(wsId, st);
    }
    return st;
  }

  function run(ws: WorkspaceRecord): Promise<GithubSyncStatus> {
    const st = stateOf(ws.id);
    if (st.running) return st.running;
    st.running = sync(ws)
      .catch((): GithubSyncStatus => 'unavailable')
      .then((status) => {
        st.status = status;
        st.lastAt = now();
        st.running = null;
        return status;
      });
    return st.running;
  }

  return {
    kick(ws) {
      const st = stateOf(ws.id);
      if (!st.running && now() - st.lastAt >= interval) void run(ws);
      return st.status ?? 'syncing';
    },
    syncNow: run,
    prState(repo, number) {
      return prStates.get(`${repo}#${String(number)}`);
    },
  };
}
