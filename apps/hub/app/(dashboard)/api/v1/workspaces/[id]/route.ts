// GET    /api/v1/workspaces/:id — one workspace with its task counts + manager state.
// DELETE /api/v1/workspaces/:id — unregister it. The folder, its projects and
//   their boxes are untouched; only the workspace record and its tasks go.
//   409 while one of its managers runs, unless `?force=1`.
import { backendOrNull } from '../../lib/backend';
import { fail, failFromAction, ok } from '../../lib/envelope';
import { isForce } from '../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown workspace ${id}`);
  const ws = await backend.getWorkspace(id);
  if (!ws) return fail('not_found', `unknown workspace ${id}`);
  return ok(ws);
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.removeWorkspace(id, { force: isForce(req) });
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
