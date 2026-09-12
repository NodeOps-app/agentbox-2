// GET  /api/v1/workspaces/:id/tasks — the workspace's tasks in priority order,
//   filterable by `?status=`, `?projectId=`, `?boxId=`. Assignments are healed
//   against live boxes and create jobs on the way out.
// POST /api/v1/workspaces/:id/tasks — add a task.
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { isTaskStatus, parseTaskCreate, readJson } from '../../../lib/validate';
import type { TaskFilter } from '@/lib/boxes/backend-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown workspace ${id}`);

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  if (status !== null && !isTaskStatus(status)) {
    return fail('invalid_request', `unknown status ${status}`);
  }
  const filter: TaskFilter = {
    ...(status ? { status } : {}),
    ...(url.searchParams.get('projectId') ? { projectId: url.searchParams.get('projectId')! } : {}),
    ...(url.searchParams.get('boxId') ? { boxId: url.searchParams.get('boxId')! } : {}),
  };
  const tasks = await backend.listTasks(id, filter);
  if (tasks === null) return fail('not_found', `unknown workspace ${id}`);
  return ok({ tasks });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseTaskCreate(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.addTask(id, parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.task, 201);
}
