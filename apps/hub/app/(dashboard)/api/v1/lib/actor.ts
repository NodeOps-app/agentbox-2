// Who is calling, for the timeline. The CLI sends `X-AgentBox-Session:
// <agent>:<sessionId>` when it runs inside a host agent session; the hub resolves
// that to a registered manager (no write) and stamps the manager's current turn.
// No header — the tray, the web UI, a plain script — is a human.
import type { HubBackend, TimelineMeta } from '@/lib/boxes/backend-types';
import type { TimelineStamp } from '@/lib/boxes/types';

export const SESSION_HEADER = 'x-agentbox-session';

const SESSION_VALUE_RE = /^([a-z0-9][a-z0-9_-]{0,31}):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

const HUMAN: TimelineStamp = { actor: 'human' };

export async function sessionActor(
  req: Request,
  backend: Pick<HubBackend, 'timelineStamp'>,
  wsId?: string,
): Promise<TimelineStamp> {
  const ref = sessionRef(req);
  if (!ref) return HUMAN;
  const stamp = await backend.timelineStamp(ref, wsId).catch(() => undefined);
  return stamp ?? HUMAN;
}

function sessionRef(req: Request): { agent: string; sessionId: string } | undefined {
  const raw = req.headers.get(SESSION_HEADER)?.trim();
  const m = raw ? SESSION_VALUE_RE.exec(raw) : null;
  return m ? { agent: m[1]!, sessionId: m[2]! } : undefined;
}

/**
 * With `wsId`, the caller resolved to a manager of that workspace. Without one
 * (box and manager routes) only the session is carried: the backend learns the
 * workspace from the box or manager and resolves it there, so a manager of
 * another workspace is never stamped into this one's log.
 */
export async function timelineMeta(
  req: Request,
  backend: Pick<HubBackend, 'timelineStamp'>,
  opts: { wsId?: string; note?: string } = {},
): Promise<TimelineMeta> {
  const note = opts.note ? { note: opts.note } : {};
  if (opts.wsId === undefined) {
    const session = sessionRef(req);
    return { ...(session ? { session } : { stamp: HUMAN }), ...note };
  }
  return { stamp: await sessionActor(req, backend, opts.wsId), ...note };
}
