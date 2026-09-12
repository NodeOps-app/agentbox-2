// GET /api/v1/workspaces/:id/manager — the manager's live state. `status` is
// derived from the tmux session, not from the record, so a manager that exited
// on its own reads `stopped` without anything having to notice.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown workspace ${id}`);
  const manager = await backend.getManager(id);
  if (!manager) return fail('not_found', `unknown workspace ${id}`);
  return ok(manager);
}
