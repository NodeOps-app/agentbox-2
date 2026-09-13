// The manager domain: host agent sessions that orchestrate boxes, many per
// workspace. A manager is either `external` (a claude/codex session in the
// user's own terminal, registered when the CLI runs inside it) or `hub` (one
// this hub started in tmux). State lives in @agentbox/relay's workspace store.
import { stat } from 'node:fs/promises';
import { homedir, hostname as osHostname } from 'node:os';
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
  managerSessionName,
  managerStatus,
  newManagerId,
  patchManager,
  processStartTime,
  readManagerExit,
  readManagers,
  readReconciledManagers,
  readTasks,
  readTimeline,
  readWorkspace,
  recordTimelineEvent,
  removeManagerRecord,
  resumeManagerSession,
  sendKeysToManager,
  sessionTitle,
  sessionTurn,
  stampFields,
  startManagerSession,
  stopManagerSession,
  tmuxAvailable,
  toManagerView,
  UNTITLED_SESSION,
  upsertDetectedManager,
  usesLegacySession,
  RESUMABLE_MANAGER_AGENTS,
  type ManagerProbe,
  type ManagerRecord,
  type ReconcileContext,
  type TimelineEvent,
  type TimelineEventType,
  type TimelinePr,
  type TimelineStamp,
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
  ManagerMessageDelivery,
  ManagerMessageResult,
  ManagerNoteResult,
  ManagerResult,
  ManagerSessionsResult,
  StartManagerInput,
  TimelineMeta,
} from '../boxes/backend-types';
import type { ManagerView, WorkspaceView } from '../boxes/types';

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/** A refusal about the request itself: the route answers 400, not 409. */
function invalid(message: string): { ok: false; error: string; invalid: true } {
  return { ok: false, error: message, invalid: true };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ManagerBackendOptions {
  /** The workspace slice's view, so a detect answers with the same shape `GET /workspaces` does. */
  workspaceView(id: string): Promise<WorkspaceView | null>;
  /** Seams for the title lookup and its retry clock; production reads the agent's store. */
  sessionTitle?: typeof sessionTitle;
  now?: () => number;
  /** Seam for the turn lookup that stamps timeline events. */
  sessionTurn?: typeof sessionTurn;
  /** The pause between typing a message and submitting it; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long a session whose title could not be read is left alone. `GET /managers`
 * is polled, and a codex lookup can scan hundreds of rollout files.
 */
const TITLE_RETRY_MS = 10 * 60 * 1000;

export function createManagerBackend(
  deps: BackendDeps,
  opts: ManagerBackendOptions,
): ManagerBackend {
  const hostname = deps.hostname ?? osHostname;
  const probe: ManagerProbe = {
    hostname,
    ...(deps.managerExec ? { exec: deps.managerExec } : {}),
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
    ...(deps.processStartTime ? { processStartTime: deps.processStartTime } : {}),
  };

  /**
   * The agent's store is only on the machine the session ran on: a hub-run
   * manager is always here, an external one only when it reported this host.
   */
  function storeIsLocal(rec: ManagerRecord): boolean {
    return rec.kind === 'hub' || rec.host === hostname();
  }

  const lookupTitle = opts.sessionTitle ?? sessionTitle;
  const now = opts.now ?? Date.now;
  /** Failed lookups by manager id, in memory only: a miss is not a fact to persist. */
  const titleMisses = new Map<string, { sessionId: string; at: number }>();

  /**
   * Cache the session's title on the record the first time a real one can be
   * read. An untitled answer is not cached — the session may simply not have a
   * first turn yet — and a miss is retried only after `TITLE_RETRY_MS`.
   */
  async function withTitle(raw: ManagerRecord): Promise<ManagerRecord> {
    let rec = raw;
    if (rec.title === UNTITLED_SESSION) {
      // Written by an earlier build that cached it.
      rec = { ...raw };
      delete rec.title;
    }
    if (rec.title || !rec.sessionId || !storeIsLocal(rec)) return rec;
    const sessionId = rec.sessionId;
    const miss = titleMisses.get(rec.id);
    if (miss && miss.sessionId === sessionId && now() - miss.at < TITLE_RETRY_MS) return rec;
    const title = await lookupTitle(rec.agent, rec.cwd, sessionId).catch(() => null);
    if (!title || title === UNTITLED_SESSION) {
      titleMisses.set(rec.id, { sessionId, at: now() });
      return rec;
    }
    titleMisses.delete(rec.id);
    // Guarded on the session id: a detect that moved the record to a new session
    // meanwhile must not get the old session's title written over it.
    await patchManager(rec.workspaceId, rec.id, (cur) =>
      cur.sessionId === sessionId && (!cur.title || cur.title === UNTITLED_SESSION)
        ? { ...cur, title }
        : cur,
    ).catch(() => null);
    return { ...rec, title };
  }

  const lookupTurn = opts.sessionTurn ?? sessionTurn;

  /** A manager as a timeline actor, with its current turn when its transcript is here. */
  async function managerStamp(rec: ManagerRecord): Promise<TimelineStamp> {
    const turn =
      rec.sessionId && storeIsLocal(rec)
        ? await lookupTurn(rec.agent, rec.cwd, rec.sessionId).catch(() => undefined)
        : undefined;
    return {
      actor: 'manager',
      managerId: rec.id,
      ...(turn ? { turn: turn.turn, ...(turn.prompt ? { prompt: turn.prompt } : {}) } : {}),
    };
  }

  /** A lifecycle event about `rec`, by whoever the stamp names. Best-effort. */
  async function recordManagerEvent(
    rec: ManagerRecord,
    type: TimelineEventType,
    stamp: TimelineStamp | undefined,
  ): Promise<void> {
    await recordTimelineEvent(rec.workspaceId, {
      type,
      ...stampFields(stamp),
      managerId: rec.id,
      agent: rec.agent,
    });
  }

  /** The PR a message is about, as the log last saw it. */
  async function knownPr(wsId: string, number: number): Promise<TimelinePr> {
    const hit = (await readTimeline(wsId).catch((): TimelineEvent[] => [])).find(
      (ev) => ev.pr?.number === number,
    );
    return hit?.pr ?? { repo: '', number, title: '', url: '', base: '', head: '' };
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
            ? await readManagerExit(ws.id, rec.id, { legacy: usesLegacySession(rec) })
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

  /**
   * Why a detect must not create a workspace at `cwd`, or null. A session run
   * from `/` or the home folder would otherwise claim every project under it,
   * and a caller's path that is not a folder here would register a phantom.
   */
  async function autoWorkspaceRefusal(cwd: string): Promise<string | null> {
    const home = await canonicalWorkspaceRoot(homedir());
    const what =
      cwd === '/'
        ? 'is the filesystem root'
        : cwd === home
          ? 'is your home folder'
          : home.startsWith(`${cwd}/`)
            ? 'contains your home folder'
            : null;
    if (what) {
      return `not creating a workspace at ${cwd}: it ${what}. Register the project folder instead: agentbox workspace add <project folder>`;
    }
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) return `folder does not exist on this hub: ${cwd}`;
    return null;
  }

  /**
   * The migrated single-manager record a detect with no `managerId` comes from.
   * That layout started its agent with `AGENTBOX_MANAGER=1`, which names no
   * record, so its first detect would otherwise register a duplicate external
   * manager beside the running hub one. Limited to records still on the old tmux
   * name: a current hub-run manager exports its own id, and a terminal session in
   * the same folder must not be folded into it.
   */
  async function legacyManagerFor(
    wsId: string,
    agent: string,
    cwd: string,
  ): Promise<string | undefined> {
    const candidates = (await readManagers(wsId)).filter(
      (m) => usesLegacySession(m) && !m.sessionId && m.agent === agent && m.cwd === cwd,
    );
    const running: string[] = [];
    for (const m of candidates) {
      if ((await managerStatus(m, probe)) === 'running') running.push(m.id);
    }
    return running.length === 1 ? running[0] : undefined;
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
          const refusal = await autoWorkspaceRefusal(cwd);
          if (refusal) return invalid(refusal);
          try {
            ws = await addWorkspace(cwd);
            workspaceCreated = true;
          } catch (e) {
            return err(`could not register a workspace at ${cwd}: ${messageOf(e)}`);
          }
        }
      }
      // Only a pid from this machine can be stamped: elsewhere it names another process.
      const pidStartedAt =
        input.pid !== undefined && input.host === hostname()
          ? await (deps.processStartTime ?? processStartTime)(input.pid).catch(() => undefined)
          : undefined;
      const managerId =
        input.managerId ?? (known ? undefined : await legacyManagerFor(ws.id, input.agent, cwd));
      const { manager, created, sessionChanged } = await upsertDetectedManager(ws.id, {
        agent: input.agent,
        sessionId: input.sessionId,
        cwd,
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(pidStartedAt ? { pidStartedAt } : {}),
        ...(input.host ? { host: input.host } : {}),
        ...(managerId ? { managerId } : {}),
        ...(input.tmuxPane ? { tmuxPane: input.tmuxPane } : {}),
      });
      if (input.boxId) await attachBoxToManager(ws.id, manager.id, { boxId: input.boxId });
      else if (input.boxJobId) {
        await attachBoxToManager(ws.id, manager.id, { boxJobId: input.boxJobId });
      }
      // A detect runs on nearly every CLI call; only a new record or a new
      // session in an existing one (`/clear`, a hub-run agent's first call) is news.
      if (created || sessionChanged) {
        await recordManagerEvent(manager, 'manager.joined', { actor: 'manager' });
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

    async startManager(
      wsId: string,
      input: StartManagerInput,
      meta?: TimelineMeta,
    ): Promise<ManagerResult> {
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
          await recordManagerEvent(existing, 'manager.resumed', meta?.stamp);
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
      await recordManagerEvent(manager, 'manager.started', meta?.stamp);
      deps.notify();
      return answer(manager.id);
    },

    async resumeManager(id: string, meta?: TimelineMeta): Promise<ManagerResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
      try {
        await resumeManagerSession(rec.workspaceId, id, probe);
      } catch (e) {
        return err(messageOf(e));
      }
      await recordManagerEvent(rec, 'manager.resumed', meta?.stamp);
      deps.notify();
      return answer(id);
    },

    async stopManager(id: string, meta?: TimelineMeta): Promise<ManagerResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const wasRunning = (await managerStatus(rec, probe)) === 'running';
      try {
        await stopManagerSession(rec.workspaceId, id, probe);
      } catch (e) {
        return err(messageOf(e));
      }
      // Stop is idempotent: stopping a session that had already ended is not an event.
      if (wasRunning) await recordManagerEvent(rec, 'manager.stopped', meta?.stamp);
      deps.notify();
      return answer(id);
    },

    async removeManager(id: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      // A record is the only handle on a running process: forgetting it would
      // leave a tmux session (or a terminal session's boxes) nothing points at.
      // `force` is the way out when the status is wrong (a pid the probe cannot
      // tell apart, a last-seen window that has not lapsed yet).
      if (!opts.force && (await managerStatus(rec, probe)) === 'running') {
        return err(`manager ${id} is running; stop it before forgetting it (or force it)`);
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

    async timelineStamp(ref, wsId) {
      const rec =
        'managerId' in ref
          ? await findManager(ref.managerId)
          : await findManagerBySession(ref.agent, ref.sessionId);
      if (!rec || (wsId !== undefined && rec.workspaceId !== wsId)) return undefined;
      return managerStamp(rec);
    },

    async addManagerNote(id, input): Promise<ManagerNoteResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const event = await recordTimelineEvent(rec.workspaceId, {
        type: 'manager.note',
        ...stampFields(await managerStamp(rec)),
        text: input.text,
        noteKind: input.kind ?? 'note',
      });
      // Here the log write IS the mutation, so unlike every other writer a miss is an error.
      if (!event) return err(`the note for manager ${id} was not recorded`);
      deps.notify();
      return { ok: true, event };
    },

    async sendManagerMessage(id, input, meta): Promise<ManagerMessageResult> {
      const rec = await findManager(id);
      if (!rec) return err(`unknown manager ${id}`);
      const status = await managerStatus(rec, probe);
      let delivered: ManagerMessageDelivery;
      try {
        if (status === 'running' && rec.kind === 'hub') {
          await sendKeysToManager(
            { session: rec.tmuxSession ?? managerSessionName(rec.id) },
            input.text,
            deps.managerExec,
            opts.sleep,
          );
          delivered = 'session';
        } else if (status === 'running') {
          // A pane is only reachable on the machine whose tmux server holds it.
          if (!rec.tmuxPane || !storeIsLocal(rec)) {
            return {
              ok: false,
              code: 'manager_unreachable',
              error: `manager ${id} runs in your terminal${rec.tmuxPane ? ' on another machine' : ' outside tmux'}, where the hub cannot type; paste the message into that session`,
            };
          }
          await sendKeysToManager({ pane: rec.tmuxPane }, input.text, deps.managerExec, opts.sleep);
          delivered = 'pane';
        } else {
          if (!(await tmuxAvailable(deps.managerExec))) return err(TMUX_MISSING);
          await resumeManagerSession(rec.workspaceId, id, probe, { prompt: input.text });
          delivered = 'resumed';
        }
      } catch (e) {
        return err(messageOf(e));
      }
      const pr =
        input.prNumber !== undefined ? await knownPr(rec.workspaceId, input.prNumber) : undefined;
      const event = await recordTimelineEvent(rec.workspaceId, {
        type: 'manager.message',
        ...stampFields(meta?.stamp),
        managerId: rec.id,
        text: input.text,
        ...(pr ? { pr } : {}),
      });
      deps.notify();
      const view = await viewOf(id);
      if (!view) return err(`unknown manager ${id}`);
      return { ok: true, delivered, manager: view, event };
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
