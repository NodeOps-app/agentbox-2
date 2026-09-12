// GET /api/v1/tasks — tasks across every workspace, filterable by
// `?workspaceId=`, `?projectId=`, `?boxId=`, `?status=`. The cross-workspace
// read a fleet view needs: the per-workspace route answers one list, this one
// answers "what is assigned to this box" without knowing which workspace owns it.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { isTaskStatus } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const backend = backendOrNull();
  // Host-machine state; the hosted/Postgres path holds no workspaces.
  if (!backend) return ok({ tasks: [] });

  const params = new URL(req.url).searchParams;
  const status = params.get('status');
  if (status !== null && !isTaskStatus(status)) {
    return fail('invalid_request', `unknown status ${status}`);
  }
  const tasks = await backend.listAllTasks({
    ...(status ? { status } : {}),
    ...(params.get('workspaceId') ? { workspaceId: params.get('workspaceId')! } : {}),
    ...(params.get('projectId') ? { projectId: params.get('projectId')! } : {}),
    ...(params.get('boxId') ? { boxId: params.get('boxId')! } : {}),
  });
  return ok({ tasks });
}
