// GET /api/v1/managers — every manager session the hub knows, across workspaces:
// running first, then the most recently seen. Filter with `?workspaceId=` and
// `?status=running|stopped`. `status` is derived from the process (tmux session
// or pid), never from the record.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { isManagerStatus } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const backend = backendOrNull();
  // Host-machine state; the hosted/Postgres path holds no managers.
  if (!backend) return ok({ managers: [] });
  const params = new URL(req.url).searchParams;
  const status = params.get('status');
  if (status !== null && !isManagerStatus(status)) {
    return fail('invalid_request', `unknown status ${status}`);
  }
  const workspaceId = params.get('workspaceId');
  const managers = await backend.listManagers({
    ...(status ? { status } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  });
  return ok({ managers });
}
