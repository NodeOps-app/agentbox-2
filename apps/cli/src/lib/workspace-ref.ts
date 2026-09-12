/**
 * Which workspace a `agentbox workspace|tasks|manager` invocation is about.
 *
 * Resolution order, most explicit first:
 *   1. `--workspace <id|path>`
 *   2. `$AGENTBOX_WORKSPACE` — set inside the manager's own session, so the
 *      manager agent's `agentbox tasks …` calls need no flag
 *   3. the registered workspace containing the cwd (longest root wins)
 *
 * The listing comes from the hub, so a remote hub's workspaces resolve the same
 * way — with the caveat that its roots are ITS paths, which a local cwd will not
 * match. That is correct: the folder is on the hub's machine.
 */
import { findWorkspaceContaining } from '@agentbox/relay';
import type { HubApiClient, HubApiWorkspace } from '../control-plane/hub-api-client.js';

export class WorkspaceRefError extends Error {}

/** Pure: apply the resolution order to an already-fetched listing. */
export function pickWorkspace(
  workspaces: HubApiWorkspace[],
  opts: { ref?: string; env?: string; cwd: string },
): HubApiWorkspace | null {
  const explicit = opts.ref ?? opts.env;
  if (explicit) {
    const byId = workspaces.find((w) => w.id === explicit);
    if (byId) return byId;
    const normalized =
      explicit.length > 1 && explicit.endsWith('/') ? explicit.slice(0, -1) : explicit;
    const byRoot = workspaces.find((w) => w.root === normalized);
    if (byRoot) return byRoot;
    const byName = workspaces.filter((w) => w.name === explicit);
    // A name is a label, not a key: two workspaces can share one, and picking
    // either would silently act on the wrong folder.
    if (byName.length === 1) return byName[0]!;
    return null;
  }
  return findWorkspaceContaining(workspaces, opts.cwd);
}

/** Resolve, or throw a message that says how to fix it. */
export async function resolveWorkspace(
  client: HubApiClient,
  ref?: string,
): Promise<HubApiWorkspace> {
  const workspaces = await client.listWorkspaces();
  if (workspaces.length === 0) {
    throw new WorkspaceRefError(
      'no workspaces registered on this hub. Register one with `agentbox workspace add <path>`.',
    );
  }
  const env = process.env['AGENTBOX_WORKSPACE'];
  const picked = pickWorkspace(workspaces, {
    ...(ref ? { ref } : {}),
    ...(env ? { env } : {}),
    cwd: process.cwd(),
  });
  if (picked) return picked;
  if (ref ?? env) {
    throw new WorkspaceRefError(
      `no workspace matches "${ref ?? env ?? ''}". List them with \`agentbox workspace list\`.`,
    );
  }
  throw new WorkspaceRefError(
    `no registered workspace contains ${process.cwd()}. Pass --workspace <id|path>, or register this folder with \`agentbox workspace add\`.`,
  );
}
