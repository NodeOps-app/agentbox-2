// GET    /api/v1/managers/:id — one manager with its live status.
// DELETE /api/v1/managers/:id — forget it. Refused (409) while it runs: the
//   record is the only handle on that session and the boxes it made.
import { backendOrNull } from '../../lib/backend';
import { fail, failFromAction, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown manager ${id}`);
  const manager = await backend.getManager(id);
  if (!manager) return fail('not_found', `unknown manager ${id}`);
  return ok(manager);
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.removeManager(id);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
