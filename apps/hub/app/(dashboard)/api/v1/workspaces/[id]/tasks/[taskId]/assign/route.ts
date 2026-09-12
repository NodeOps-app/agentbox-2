// POST /api/v1/workspaces/:id/tasks/:taskId/assign — point one task at a box
// (`{ boxId }`) or at the create job that will become one (`{ boxJobId }`).
import { backendOrNull } from '../../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../../lib/envelope';
import { parseTaskAssign, readJson } from '../../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; taskId: string }> },
): Promise<Response> {
  const { id, taskId } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseTaskAssign(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const { boxId, boxJobId } = parsed.value;
  const res = await backend.assignTasks(id, [taskId], boxId ? { boxId } : { boxJobId: boxJobId! });
  if (!res.ok) return failFromAction(res.error);
  return ok(res.tasks[0]);
}
