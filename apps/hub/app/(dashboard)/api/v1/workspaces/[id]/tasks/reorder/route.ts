// POST /api/v1/workspaces/:id/tasks/reorder — set the whole priority order.
// `ids` must be an exact permutation of the workspace's tasks: a partial list
// would silently renumber the rest, and this order IS the priority the manager
// reads.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { parseTaskReorder, readJson } from '../../../../lib/validate';

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
  const parsed = parseTaskReorder(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.reorderTasks(id, parsed.value.ids);
  if (!res.ok) return failFromAction(res.error);
  return ok({ tasks: res.tasks });
}
