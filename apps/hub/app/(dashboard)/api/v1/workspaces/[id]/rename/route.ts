// POST /api/v1/workspaces/:id/rename — set the workspace's display name.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { parseWorkspaceRename, readJson } from '../../../lib/validate';

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
  const parsed = parseWorkspaceRename(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.renameWorkspace(id, parsed.value.name);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.workspace);
}
