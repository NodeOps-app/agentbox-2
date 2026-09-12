// POST /api/v1/workspaces/:id/manager/start — run a coding agent LOCALLY in the
// workspace folder, in a detached tmux session the hub owns. The session is the
// process's home: the CLI, the tray and a plain terminal all attach to the same
// one rather than the hub proxying a PTY.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { parseManagerStart, readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseManagerStart(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.startManager(id, parsed.value);
  if (!res.ok) {
    // A host without tmux cannot host a manager at all — that is an environment
    // gap on the hub's machine, not a bad request.
    if (res.error.startsWith('tmux is not installed')) {
      return fail('backend_unavailable', res.error);
    }
    return failFromAction(res.error);
  }
  return ok(res.manager);
}
