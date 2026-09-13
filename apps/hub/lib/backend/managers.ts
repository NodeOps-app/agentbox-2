// The manager domain: host agent sessions that orchestrate boxes, many per
// workspace. A manager is either `external` (a claude/codex session in the
// user's own terminal, registered when the CLI runs inside it) or `hub` (one
// this hub started in tmux). State lives in @agentbox/relay's workspace store.
import { hostname as osHostname } from 'node:os';
import {
  addWorkspace,
  attachBoxToManager,
  buildManagerArgv,
  canonicalWorkspaceRoot,
  findManager,
  findManagerBySession,
  findWorkspaceContaining,
  isResumableManagerAgent,
  listResumableHostSessions,
  listWorkspaces,
  managerStatus,
  newManagerId,
  patchManager,
  readManagerExit,
  readReconciledManagers,
  readTasks,
  readWorkspace,
  removeManagerRecord,
  resumeManagerSession,
  sessionTitle,
  startManagerSession,
  stopManagerSession,
  tmuxAvailable,
  toManagerView,
  upsertDetectedManager,
  RESUMABLE_MANAGER_AGENTS,
  type ManagerProbe,
  type ManagerRecord,
  type ReconcileContext,
  type WorkspaceRecord,
} from '@agentbox/relay';
import { reconcileContext, type BackendDeps } from './deps';
import { TMUX_MISSING } from './errors';
import type {
  ActionResult,
  DetectManagerInput,
  DetectManagerResult,
  ManagerBackend,
  ManagerFilter,
  ManagerResult,
  ManagerSessionsResult,
  StartManagerInput,
} from '../boxes/backend-types';
import type { ManagerView, WorkspaceView } from '../boxes/types';

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ManagerBackendOptions {
  /** The workspace slice's view, so a detect answers with the same shape `GET /workspaces` does. */
  workspaceView(id: string): Promise<WorkspaceView | null>;
}

export function createManagerBackend(
  deps: BackendDeps,
  opts: ManagerBackendOptions,
): ManagerBackend {
  const hostname = deps.hostname ?? osHostname;
  const probe: ManagerProbe = {
    hostname,
    ...(deps.managerExec ? { exec: deps.managerExec } : {}),
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
  };

  /**
   * The agent's store is only on the machine the session ran on: a hub-run
   * manager is always here, an external one only when it reported this host.
   */
  function storeIsLocal(rec: ManagerRecord): boolean {
    return rec.kind === 'hub' || rec.host === hostname();
  }

  /** Cache the session's title on the record the first time it can be read. */
  async function withTitle(rec: ManagerRecord): Promise<ManagerRecord> {
    if (rec.title || !rec.sessionId || !storeIsLocal(rec)) return rec;
    const title = await sessionTitle(rec.agent, rec.cwd, rec.sessionId).catch(() => null);
    if (!title) return rec;
    const sessionId = rec.sessionId;
    // Guarded on the session id: a detect that moved the record to a new session
    // meanwhile must not get the old session's title written over it.
    await patchManager(rec.workspaceId, rec.id, (cur) =>
      cur.sessionId === sessionId && !cur.title ? { ...cur, title } : cur,
    ).catch(() => null);
    return { ...rec, title };
  }

  async function viewsOf(ws: WorkspaceRecord, ctx: ReconcileContext): Promise<ManagerView[]> {
    const records = await readReconciledManagers(ws.id, ctx);
    if (records.length === 0) return [];
    const tasks = await readTasks(ws.id);
    return Promise.all(
      records.map(async (raw) => {
        const rec = await withTitle(raw);
        const status = await managerStatus(rec, probe);
        const lastExit =
          status === 'stopped' && rec.kind === 'hub' && rec.lastExit === undefined
            ? await readManagerExit(ws.id, rec.id)
            : undefined;
        return toManagerView(rec, {
          status,
          hostname: hostname(),
          workspaceName: ws.name,
          tasks,
          ...(lastExit === undefined ? {} : { lastExit }),
        });
      }),
    );
  }

  async function viewOf(id: string): Promise<ManagerView | null> {
    const rec = await findManager(id);
    if (!rec) return null;
    const ws = await readWorkspace(rec.workspaceId);
    if (!ws) return null;
    return (await viewsOf(ws, await reconcileContext(deps))).find((m) => m.id === id) ?? null;
  }

  /** Running first, then the most recently seen. */
  function sortViews(views: ManagerView[]): ManagerView[] {
    return [...views].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });
  }

  async function answer(id: string): Promise<ManagerResult> {
    const view = await viewOf(id);
    return view ? { ok: true, manager: view } : err(`unknown manager ${id}`);
  }

  return {
    async detectManager(input: DetectManagerInput): Promise<DetectManagerResult> {
      const cwd = await canonicalWorkspaceRoot(input.cwd);
      // A session already registered stays where it is, even when this call came
      // from a subfolder another workspace contains.
      const known =
        (await findManagerBySession(input.agent, input.sessionId)) ??
        (input.managerId ? await findManager(input.managerId) : null);
      let ws = known ? await readWorkspace(known.workspaceId) : null;
      let workspaceCreated = false;
      if (!ws) {
        ws = findWorkspaceContaining(await listWorkspaces(), cwd);
        if (!ws) {
          try {
            ws = await addWorkspace(cwd);
            workspaceCreated = true;
          } catch (e) {
            return err(`could not register a workspace at ${cwd}: ${messageOf(e)}`);
          }
        }
      }
      const { manager, created } = await upsertDetectedManager(ws.id, {
        agent: input.agent,
        sessionId: input.sessionId,
        cwd,
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(input.host ? { host: input.host } : {}),
        ...(input.managerId ? { managerId: input.managerId } : {}),
      });
      if (input.boxId) await attachBoxToManager(ws.id, manager.id, { boxId: input.boxId });
      else if (input.boxJobId) {
        await attachBoxToManager(ws.id, manager.id, { boxJobId: input.boxJobId });
      }
      deps.notify();
      const [view, workspace] = await Promise.all([viewOf(manager.id), opts.workspaceView(ws.id)]);
      if (!view || !workspace) return err('the manager was not written');
      return { ok: true, manager: view, workspace, created: created || workspaceCreated };
    },

    async listManagers(filter?: ManagerFilter): Promise<ManagerView[]> {
      const all = await listWorkspaces();
      const wanted = filter?.workspaceId ? all.filter((w) => w.id === filter.workspaceId) : all;
      if (wanted.length === 0) return [];
      const ctx = await reconcileContext(deps);
      const views = (await Promise.all(wanted.map((ws) => viewsOf(ws, ctx)))).flat();
      return sortViews(filter?.status ? views.filter((v) => v.status === filter.status) : views);
    },

    getManager: viewOf,

    async listWorkspaceManagers(wsId: string): Promise<ManagerView[] | null> {
      const ws = await readWorkspace(wsId);
      if (!ws) return null;
      return sortViews(await viewsOf(ws, await reconcileContext(deps)));
    },

    async startManager(wsId: string, input: StartManagerInput): Promise<ManagerResult> {
      const ws = await readWorkspace(wsId);
      if (!ws) return err(`unknown workspace ${wsId}`);
      if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
      // The route validator is the accept-list for `agent`; here we only need the
      // one rule it cannot express — only some agents can be resumed, and
      // starting a FRESH agent that looks resumed is worse than a 400.
      if (input.sessionId && !isResumableManagerAgent(input.agent)) {
        return err(
          `session resume is only supported for ${RESUMABLE_MANAGER_AGENTS.join(', ')}, not ${input.agent}`,
        );
      }
      if (input.sessionId) {
        // A session some manager already holds is resumed AS that manager, so the
        // boxes and tasks it collected stay with it instead of forking a duplicate.
        const existing = await findManagerBySession(input.agent, input.sessionId);
        if (existing) {
          try {
            if (
              input.restart &&
              existing.kind === 'hub' &&
              (await managerStatus(existing, probe)) === 'running'
            ) {
              await stopManagerSession(existing.workspaceId, existing.id, probe);
            }
            await resumeManagerSession(existing.workspaceId, existing.id, probe);
          } catch (e) {
            return err(messageOf(e));
          }
          deps.notify();
          return answer(existing.id);
        }
      }
      const at = new Date().toISOString();
      const manager: ManagerRecord = {
        id: newManagerId(),
        workspaceId: ws.id,
        agent: input.agent,
        kind: 'hub',
        cwd: ws.root,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        boxIds: [],
        boxJobIds: [],
        createdAt: at,
        lastSeenAt: at,
      };
      try {
        await startManagerSession({
          wsId: ws.id,
          manager,
          argv: buildManagerArgv(input.agent, input.sessionId),
          ...(deps.managerExec ? { exec: deps.managerExec } : {}),
        });
      } catch (e) {
        return err(`could not start the manager: ${messageOf(e)}`);
      }
      deps.notify();
      return answer(manager.id);
    },

    async resumeManager(id: string): Promise<ManagerResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
      try {
        await resumeManagerSession(rec.workspaceId, id, probe);
      } catch (e) {
        return err(messageOf(e));
      }
      deps.notify();
      return answer(id);
    },

    async stopManager(id: string): Promise<ManagerResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      try {
        await stopManagerSession(rec.workspaceId, id, probe);
      } catch (e) {
        return err(messageOf(e));
      }
      deps.notify();
      return answer(id);
    },

    async removeManager(id: string): Promise<ActionResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      // A record is the only handle on a running process: forgetting it would
      // leave a tmux session (or a terminal session's boxes) nothing points at.
      if ((await managerStatus(rec, probe)) === 'running') {
        return err(`manager ${id} is running; stop it before forgetting it`);
      }
      await removeManagerRecord(rec.workspaceId, id);
      deps.notify();
      return { ok: true };
    },

    async listManagerSessions(wsId: string, agent?: string): Promise<ManagerSessionsResult | null> {
      const ws = await readWorkspace(wsId);
      if (!ws) return null;
      return listResumableHostSessions(ws.root, agent ?? 'claude');
    },

    async attachJob(managerId: string, jobId: string): Promise<ActionResult> {
      const rec = await findManager(managerId);
      if (!rec) return err(`unknown manager ${managerId}`);
      await attachBoxToManager(rec.workspaceId, managerId, { boxJobId: jobId });
      deps.notify();
      return { ok: true };
    },

    async managerByBox(): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      const all = await listWorkspaces();
      if (all.length === 0) return out;
      const ctx = await reconcileContext(deps);
      for (const ws of all) {
        for (const m of await readReconciledManagers(ws.id, ctx)) {
          for (const boxId of m.boxIds) out.set(boxId, m.id);
          for (const jobId of m.boxJobIds) out.set(jobId, m.id);
        }
      }
      return out;
    },
  };
}
