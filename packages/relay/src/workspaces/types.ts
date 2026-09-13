import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/sandbox-core';
import type { AgentId } from '@agentbox/core';

/** Root of the workspace registry: one directory per workspace, keyed by its id. */
export const WORKSPACES_DIR = join(STATE_DIR, 'workspaces');

/**
 * A workspace is a host FOLDER that groups one or more projects and owns a task
 * list plus (optionally) a manager agent session. It is deliberately not a
 * project: a project is one repo/agentbox.yaml root a box is built from, while a
 * workspace is the unit a human (and its managers) plan across.
 *
 * `id` is `hashProjectPath(root)` — the same key space as the project registry,
 * so a single-project folder registered as both shares one id and a client can
 * join the two without a lookup table.
 */
export interface WorkspaceRecord {
  id: string;
  name: string;
  /** Absolute, realpath'd folder. */
  root: string;
  /** Project ids (`hashProjectPath`) discovered under `root` and registered. */
  projectIds: string[];
  /**
   * Monotonic counter behind `T-<n>` task ids. Never decremented, so a deleted
   * task's id is not handed to a later one — stale references in a manager
   * transcript or a PR body must not silently resolve to different work.
   */
  taskCounter: number;
  createdAt: string;
  updatedAt: string;
}

/** API view of a workspace: the record minus its internal id counter. */
export type Workspace = Omit<WorkspaceRecord, 'taskCounter'>;

export type WorkTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export const WORK_TASK_STATUSES: readonly WorkTaskStatus[] = [
  'todo',
  'in_progress',
  'blocked',
  'done',
];

export type WorkTaskCreatedBy = 'human' | 'manager' | 'api';

/**
 * Where this task came from in an external tracker. One ticket routinely becomes
 * several local tasks, so this is a back-reference, never an identity.
 */
export interface WorkTaskExternalRef {
  kind: 'linear' | (string & {});
  id: string;
  url?: string;
}

/**
 * A unit of work. Owned by a workspace; optionally scoped to one project and
 * assigned to one box. Many tasks map to a single box on purpose — the manager
 * groups tasks that touch the same files so they share a branch instead of
 * racing for it.
 */
export interface WorkTask {
  /** `T-<n>`, unique within the workspace. */
  id: string;
  workspaceId: string;
  projectId?: string;
  title: string;
  description?: string;
  status: WorkTaskStatus;
  /** Position in the list. The list order IS the priority. */
  order: number;
  boxId?: string;
  /**
   * A create job that has not produced a box id yet. Mutually exclusive with
   * `boxId`: reconciliation promotes one to the other once the worker records
   * the box, so a task assigned at create time is never orphaned by the gap.
   */
  boxJobId?: string;
  /** The manager session this task belongs to. Inherited from its box on assignment. */
  managerId?: string;
  dependsOn?: string[];
  createdBy: WorkTaskCreatedBy;
  externalRef?: WorkTaskExternalRef;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}

/** On-disk shape of `tasks.json`. */
export interface TaskFile {
  version: 1;
  tasks: WorkTask[];
}

/**
 * The agent a manager runs. Open (`AgentId`), not an enumeration: which agents
 * exist is a runtime fact — `agentbox agent add` registers more — and the API's
 * accept-list is the hub's request validator, not this type.
 */
export type ManagerAgent = AgentId;

/**
 * `external` is a session the user runs in their own terminal — the hub only
 * observes it, through detection. `hub` is one the hub started (or resumed) in a
 * tmux session it owns, so it can also be attached to and stopped.
 */
export type ManagerKind = 'external' | 'hub';

/**
 * A manager is a HOST agent session that orchestrates boxes: many per workspace.
 * It is registered when the `agentbox` CLI runs inside it (detection), or when
 * the hub starts one.
 */
export interface ManagerRecord {
  /** 16 hex, random: a hub-run manager has no session id until it is detected. */
  id: string;
  workspaceId: string;
  agent: ManagerAgent;
  kind: ManagerKind;
  /** Realpath of the folder the session runs in — where a resume must run. */
  cwd: string;
  /** Claude session uuid / codex thread uuid. */
  sessionId?: string;
  /** Cached first-turn title, scraped lazily from the agent's own store. */
  title?: string;
  /** `os.hostname()` of the process; a pid is only probed when this matches the hub's. */
  host?: string;
  /** External only. */
  pid?: number;
  /** Hub only. */
  tmuxSession?: string;
  /** Hub only: what was started, so a restart can reuse it. */
  argv?: string[];
  /** Boxes this session created. Reconciled on read: dropped when the box is gone. */
  boxIds: string[];
  /** Create jobs that have not produced a box yet; promoted to `boxIds` on read. */
  boxJobIds: string[];
  createdAt: string;
  lastSeenAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastExit?: number;
}

/** On-disk shape of `managers.json`. */
export interface ManagerFile {
  version: 1;
  managers: ManagerRecord[];
}

/** Derived from the process (tmux session or pid), never stored. */
export type ManagerStatus = 'running' | 'stopped';

export interface ManagerView extends Omit<ManagerRecord, 'argv'> {
  status: ManagerStatus;
  /** Ready-to-run attach command; only for a RUNNING hub-run manager. */
  attachCommand?: string;
  workspaceName: string;
  /** Tasks whose `managerId` is this manager. */
  taskCounts: { open: number; done: number };
}

/** One resumable agent session found in the host agent's own store. */
export interface HostSession {
  id: string;
  agent: string;
  title: string;
  updatedAt: string;
}

/** Roll-up of a box's assigned tasks, for a box row in a list. */
export interface BoxTaskSummary {
  total: number;
  done: number;
  /** The task the box is working now (or would work next); null when all done. */
  current: { id: string; title: string } | null;
}
