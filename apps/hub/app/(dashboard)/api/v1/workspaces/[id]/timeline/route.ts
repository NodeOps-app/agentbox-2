// GET /api/v1/workspaces/:id/timeline — what happened in the workspace, newest
// first (`?before=<iso>&limit=`), plus the rows true right now (`live`) and, with
// `?since=<iso>`, a summary of what changed since then. A GitHub PR sync starts
// in the background when the last one is over a minute old; `github` says how it
// stands, and a new row it finds fires the usual change event.
import { backendOrNull } from '../../../lib/backend';
import { fail, ok } from '../../../lib/envelope';
import { parseTimelineQuery } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('not_found', `unknown workspace ${id}`);
  const parsed = parseTimelineQuery(new URL(req.url));
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const timeline = await backend.getTimeline(id, parsed.value);
  if (!timeline) return fail('not_found', `unknown workspace ${id}`);
  return ok(timeline);
}
