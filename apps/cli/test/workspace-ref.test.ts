import { describe, expect, it } from 'vitest';
import { pickWorkspace } from '../src/lib/workspace-ref.js';
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
