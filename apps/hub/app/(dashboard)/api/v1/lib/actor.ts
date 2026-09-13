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
  const raw = req.headers.get(SESSION_HEADER)?.trim();
  const m = raw ? SESSION_VALUE_RE.exec(raw) : null;
  if (!m) return HUMAN;
  const stamp = await backend
    .timelineStamp({ agent: m[1]!, sessionId: m[2]! }, wsId)
    .catch(() => undefined);
  return stamp ?? HUMAN;
}

export async function timelineMeta(
  req: Request,
  backend: Pick<HubBackend, 'timelineStamp'>,
  opts: { wsId?: string; note?: string } = {},
): Promise<TimelineMeta> {
  return {
    stamp: await sessionActor(req, backend, opts.wsId),
    ...(opts.note ? { note: opts.note } : {}),
  };
}
