// POST /api/v1/workspaces/:id/tasks/:taskId/unassign — return the task to the
// backlog. Finished work is left finished; only an in-progress task reverts to
// todo.
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
  const res = await backend.unassignTasks(id, [taskId]);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.tasks[0]);
}
