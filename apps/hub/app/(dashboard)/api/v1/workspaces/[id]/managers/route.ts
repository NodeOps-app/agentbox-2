// GET /api/v1/workspaces/:id/managers — the workspace's manager sessions,
// running first, then the most recently seen.
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
  const managers = await backend.listWorkspaceManagers(id);
  if (!managers) return fail('not_found', `unknown workspace ${id}`);
  return ok({ managers });
}
