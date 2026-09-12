// POST /api/v1/workspaces/:id/rescan — re-discover the projects under the
// workspace root (a repo cloned into it after registration is invisible until
// this runs) and register any new one.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.rescanWorkspace(id);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.workspace);
}
