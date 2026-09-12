import type { ManagerExec } from '@agentbox/relay';
// The seams a domain backend slice is built from.
//
// `lib/hub-backend.ts` had grown past 3800 lines because every feature appended
// its methods there. A slice takes this narrow dependency object instead of the
// relay handle, so it can be unit-tested without a relay and reviewed without
// reading the box/provider code it does not touch.
import type { QueueJob } from '@agentbox/relay';

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
}
