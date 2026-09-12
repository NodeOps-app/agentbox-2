// POST /api/v1/workspaces/:id/manager/stop — kill the manager's tmux session.
// Idempotent: stopping a manager that already exited is not an error, and the
// record is kept so a restart can reuse its agent and session.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.stopManager(id);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.manager);
}
