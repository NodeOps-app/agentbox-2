// POST /api/v1/workspaces/:id/tasks/:taskId/done — mark the task finished.
import { backendOrNull } from '../../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; taskId: string }> },
): Promise<Response> {
  const { id, taskId } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.completeTask(id, taskId);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.task);
}
