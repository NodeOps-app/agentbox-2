// POST /api/v1/managers/detect — register the host agent session a CLI call came
// from. Matched by (agent, sessionId), so repeating it refreshes one record. When
// no workspace contains `cwd`, one is created there, named after the folder:
// nobody declares a workspace before a session can manage boxes.
import { backendOrNull } from '../../lib/backend';
import { fail, failFromAction, ok } from '../../lib/envelope';
import { MANAGER_AGENT_NAMES, parseManagerDetect, readJson } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  // Any agent the registry knows that has a session (a `service` agent is a
  // daemon, never a manager). Unlike a start, an agent the hub host has not
  // installed is fine: the session being recorded runs on the caller's machine.
  const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
  const allowedAgents = sys
    ? sys
        .agents()
        .filter((a) => a.surface !== 'service')
        .map((a) => a.id)
    : MANAGER_AGENT_NAMES;
  const parsed = parseManagerDetect(parsedBody.value, allowedAgents);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.detectManager(parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok({ manager: res.manager, workspace: res.workspace }, res.created ? 201 : 200);
}
