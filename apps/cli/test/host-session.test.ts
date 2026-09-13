import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeClaudeProjectsKey } from '@agentbox/sandbox-core';
import {
  detectHostSession,
  findAncestorPid,
  type HostSessionDeps,
} from '../src/lib/host-session.js';

// Every filesystem and process read goes through an injected seam: apps/cli tests
// have no HOME isolation, so nothing here may touch the real ~/.claude.
const HOME = '/home/u';
const ID = '5edc0ee0-ce9a-4e30-962d-bc630388d8bc';
const NOW = 1_800_000_000_000;

function transcriptDir(dir: string): string {
  return join(HOME, '.claude', 'projects', encodeClaudeProjectsKey(dir));
}

function deps(over: HostSessionDeps & { files?: Record<string, number> } = {}): HostSessionDeps {
  const files = over.files ?? {};
  return {
    home: HOME,
    cwd: '/work/repo',
    hostname: () => 'laptop',
    now: () => NOW,
    exists: (p) => p in files,
    listDir: (dir) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${dir}/`))
        .map((f) => f.slice(dir.length + 1)),
    mtimeMs: (p) => files[p],
    ps: () => undefined,
    ...over,
  };
}

describe('detectHostSession: claude', () => {
  it('uses the env session id when its transcript exists, with CLAUDE_PID', () => {
    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const hint = detectHostSession(
      deps({
        env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: ID, CLAUDE_PID: '4321' },
        files,
      }),
    );
    expect(hint).toEqual({
      agent: 'claude',
      sessionId: ID,
      cwd: '/work/repo',
      pid: 4321,
      host: 'laptop',
    });
  });

  it('walks up to the folder the session was started in', () => {
    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const hint = detectHostSession(
      deps({ cwd: '/work/repo/packages/a', env: { CLAUDE_CODE_SESSION_ID: ID }, files }),
    );
    expect(hint?.cwd).toBe('/work/repo');
  });

  it("falls back to the one recent session when the env id is a subagent's", () => {
    const dir = transcriptDir('/work/repo');
    const files = {
      [join(dir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')]: NOW - 60_000,
      [join(dir, 'agent-xyz.jsonl')]: NOW - 1_000,
      [join(dir, 'old.jsonl')]: NOW - 60 * 60_000,
    };
    const hint = detectHostSession(deps({ env: { CLAUDE_CODE_SESSION_ID: 'subagent-id' }, files }));
    expect(hint?.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
  });

  it('sends nothing when two sessions in the folder are recent', () => {
    const dir = transcriptDir('/work/repo');
    const files = { [join(dir, 'a.jsonl')]: NOW - 1_000, [join(dir, 'b.jsonl')]: NOW - 2_000 };
    expect(detectHostSession(deps({ env: { CLAUDECODE: '1' }, files }))).toBeUndefined();
  });

  it('passes a valid AGENTBOX_MANAGER hint and drops a malformed one', () => {
    const files = { [join(transcriptDir('/work/repo'), `${ID}.jsonl`)]: NOW };
    const env = { CLAUDE_CODE_SESSION_ID: ID };
    expect(
      detectHostSession(deps({ env: { ...env, AGENTBOX_MANAGER: '0123456789abcdef' }, files }))
        ?.managerId,
    ).toBe('0123456789abcdef');
    expect(
      detectHostSession(deps({ env: { ...env, AGENTBOX_MANAGER: '--evil' }, files })),
    ).not.toHaveProperty('managerId');
  });
});

describe('detectHostSession: codex and refusals', () => {
  it('reads CODEX_THREAD_ID and finds the pid from the nearest codex ancestor', () => {
    const tree: Record<number, { ppid: number; comm: string }> = {
      500: { ppid: 400, comm: '/bin/zsh' },
      400: { ppid: 300, comm: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex' },
      300: { ppid: 1, comm: 'node' },
    };
    const hint = detectHostSession(
      deps({
        env: { CODEX_THREAD_ID: '01a09ad5-8f51-7ec0-b8f4-2daa8be67500' },
        ppid: 500,
        ps: (pid) => tree[pid],
      }),
    );
    expect(hint).toMatchObject({ agent: 'codex', pid: 400, cwd: '/work/repo' });
  });

  it('has no pid when ps is not permitted (the codex sandbox), and still names the session', () => {
    const hint = detectHostSession(
      deps({ env: { CODEX_THREAD_ID: '01a09ad5-8f51-7ec0-b8f4-2daa8be67500' }, ppid: 500 }),
    );
    expect(hint).toMatchObject({ agent: 'codex' });
    expect(hint).not.toHaveProperty('pid');
  });

  it('refuses inside a box and outside any agent session', () => {
    expect(
      detectHostSession(deps({ env: { CODEX_THREAD_ID: 'x', AGENTBOX_RELAY_URL: 'http://r' } })),
    ).toBeUndefined();
    expect(detectHostSession(deps({ env: {} }))).toBeUndefined();
  });

  it('stops the ancestor walk at the time budget', () => {
    let t = 0;
    const ps = (pid: number): { ppid: number; comm: string } => {
      t += 600;
      return { ppid: pid + 1, comm: 'sh' };
    };
    expect(findAncestorPid('codex', 10, ps, () => t)).toBeUndefined();
    expect(t).toBeLessThanOrEqual(1200);
  });
});
