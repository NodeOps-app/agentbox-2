/**
 * Which workspace a `agentbox workspace|tasks|manager` invocation is about.
 *
 * Resolution order, most explicit first:
 *   1. `--workspace <id|path>`
 *   2. `$AGENTBOX_WORKSPACE` — set inside the manager's own session, so the
 *      manager agent's `agentbox tasks …` calls need no flag
 *   3. the registered workspace containing the cwd (longest root wins)
 *   4. inside a claude/codex session: the workspace registering that session
 *      creates at its folder
 *
 * The listing comes from the hub, so a remote hub's workspaces resolve the same
 * way — with the caveat that its roots are ITS paths, which a local cwd will not
 * match. That is correct: the folder is on the hub's machine.
 */
import { findWorkspaceContaining } from '@agentbox/relay';
import { detectHostSession, registerHostManager } from './host-session.js';
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
  return (await resolveWorkspaceAndManager(client, ref)).workspace;
}

/**
 * Resolve the workspace and, inside a host agent session, the manager that
 * session is registered as.
 *
 * With nothing registered for the cwd, a session is enough: registering it
 * creates the workspace at the session's folder, so nobody has to declare one
 * first. `register` also registers when a workspace was found, for a caller that
 * needs the manager id (a task added from inside a session belongs to it).
 */
export async function resolveWorkspaceAndManager(
  client: HubApiClient,
  ref?: string,
  opts: { register?: boolean } = {},
): Promise<{ workspace: HubApiWorkspace; managerId?: string }> {
  const workspaces = await client.listWorkspaces();
  const env = process.env['AGENTBOX_WORKSPACE'];
  const picked = pickWorkspace(workspaces, {
    ...(ref ? { ref } : {}),
    ...(env ? { env } : {}),
    cwd: process.cwd(),
  });
  if (!picked && (ref ?? env)) {
    throw new WorkspaceRefError(
      `no workspace matches "${ref ?? env ?? ''}". List them with \`agentbox workspace list\`.`,
    );
  }
  const hint = !picked || opts.register ? detectHostSession() : undefined;
  if (hint) {
    const registered = await registerHostManager(client, hint);
    if (registered) {
      return { workspace: picked ?? registered.workspace, managerId: registered.managerId };
    }
  }
  if (picked) return { workspace: picked };
  if (workspaces.length === 0) {
    throw new WorkspaceRefError(
      'no workspaces registered on this hub. Register one with `agentbox workspace add <path>`.',
    );
  }
  throw new WorkspaceRefError(
    `no registered workspace contains ${process.cwd()}. Pass --workspace <id|path>, or register this folder with \`agentbox workspace add\`.`,
  );
}
