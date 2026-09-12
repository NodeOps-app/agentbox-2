// GET    /api/v1/workspaces/:id/tasks/:taskId — one task.
// POST   /api/v1/workspaces/:id/tasks/:taskId — update it (title, description,
//   status, project scope, dependencies, external ref). `projectId: null` clears
//   the scope. POST rather than PATCH: this API has no PATCH anywhere.
// DELETE /api/v1/workspaces/:id/tasks/:taskId — remove it, and drop it from every
//   other task's `dependsOn`.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { parseTaskUpdate, readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; taskId: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id, taskId } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown task ${taskId}`);
  const task = await backend.getTask(id, taskId);
  if (!task) return fail('not_found', `unknown task ${taskId}`);
  return ok(task);
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id, taskId } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseTaskUpdate(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const res = await backend.updateTask(id, taskId, parsed.value);
  if (!res.ok) return failFromAction(res.error);
  return ok(res.task);
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const { id, taskId } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const res = await backend.removeTask(id, taskId);
  if (!res.ok) return failFromAction(res.error);
  return ok({ ok: true });
}
