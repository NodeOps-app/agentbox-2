import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/sandbox-core';
import type { AgentId } from '@agentbox/core';

/** Root of the workspace registry: one directory per workspace, keyed by its id. */
export const WORKSPACES_DIR = join(STATE_DIR, 'workspaces');

/**
 * A workspace is a host FOLDER that groups one or more projects and owns a task
 * list plus (optionally) a manager agent session. It is deliberately not a
 * project: a project is one repo/agentbox.yaml root a box is built from, while a
 * workspace is the unit a human (and the manager) plans across.
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

/** What was started, so a restart can reuse the same agent and session. */
export interface ManagerRecord {
  agent: ManagerAgent;
  argv: string[];
  cwd: string;
  sessionId?: string;
  tmuxSession: string;
  startedAt: string;
  stoppedAt?: string;
  lastExit?: number;
}

/**
 * `never` = no manager was ever started here (no record), which a UI renders as
 * the empty state; `stopped` = a record exists but its tmux session is gone.
 */
export type ManagerStatus = 'running' | 'stopped' | 'never';

export interface ManagerView {
  workspaceId: string;
  status: ManagerStatus;
  tmuxSession: string;
  /** Ready-to-run attach command, so a GUI can show it without knowing tmux. */
  attachCommand: string;
  agent?: ManagerAgent;
  argv?: string[];
  cwd?: string;
  sessionId?: string;
  startedAt?: string;
  stoppedAt?: string;
  lastExit?: number;
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
