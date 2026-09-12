import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  buildManagerArgv,
  buildManagerShellScript,
  isResumableManagerAgent,
  listResumableHostSessions,
  loginShell,
  managerAttachCommand,
  managerSessionName,
  managerView,
  readManager,
  RESUMABLE_MANAGER_AGENTS,
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
  it('uses each resumable agent OWN resume spelling and otherwise runs the bare agent', () => {
    expect(buildManagerArgv('claude')).toEqual(['claude']);
    expect(buildManagerArgv('claude', 's1')).toEqual(['claude', '--resume', 's1']);
    // codex has no --resume flag: resuming is a subcommand.
    expect(buildManagerArgv('codex')).toEqual(['codex']);
    expect(buildManagerArgv('codex', 's1')).toEqual(['codex', 'resume', 's1']);
    // An agent with no verified spelling never gets a guessed one.
    expect(buildManagerArgv('opencode')).toEqual(['opencode']);
    expect(buildManagerArgv('opencode', 's1')).toEqual(['opencode']);
  });

  it('names the agents whose session store and resume argv are verified', () => {
    expect([...RESUMABLE_MANAGER_AGENTS]).toEqual(['claude', 'codex']);
    expect(isResumableManagerAgent('claude')).toBe(true);
    expect(isResumableManagerAgent('codex')).toBe(true);
    expect(isResumableManagerAgent('opencode')).toBe(false);
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
    // Two clients (the tray pane and a terminal) must not clamp the grid to the
    // smaller one. `window-size` is a window option, so the target carries the
    // `:` that selects the session's current window — a bare session target is
    // rejected with "no such window" and the setting is silently lost.
    expect(calls[1]?.args).toEqual([
      'set-option',
      '-w',
      '-t',
      `=agentbox-manager-${id}:`,
      'window-size',
      'latest',
    ]);
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
    expect(calls.at(-1)?.args).toEqual(['kill-session', '-t', `=agentbox-manager-${id}`]);
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
    expect(await listResumableHostSessions(root, 'opencode', home)).toEqual({
      agent: 'opencode',
      supported: false,
      sessions: [],
    });
  });
});

describe('listResumableHostSessions (flat rollout store)', () => {
  const MINE = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-8888-4777-8666-555555555555';
  const NAMED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const BIG = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const INJECTED = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
  const SYMLINKED = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';

  function rollout(cwd: string, lines: unknown[] = []): string {
    return (
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd } }),
        ...lines.map((l) => JSON.stringify(l)),
      ].join('\n') + '\n'
    );
  }

  /** A rollout store holding one session in `root` and one in another folder. */
  async function seedRollouts(opts: { index?: string } = {}): Promise<{
    home: string;
    root: string;
  }> {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-home-')));
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-ws-')));
    const dir = join(home, '.codex', 'sessions', '2026', '09', '07');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-09-07T09-34-40-${MINE}.jsonl`),
      rollout(root, [
        { payload: { type: 'message', role: 'developer', content: [{ text: 'system brief' }] } },
        {
          payload: { type: 'message', role: 'user', content: [{ text: '<recommended_plugins>' }] },
        },
        { payload: { type: 'message', role: 'user', content: [{ text: 'split   the\nbacklog' }] } },
      ]),
    );
    await writeFile(
      join(dir, `rollout-2026-09-07T09-38-53-${OTHER}.jsonl`),
      rollout('/somewhere/else', [
        { payload: { type: 'message', role: 'user', content: [{ text: 'not this one' }] } },
      ]),
    );
    await writeFile(
      join(dir, `rollout-2026-09-07T09-40-01-${NAMED}.jsonl`),
      rollout(root, [
        { payload: { type: 'message', role: 'user', content: [{ text: 'scraped title' }] } },
      ]),
    );
    // Neither a rollout nor a session id — both must be skipped, not crash.
    await writeFile(join(dir, 'rollout-2026-09-07T09-41-01-nope.jsonl'), '{}\n');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    if (opts.index !== undefined) {
      await writeFile(join(home, '.codex', 'session_index.jsonl'), opts.index);
    }
    const old = new Date(Date.now() - 86_400_000);
    await utimes(join(dir, `rollout-2026-09-07T09-40-01-${NAMED}.jsonl`), old, old);
    return { home, root };
  }

  it('keeps only the sessions whose recorded cwd is the workspace root', async () => {
    const { home, root } = await seedRollouts();
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.supported).toBe(true);
    // The id is the TRAILING uuid, not the timestamp prefix; newest first.
    expect(res.sessions.map((s) => s.id)).toEqual([MINE, NAMED]);
    expect(res.sessions.every((s) => s.agent === 'codex')).toBe(true);
  });

  it('scrapes the first real user turn when the store has no name for it', async () => {
    const { home, root } = await seedRollouts();
    const res = await listResumableHostSessions(root, 'codex', home);
    // The `<recommended_plugins>` wrapper is not what the user typed.
    expect(res.sessions[0]?.title).toBe('split the backlog');
    expect(res.sessions[1]?.title).toBe('scraped title');
  });

  it('prefers the name the agent indexed, unless it is a command', async () => {
    const { home, root } = await seedRollouts({
      // A BARE slash command, not the `<command-name>` wrapper: the wrapper is
      // already rejected for starting with `<`, so only this shape reaches the
      // slash guard and proves it is doing anything.
      index:
        [
          JSON.stringify({ id: MINE, thread_name: 'group the flaky tests' }),
          JSON.stringify({ id: NAMED, thread_name: '/clear' }),
        ].join('\n') + '\n',
    });
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions[0]?.title).toBe('group the flaky tests');
    expect(res.sessions[1]?.title).toBe('scraped title');
  });

  it('reads the newest rows of an index that has outgrown the read budget', async () => {
    // The index is append-only, so the rows a picker needs are at the END. A
    // reader that keeps the first megabyte resolves titles for exactly the
    // sessions nobody is looking for.
    const filler = Array.from({ length: 12_000 }, (_, i) =>
      JSON.stringify({ id: `filler-${i}`, thread_name: 'x'.repeat(80) }),
    );
    const { home, root } = await seedRollouts({
      index:
        [...filler, JSON.stringify({ id: MINE, thread_name: 'the newest name' })].join('\n') + '\n',
    });
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions[0]?.title).toBe('the newest name');
  });

  it('lists a session whose opening record is larger than the head budget', async () => {
    // `session_meta` carries the agent's instructions and every configured tool:
    // measured at 49 KB on a plain setup and growing with each MCP server. A
    // fixed-size head read silently drops the whole session, because that line
    // is the only place the folder is recorded.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '08');
    await mkdir(dir, { recursive: true });
    const huge = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: root, tools: 'z'.repeat(400_000) },
    });
    await writeFile(
      join(dir, `rollout-2026-09-08T10-00-00-${BIG}.jsonl`),
      [
        huge,
        JSON.stringify({
          payload: { type: 'message', role: 'user', content: [{ text: 'after the big record' }] },
        }),
      ].join('\n') + '\n',
    );
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toContain(BIG);
    expect(res.sessions.find((s) => s.id === BIG)?.title).toBe('after the big record');
  });

  it('ranks by last activity, not by the creation time in the filename', async () => {
    // A resumed session keeps appending to its ORIGINAL file, so the filename's
    // timestamp is creation time and says nothing about what is being worked on.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '07');
    const touched = new Date(Date.now() + 3_600_000);
    await utimes(join(dir, `rollout-2026-09-07T09-40-01-${NAMED}.jsonl`), touched, touched);
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toEqual([NAMED, MINE]);
  });

  it('does not name a session after context the agent injected as a user turn', async () => {
    // A repo's instructions file and the harness's own preambles arrive as
    // `role: 'user'` records, so a blind scrape names every session in a repo
    // after its AGENTS.md.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '09');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-09-09T10-00-00-${INJECTED}.jsonl`),
      rollout(root, [
        {
          payload: {
            type: 'message',
            role: 'user',
            content: [{ text: '# AGENTS.md instructions for /repo' }],
          },
        },
        {
          payload: {
            type: 'message',
            role: 'user',
            content: [{ text: 'The following is the agent history you are assessing.' }],
          },
        },
        {
          payload: {
            type: 'message',
            role: 'user',
            content: [{ text: 'what the user actually asked' }],
          },
        },
      ]),
    );
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.find((s) => s.id === INJECTED)?.title).toBe('what the user actually asked');
  });

  it('matches a rollout recorded under a symlinked spelling of the root', async () => {
    // macOS hands out `/var/folders/...` which is a symlink to `/private/var/...`,
    // so the path an agent recorded and the path the workspace stores can differ
    // character for character while naming the same folder.
    const { home, root } = await seedRollouts();
    const link = join(await realpath(await mkdtemp(join(tmpdir(), 'agentbox-link-'))), 'alias');
    await symlink(root, link);
    const dir = join(home, '.codex', 'sessions', '2026', '09', '10');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-09-10T10-00-00-${SYMLINKED}.jsonl`),
      rollout(link, [
        { payload: { type: 'message', role: 'user', content: [{ text: 'through the symlink' }] } },
      ]),
    );
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toContain(SYMLINKED);
  });

  it("skips the agent's own internal threads", async () => {
    // A store mixes real sessions with the agent's plumbing: threads that review
    // a command, threads a subagent ran. On a real store those were 49 of 71
    // files, none with a user turn to name it, and resuming one drops the user
    // inside the machinery.
    const { home, root } = await seedRollouts();
    const dir = join(home, '.codex', 'sessions', '2026', '09', '11');
    await mkdir(dir, { recursive: true });
    for (const [id, source] of [
      ['eeeeeeee-1111-4222-8333-444444444444', 'guardian_review'],
      ['ffffffff-1111-4222-8333-444444444444', 'subagent'],
    ] as const) {
      await writeFile(
        join(dir, `rollout-2026-09-11T10-00-00-${id}.jsonl`),
        [
          JSON.stringify({ type: 'session_meta', payload: { cwd: root, thread_source: source } }),
          JSON.stringify({
            payload: { type: 'message', role: 'user', content: [{ text: 'internal' }] },
          }),
        ].join('\n') + '\n',
      );
    }
    const res = await listResumableHostSessions(root, 'codex', home);
    expect(res.sessions.map((s) => s.id)).toEqual([MINE, NAMED]);
  });

  it('is supported-but-empty for a folder the agent never ran in', async () => {
    const { home } = await seedRollouts();
    expect(await listResumableHostSessions('/nowhere', 'codex', home)).toEqual({
      agent: 'codex',
      supported: true,
      sessions: [],
    });
  });
});
