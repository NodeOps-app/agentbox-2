// POST /api/v1/managers/:id/stop — kill a hub-run manager's tmux session.
// Idempotent, and the record is kept so it can be resumed. An external manager
// is the user's own terminal process, which the hub never signals (409 while it runs).
import { backendOrNull } from '../../../lib/backend';
import { timelineMeta } from '../../../lib/actor';
import { fail, failFromAction, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.stopManager(id, await timelineMeta(req, backend));
  if (!res.ok) return failFromAction(res.error);
  return ok(res.manager);
}
