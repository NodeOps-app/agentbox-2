import { describe, expect, it, vi } from 'vitest';
import { pickWorkspace, resolveWorkspaceAndManager } from '../src/lib/workspace-ref.js';
import type { HostSessionHint } from '../src/lib/host-session.js';
import type { HubApiWorkspace } from '../src/control-plane/hub-api-client.js';

function ws(over: Partial<HubApiWorkspace> & { id: string; root: string }): HubApiWorkspace {
  return {
    name: over.id,
    projectIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const all = [
  ws({ id: 'w1', root: '/code/store', name: 'store' }),
  ws({ id: 'w2', root: '/code/store/inner', name: 'inner' }),
  ws({ id: 'w3', root: '/code/storefront', name: 'storefront' }),
];

describe('pickWorkspace', () => {
  it('matches an explicit ref by id, then by root, then by unique name', () => {
    expect(pickWorkspace(all, { ref: 'w2', cwd: '/elsewhere' })?.id).toBe('w2');
    expect(pickWorkspace(all, { ref: '/code/storefront', cwd: '/elsewhere' })?.id).toBe('w3');
    expect(pickWorkspace(all, { ref: '/code/storefront/', cwd: '/elsewhere' })?.id).toBe('w3');
    expect(pickWorkspace(all, { ref: 'inner', cwd: '/elsewhere' })?.id).toBe('w2');
  });

  it('refuses an ambiguous name rather than guessing a folder', () => {
    const dupes = [
      ws({ id: 'a', root: '/x/app', name: 'app' }),
      ws({ id: 'b', root: '/y/app', name: 'app' }),
    ];
    expect(pickWorkspace(dupes, { ref: 'app', cwd: '/x/app' })).toBeNull();
  });

  it('prefers the flag over the env var', () => {
    expect(pickWorkspace(all, { ref: 'w1', env: 'w2', cwd: '/elsewhere' })?.id).toBe('w1');
  });

  it('falls back to the env var, then to the cwd containment', () => {
    expect(pickWorkspace(all, { env: 'w3', cwd: '/code/store' })?.id).toBe('w3');
    expect(pickWorkspace(all, { cwd: '/code/store/pkg' })?.id).toBe('w1');
    // The most specific root wins.
    expect(pickWorkspace(all, { cwd: '/code/store/inner/pkg' })?.id).toBe('w2');
    // Segment boundary: /code/storefront is not inside /code/store.
    expect(pickWorkspace(all, { cwd: '/code/storefront/pkg' })?.id).toBe('w3');
  });

  it('is null when nothing matches', () => {
    expect(pickWorkspace(all, { cwd: '/somewhere/else' })).toBeNull();
    expect(pickWorkspace(all, { ref: 'nope', cwd: '/code/store' })).toBeNull();
  });
});

describe('resolveWorkspaceAndManager', () => {
  const hint = (cwd: string): HostSessionHint => ({
    agent: 'claude',
    sessionId: '5edc0ee0-ce9a-4e30-962d-bc630388d8bc',
    cwd,
    host: 'laptop',
  });
  // Every seam injected: nothing reads the real env, cwd or ~/.claude.
  function client(detected?: HubApiWorkspace) {
    return {
      listWorkspaces: vi.fn(async () => all),
      detectManager: vi.fn(async () => ({
        manager: { id: 'm1' } as never,
        workspace: detected ?? all[0]!,
      })),
    };
  }

  it('skips detection for an explicit workspace the session does not live in', async () => {
    const c = client();
    const res = await resolveWorkspaceAndManager(
      c,
      'w3',
      { register: true },
      { env: {}, cwd: '/code/storefront', detect: () => hint('/elsewhere/repo') },
    );
    expect(res).toEqual({ workspace: all[2] });
    expect(c.detectManager).not.toHaveBeenCalled();
  });

  it('attaches the manager when the session lives in the explicit workspace', async () => {
    const c = client(all[2]);
    const res = await resolveWorkspaceAndManager(
      c,
      'w3',
      { register: true },
      { env: {}, cwd: '/tmp', detect: () => hint('/code/storefront/pkg') },
    );
    expect(res).toEqual({ workspace: all[2], managerId: 'm1' });
  });

  it('drops a manager the hub keeps in another workspace', async () => {
    const c = client(all[1]);
    const res = await resolveWorkspaceAndManager(
      c,
      undefined,
      { register: true },
      { env: {}, cwd: '/code/store', detect: () => hint('/code/store') },
    );
    expect(c.detectManager).toHaveBeenCalled();
    expect(res).toEqual({ workspace: all[0] });
  });

  it('takes the workspace a detect created when none was picked', async () => {
    const created = ws({ id: 'w9', root: '/new/repo' });
    const c = client(created);
    const res = await resolveWorkspaceAndManager(
      c,
      undefined,
      {},
      { env: {}, cwd: '/new/repo', detect: () => hint('/new/repo') },
    );
    expect(res).toEqual({ workspace: created, managerId: 'm1' });
  });
});
