// POST /api/v1/workspaces/:id/tasks/assign — point several tasks at one box (or
// at the create job that will become one). This is the bulk form the manager
// uses when it groups tasks into a box; `todo` tasks become `in_progress`.
import { backendOrNull } from '../../../../lib/backend';
import { timelineMeta } from '../../../../lib/actor';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { parseTaskAssign, readJson } from '../../../../lib/validate';

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
  const parsed = parseTaskAssign(parsedBody.value, { requireIds: true });
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const { ids, boxId, boxJobId, note } = parsed.value;
  const res = await backend.assignTasks(
    id,
    ids!,
    boxId ? { boxId } : { boxJobId: boxJobId! },
    await timelineMeta(req, backend, { wsId: id, note }),
  );
  if (!res.ok) return failFromAction(res.error);
  return ok({ tasks: res.tasks });
}
