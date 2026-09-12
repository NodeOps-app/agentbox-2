import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  buildManagerArgv,
  buildManagerShellScript,
  listResumableHostSessions,
  loginShell,
  managerAttachCommand,
  managerSessionName,
  managerView,
  readManager,
  startManagerSession,
  stopManagerSession,
  tmuxAvailable,
  tmuxSessionExists,
  type ManagerExec,
} from '../src/workspaces/index.js';

const noRegister = { register: async () => {} };

interface Call {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Records every tmux invocation; `fail` makes the named subcommand throw. */
function fakeExec(fail: string[] = []): { calls: Call[]; exec: ManagerExec } {
  const calls: Call[] = [];
  const exec: ManagerExec = async (file, args, opts) => {
    calls.push({ file, args, env: opts?.env });
    if (fail.includes(args[0] ?? '')) throw new Error(`${args[0] ?? ''} failed`);
    return { exitCode: 0 };
  };
  return { calls, exec };
}

async function makeWorkspace(): Promise<{ id: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-mgr-')));
  await mkdir(join(root, '.git'), { recursive: true });
  return { id: (await addWorkspace(root, {}, noRegister)).id, root };
}

beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox', 'workspaces'), { recursive: true, force: true });
});

describe('session naming', () => {
  it('derives the session and attach command from the workspace id', () => {
    expect(managerSessionName('abc123')).toBe('agentbox-manager-abc123');
    // `=` is tmux exact-match: without it a longer id sharing this prefix matches.
    expect(managerAttachCommand('abc123')).toBe('tmux attach -t =agentbox-manager-abc123');
  });
});

describe('buildManagerArgv', () => {
  it('resumes a claude session by id and otherwise runs the bare agent', () => {
    expect(buildManagerArgv('claude')).toEqual(['claude']);
    expect(buildManagerArgv('claude', 's1')).toEqual(['claude', '--resume', 's1']);
    expect(buildManagerArgv('codex')).toEqual(['codex']);
    expect(buildManagerArgv('opencode')).toEqual(['opencode']);
  });
});

describe('buildManagerShellScript', () => {
  it('exports the env, runs the agent and records its exit code', () => {
    const script = buildManagerShellScript({
      argv: ['claude', '--resume', 'a b'],
      env: { AGENTBOX_WORKSPACE: 'ws1', AGENTBOX_MANAGER: '1' },
      exitFile: '/tmp/ws/manager.exit',
    });
    expect(script).toContain("export AGENTBOX_WORKSPACE='ws1'");
    expect(script).toContain("export AGENTBOX_MANAGER='1'");
    expect(script).toContain("'claude' '--resume' 'a b'");
    expect(script).toContain("> '/tmp/ws/manager.exit'");
    expect(script).toContain('exit $__agentbox_rc');
  });

  it('quotes a single quote in an argument', () => {
    const script = buildManagerShellScript({
      argv: ['claude', "it's"],
      env: {},
      exitFile: '/tmp/x',
    });
    expect(script).toContain(`'it'\\''s'`);
  });
});

describe('loginShell', () => {
  it('prefers $SHELL and falls back per platform', () => {
    expect(loginShell({ SHELL: '/opt/fish' })).toBe('/opt/fish');
    expect(loginShell({})).toBe(process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  });
});

describe('tmux probes', () => {
  it('reports availability and exact session matching', async () => {
    const up = fakeExec();
    expect(await tmuxAvailable(up.exec)).toBe(true);
    expect(await tmuxSessionExists('s', up.exec)).toBe(true);
    expect(up.calls[1]?.args).toEqual(['has-session', '-t', '=s']);
    const down = fakeExec(['-V', 'has-session']);
    expect(await tmuxAvailable(down.exec)).toBe(false);
    expect(await tmuxSessionExists('s', down.exec)).toBe(false);
  });
});

describe('startManagerSession', () => {
  it('spawns a detached tmux session running the agent under a login shell', async () => {
    const { id, root } = await makeWorkspace();
    const { calls, exec } = fakeExec();
    const rec = await startManagerSession({
      wsId: id,
      root,
      agent: 'claude',
      argv: ['claude'],
      exec,
      env: { SHELL: '/bin/zsh', TMUX: '/tmp/sock,1,0', TMUX_PANE: '%3' },
    });
    const args = calls[0]!.args;
    expect(calls[0]!.file).toBe('tmux');
    expect(args.slice(0, 7)).toEqual([
      'new-session',
      '-d',
      '-s',
      `agentbox-manager-${id}`,
      '-c',
      root,
      '--',
    ]);
    expect(args.slice(7, 9)).toEqual(['/bin/zsh', '-lc']);
    expect(args[9]).toContain(`export AGENTBOX_WORKSPACE='${id}'`);
    // A hub started from inside tmux must not make tmux refuse to nest.
    expect(calls[0]!.env).not.toHaveProperty('TMUX');
    expect(calls[0]!.env).not.toHaveProperty('TMUX_PANE');
    expect(rec.cwd).toBe(root);
    expect(await readManager(id)).toMatchObject({ agent: 'claude', tmuxSession: rec.tmuxSession });
  });

  it('clears a previous run exit code', async () => {
    const { id, root } = await makeWorkspace();
    const { exec } = fakeExec();
    await startManagerSession({ wsId: id, root, agent: 'claude', argv: ['claude'], exec });
    await stopManagerSession(id, exec);
    await startManagerSession({ wsId: id, root, agent: 'claude', argv: ['claude'], exec });
    const view = await managerView(id, fakeExec(['has-session']).exec);
    expect(view.lastExit).toBeUndefined();
  });
});

describe('managerView', () => {
  it('is never before a start, running while the session is up, stopped after', async () => {
    const { id, root } = await makeWorkspace();
    const up = fakeExec();
    expect((await managerView(id, up.exec)).status).toBe('never');
    await startManagerSession({ wsId: id, root, agent: 'claude', argv: ['claude'], exec: up.exec });
    expect((await managerView(id, up.exec)).status).toBe('running');
    const down = fakeExec(['has-session']);
    const stopped = await managerView(id, down.exec);
    expect(stopped.status).toBe('stopped');
    expect(stopped.agent).toBe('claude');
    expect(stopped.attachCommand).toBe(managerAttachCommand(id));
  });
});

describe('stopManagerSession', () => {
  it('kills the session, stamps stoppedAt and keeps the record for a restart', async () => {
    const { id, root } = await makeWorkspace();
    const { calls, exec } = fakeExec();
    await startManagerSession({ wsId: id, root, agent: 'claude', argv: ['claude'], exec });
    const rec = await stopManagerSession(id, exec);
    expect(calls[1]?.args).toEqual(['kill-session', '-t', `=agentbox-manager-${id}`]);
    expect(rec?.stoppedAt).toBeTruthy();
    expect(rec?.agent).toBe('claude');
  });

  it('is a no-op when no manager was ever started', async () => {
    const { id } = await makeWorkspace();
    expect(await stopManagerSession(id, fakeExec(['kill-session']).exec)).toBeNull();
  });
});

describe('listResumableHostSessions', () => {
  async function seedSessions(): Promise<{ home: string; root: string }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-home-')));
    const root = '/Users/dev/code/app';
    const dir = join(home, '.claude', 'projects', '-Users-dev-code-app');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'aaa.jsonl'),
      [
        JSON.stringify({ type: 'summary' }),
        JSON.stringify({ type: 'user', message: { content: 'plan the v2 onboarding' } }),
      ].join('\n') + '\n',
    );
    await writeFile(
      join(dir, 'bbb.jsonl'),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'fix   flaky\ndetox tests' }] },
      }) + '\n',
    );
    // A subagent transcript, not a resumable session.
    await writeFile(
      join(dir, 'agent-ccc.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'sub' } }) + '\n',
    );
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const old = new Date(Date.now() - 86_400_000);
    await utimes(join(dir, 'bbb.jsonl'), old, old);
    return { home, root };
  }

  it('lists claude sessions newest first with a title from the first user turn', async () => {
    const { home, root } = await seedSessions();
    const res = await listResumableHostSessions(root, 'claude', home);
    expect(res.supported).toBe(true);
    expect(res.sessions.map((s) => s.id)).toEqual(['aaa', 'bbb']);
    expect(res.sessions[0]?.title).toBe('plan the v2 onboarding');
    expect(res.sessions[1]?.title).toBe('fix flaky detox tests');
  });

  it('is supported-but-empty for a folder claude never ran in', async () => {
    const { home } = await seedSessions();
    const res = await listResumableHostSessions('/nowhere', 'claude', home);
    expect(res).toEqual({ agent: 'claude', supported: true, sessions: [] });
  });

  it('declares the other agents unsupported rather than guessing', async () => {
    const { home, root } = await seedSessions();
    expect(await listResumableHostSessions(root, 'codex', home)).toEqual({
      agent: 'codex',
      supported: false,
      sessions: [],
    });
  });
});
