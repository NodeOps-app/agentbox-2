// The workspace domain: workspaces, their tasks, and the host-local manager
// session. Everything here reaches state through @agentbox/relay's workspace
// store; nothing here knows about providers, containers or git.
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import {
  addTask,
  addWorkspace,
  assignTasks,
  buildManagerArgv,
  filterTasks,
  isResumableManagerAgent,
  listResumableHostSessions,
  listWorkspaces,
  managerSessionName,
  managerView,
  patchTask,
  readReconciledTasks,
  readWorkspace,
  removeTask,
  removeWorkspace,
  renameWorkspace,
  reorderTasks,
  rescanWorkspace,
  setTaskDone,
  startManagerSession,
  stopManagerSession,
  taskSummaryForBox,
  tmuxAvailable,
  tmuxSessionExists,
  toWorkspaceView,
  unassignTasks,
  RESUMABLE_MANAGER_AGENTS,
  type BoxTaskSummary,
  type ReconcileContext,
  type Workspace,
  type WorkTask,
} from '@agentbox/relay';
import type { BackendDeps } from './deps';
import type {
  ActionResult,
  AddTaskInput,
  AssignTarget,
  ManagerSessionsResult,
  ManagerResult,
  StartManagerInput,
  TaskFilter,
  TaskResult,
  TasksResult,
  UpdateTaskInput,
  WorkspaceBackend,
  WorkspaceResult,
} from '../boxes/backend-types';
import type { ManagerView, WorkspaceView } from '../boxes/types';

/** Tasks a box can never have: a task cannot be assigned to a bake. */
const TMUX_MISSING =
  'tmux is not installed on the hub host; the manager runs in a tmux session (brew install tmux)';

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function unknownWorkspace(id: string): { ok: false; error: string } {
  return err(`unknown workspace ${id}`);
}

export function createWorkspaceBackend(deps: BackendDeps): WorkspaceBackend {
  /**
   * The box/job facts reconciliation needs. Both are whole-fleet listings (a
   * docker inspect per box, plus every queue manifest), so a call that reconciles
   * several workspaces resolves them ONCE and hands the same snapshot down —
   * `getData()` does exactly that on every dashboard poll.
   */
  async function reconcileContext(): Promise<ReconcileContext> {
    const [liveBoxIds, jobs] = await Promise.all([deps.liveBoxIds(), deps.jobs()]);
    return {
      liveBoxIds,
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        ...(j.boxId ? { boxId: j.boxId } : {}),
      })),
    };
  }

  /**
   * A workspace's tasks with their assignments healed against reality. The
   * write-back is locked and change-gated inside the store — this is the poll
   * path, and racing a concurrent `addTask` would drop the new task.
   */
  async function tasksOf(wsId: string, ctx?: ReconcileContext): Promise<WorkTask[]> {
    return readReconciledTasks(wsId, ctx ?? (await reconcileContext()));
  }

  /** Workspace + the derived counts a list row shows. */
  async function viewOf(
    rec: Awaited<ReturnType<typeof readWorkspace>>,
    ctx?: ReconcileContext,
  ): Promise<WorkspaceView | null> {
    if (!rec) return null;
    const [tasks, manager] = await Promise.all([tasksOf(rec.id, ctx), managerView(rec.id)]);
    const base: Workspace = toWorkspaceView(rec);
    return {
      ...base,
      taskCounts: {
        open: tasks.filter((t) => t.status !== 'done').length,
        done: tasks.filter((t) => t.status === 'done').length,
      },
      manager: manager.status === 'never' ? null : { status: manager.status, agent: manager.agent },
    };
  }

  /** A box id must exist; a job id must be a create job that has not failed. */
  async function validateTarget(target: AssignTarget): Promise<string | null> {
    if ('boxId' in target) {
      const live = await deps.liveBoxIds();
      return live.has(target.boxId) ? null : `unknown box ${target.boxId}`;
    }
    const job = (await deps.jobs()).find((j) => j.id === target.boxJobId);
    if (!job) return `unknown job ${target.boxJobId}`;
    if (job.kind === 'prepare') return `job ${target.boxJobId} is an image bake, not a box create`;
    return null;
  }

  async function requireWorkspace(wsId: string): Promise<{ id: string; root: string } | null> {
    const rec = await readWorkspace(wsId);
    return rec ? { id: rec.id, root: rec.root } : null;
  }

  return {
    async listWorkspaces(): Promise<WorkspaceView[]> {
      const recs = await listWorkspaces();
      if (recs.length === 0) return [];
      const ctx = await reconcileContext();
      const views = await Promise.all(recs.map((r) => viewOf(r, ctx)));
      return views.filter((v): v is WorkspaceView => v !== null);
    },

    async getWorkspace(id: string): Promise<WorkspaceView | null> {
      return viewOf(await readWorkspace(id));
    },

    async addWorkspace(input: { path: string; name?: string }): Promise<WorkspaceResult> {
      const path = input.path;
      if (!isAbsolute(path)) return err('an absolute path is required');
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        return err(`not a directory: ${path}`);
      }
      try {
        const rec = await addWorkspace(path, input.name ? { name: input.name } : {});
        deps.notify();
        const view = await viewOf(rec);
        return view ? { ok: true, workspace: view } : err('workspace was not written');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async rescanWorkspace(id: string): Promise<WorkspaceResult> {
      const rec = await rescanWorkspace(id);
      if (!rec) return unknownWorkspace(id);
      deps.notify();
      const view = await viewOf(rec);
      return view ? { ok: true, workspace: view } : unknownWorkspace(id);
    },

    async renameWorkspace(id: string, name: string): Promise<WorkspaceResult> {
      const rec = await renameWorkspace(id, name);
      if (!rec) return unknownWorkspace(id);
      deps.notify();
      const view = await viewOf(rec);
      return view ? { ok: true, workspace: view } : unknownWorkspace(id);
    },

    async removeWorkspace(id: string): Promise<ActionResult> {
      const rec = await readWorkspace(id);
      if (!rec) return unknownWorkspace(id);
      // A live manager is a running process in that folder: unregistering under
      // it would orphan the tmux session with nothing left pointing at it.
      if (await tmuxSessionExists(managerSessionName(id))) {
        return err('the workspace manager is running; stop it before removing the workspace');
      }
      await removeWorkspace(id);
      deps.notify();
      return { ok: true };
    },

    async listTasks(wsId: string, filter?: TaskFilter): Promise<WorkTask[] | null> {
      if (!(await readWorkspace(wsId))) return null;
      return filterTasks(await tasksOf(wsId), filter);
    },

    async listAllTasks(filter?: TaskFilter & { workspaceId?: string }): Promise<WorkTask[]> {
      const recs = await listWorkspaces();
      const wanted = filter?.workspaceId ? recs.filter((r) => r.id === filter.workspaceId) : recs;
      if (wanted.length === 0) return [];
      const ctx = await reconcileContext();
      const lists = await Promise.all(
        wanted.map(async (r) => filterTasks(await tasksOf(r.id, ctx), filter)),
      );
      return lists.flat();
    },

    async getTask(wsId: string, taskId: string): Promise<WorkTask | null> {
      return (await tasksOf(wsId)).find((t) => t.id === taskId) ?? null;
    },

    async addTask(wsId: string, input: AddTaskInput): Promise<TaskResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      if (input.boxId || input.boxJobId) {
        const bad = await validateTarget(
          input.boxId ? { boxId: input.boxId } : { boxJobId: input.boxJobId! },
        );
        if (bad) return err(bad);
      }
      try {
        const task = await addTask(wsId, input);
        deps.notify();
        return { ok: true, task };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async updateTask(wsId: string, taskId: string, patch: UpdateTaskInput): Promise<TaskResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      try {
        const task = await patchTask(wsId, taskId, patch);
        if (!task) return err(`unknown task ${taskId}`);
        deps.notify();
        return { ok: true, task };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async completeTask(wsId: string, taskId: string): Promise<TaskResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      const task = await setTaskDone(wsId, taskId);
      if (!task) return err(`unknown task ${taskId}`);
      deps.notify();
      return { ok: true, task };
    },

    async removeTask(wsId: string, taskId: string): Promise<ActionResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      if (!(await removeTask(wsId, taskId))) return err(`unknown task ${taskId}`);
      deps.notify();
      return { ok: true };
    },

    async assignTasks(wsId: string, ids: string[], target: AssignTarget): Promise<TasksResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      const bad = await validateTarget(target);
      if (bad) return err(bad);
      try {
        const tasks = await assignTasks(wsId, ids, target);
        deps.notify();
        return { ok: true, tasks };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async unassignTasks(wsId: string, ids: string[]): Promise<TasksResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      try {
        const tasks = await unassignTasks(wsId, ids);
        deps.notify();
        return { ok: true, tasks };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async reorderTasks(wsId: string, ids: string[]): Promise<TasksResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      try {
        const tasks = await reorderTasks(wsId, ids);
        deps.notify();
        return { ok: true, tasks };
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },

    async getManager(wsId: string): Promise<ManagerView | null> {
      if (!(await readWorkspace(wsId))) return null;
      return managerView(wsId);
    },

    async startManager(wsId: string, input: StartManagerInput): Promise<ManagerResult> {
      const ws = await requireWorkspace(wsId);
      if (!ws) return unknownWorkspace(wsId);
      if (!(await tmuxAvailable())) return err(TMUX_MISSING);
      const running = await tmuxSessionExists(managerSessionName(wsId));
      if (running && !input.restart) {
        return err(`a manager is already running for workspace ${wsId}; stop it first`);
      }
      if (running) await stopManagerSession(wsId);

      // The route validator is the accept-list for `agent`; here we only need the
      // one rule it cannot express — only some agents can be resumed, and
      // starting a FRESH agent that looks resumed is worse than a 400.
      if (input.sessionId && !isResumableManagerAgent(input.agent)) {
        return err(
          `session resume is only supported for ${RESUMABLE_MANAGER_AGENTS.join(', ')}, not ${input.agent}`,
        );
      }
      const agent = input.agent;
      const argv = buildManagerArgv(agent, input.sessionId);
      try {
        await startManagerSession({
          wsId,
          root: ws.root,
          agent,
          argv,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(deps.managerExec ? { exec: deps.managerExec } : {}),
        });
      } catch (e) {
        return err(`could not start the manager: ${e instanceof Error ? e.message : String(e)}`);
      }
      deps.notify();
      return { ok: true, manager: await managerView(wsId) };
    },

    async stopManager(wsId: string): Promise<ManagerResult> {
      if (!(await readWorkspace(wsId))) return unknownWorkspace(wsId);
      await stopManagerSession(wsId);
      deps.notify();
      return { ok: true, manager: await managerView(wsId) };
    },

    async listManagerSessions(wsId: string, agent?: string): Promise<ManagerSessionsResult | null> {
      const ws = await requireWorkspace(wsId);
      if (!ws) return null;
      return listResumableHostSessions(ws.root, agent ?? 'claude');
    },

    // ── hooks getData() calls, so the dashboard read stays in one place ──

    async workspaceIdByProject(): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for (const ws of await listWorkspaces()) {
        for (const pid of ws.projectIds) out.set(pid, ws.id);
      }
      return out;
    },

    async taskSummaries(): Promise<{
      byBox: Map<string, BoxTaskSummary>;
      byJob: Map<string, BoxTaskSummary>;
    }> {
      const byBox = new Map<string, BoxTaskSummary>();
      const byJob = new Map<string, BoxTaskSummary>();
      const recs = await listWorkspaces();
      if (recs.length === 0) return { byBox, byJob };
      const ctx = await reconcileContext();
      for (const ws of recs) {
        const tasks = await tasksOf(ws.id, ctx);
        for (const boxId of new Set(
          tasks.map((t) => t.boxId).filter((b): b is string => Boolean(b)),
        )) {
          const summary = taskSummaryForBox(tasks, { boxId });
          if (summary) byBox.set(boxId, summary);
        }
        for (const jobId of new Set(
          tasks.map((t) => t.boxJobId).filter((b): b is string => Boolean(b)),
        )) {
          const summary = taskSummaryForBox(tasks, { boxJobId: jobId });
          if (summary) byJob.set(jobId, summary);
        }
      }
      return { byBox, byJob };
    },
  };
}
