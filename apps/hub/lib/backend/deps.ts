import type { ManagerExec } from '@agentbox/relay';
// The seams a domain backend slice is built from.
//
// `lib/hub-backend.ts` had grown past 3800 lines because every feature appended
// its methods there. A slice takes this narrow dependency object instead of the
// relay handle, so it can be unit-tested without a relay and reviewed without
// reading the box/provider code it does not touch.
import type { QueueJob, ReconcileContext } from '@agentbox/relay';

export interface BackendDeps {
  /**
   * How the manager's tmux commands are run. Present only so a test can drive
   * the start path without spawning anything: a guard regression in
   * `startManager` would otherwise launch a real coding agent on whoever's
   * machine is running the suite. Production leaves it unset and the relay uses
   * execa.
   */
  managerExec?: ManagerExec;
  /**
   * Fire the hub's live-update fan-out (`/api/events` emits `change`). Called
   * after every mutation so an open UI refetches instead of waiting for its
   * 15s heartbeat.
   */
  notify(): void;
  /**
   * Ids of boxes that exist right now: this machine's local records UNION the
   * Store's registrations. The union matters on a control box, where a PC's
   * cloud box is registered but has no local record — keying off local state
   * alone would unassign its tasks on every read.
   */
  liveBoxIds(): Promise<Set<string>>;
  /** The local create queue, for resolving a task's pending create job. */
  jobs(): Promise<QueueJob[]>;
  /**
   * The hub's own hostname and pid probe. A manager's pid is only probed when it
   * was reported from this host; tests pin both so the status matrix does not
   * depend on the machine running the suite.
   */
  hostname?: () => string;
  isPidAlive?: (pid: number) => boolean;
  /** `ps -o lstart=` of a pid; faked in tests like the pid probe. */
  processStartTime?: (pid: number) => Promise<string | undefined>;
}

/**
 * The box/job facts reconciliation needs. Both are whole-fleet listings (a
 * docker inspect per box, plus every queue manifest), so a call that reconciles
 * several workspaces resolves them ONCE and hands the same snapshot down.
 */
export async function reconcileContext(deps: BackendDeps): Promise<ReconcileContext> {
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
