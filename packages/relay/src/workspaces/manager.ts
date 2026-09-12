import { open, readdir, readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import { encodeClaudeProjectsKey } from '@agentbox/sandbox-core';
import {
  managerExitFile,
  managerFile,
  resolveWorkspaceDir,
  workspaceDir,
} from './workspace-store.js';
import type { HostSession, ManagerAgent, ManagerRecord, ManagerView } from './types.js';

/** Seam for every tmux call, so tests assert argv without a terminal. */
export type ManagerExec = (
  file: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ exitCode?: number | undefined }>;

const defaultExec: ManagerExec = (file, args, opts) => execa(file, args, opts);

/** Read at most this much of a transcript when scraping its first user turn. */
const SESSION_HEAD_BYTES = 64 * 1024;
const SESSION_TITLE_MAX = 120;
const SESSION_LIST_MAX = 50;

/**
 * The one agent whose host session store we can read and whose resume flag we
 * have verified. Everything else reports `supported: false` rather than offering
 * a session it would silently fail to resume.
 */
export const RESUMABLE_MANAGER_AGENT = 'claude';

export function managerSessionName(wsId: string): string {
  return `agentbox-manager-${wsId}`;
}

/**
 * `=name` is tmux's exact-match prefix. Without it `has-session -t foo` matches
 * any session whose name STARTS with foo, so two workspaces whose ids share a
 * prefix would report each other's manager as running.
 */
function exactTarget(session: string): string {
  return `=${session}`;
}

export function managerAttachCommand(wsId: string): string {
  return `tmux attach -t ${exactTarget(managerSessionName(wsId))}`;
}

/**
 * The agent's argv: its binary, plus a resume flag when the caller named a
 * session. Only claude's resume spelling is verified, so a sessionId for any
 * other agent is refused upstream rather than guessed at here.
 */
export function buildManagerArgv(agent: ManagerAgent, sessionId?: string): string[] {
  if (agent === RESUMABLE_MANAGER_AGENT && sessionId) return [agent, '--resume', sessionId];
  return [agent];
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

/**
 * The script the login shell runs. The env rides HERE rather than on `tmux -e`
 * so this works on any tmux version and leaks nothing into other sessions; the
 * trailing capture records the agent's exit code, which is the only trace left
 * once the session is gone.
 */
export function buildManagerShellScript(opts: {
  argv: string[];
  env: Record<string, string>;
  exitFile: string;
}): string {
  const exports = Object.entries(opts.env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('; ');
  return `${exports}; ${shellJoin(opts.argv)}; __agentbox_rc=$?; printf %s "$__agentbox_rc" > ${shellQuote(opts.exitFile)}; exit $__agentbox_rc`;
}

/**
 * The user's login shell. Load-bearing: the hub is a daemon (launchd / the tray)
 * with none of the user's PATH, so a bare `claude` would not resolve.
 */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env['SHELL']) return env['SHELL'];
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export async function tmuxAvailable(exec: ManagerExec = defaultExec): Promise<boolean> {
  try {
    await exec('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

export async function tmuxSessionExists(
  session: string,
  exec: ManagerExec = defaultExec,
): Promise<boolean> {
  try {
    await exec('tmux', ['has-session', '-t', exactTarget(session)]);
    return true;
  } catch {
    return false;
  }
}

async function managerPaths(wsId: string, root?: string): Promise<{ rec: string; exit: string }> {
  const dir = (await resolveWorkspaceDir(wsId)) ?? workspaceDir(wsId, root);
  return { rec: managerFile(dir), exit: managerExitFile(dir) };
}

export async function readManager(wsId: string): Promise<ManagerRecord | null> {
  try {
    const { rec } = await managerPaths(wsId);
    return JSON.parse(await readFile(rec, 'utf8')) as ManagerRecord;
  } catch {
    return null;
  }
}

export async function writeManager(wsId: string, record: ManagerRecord): Promise<void> {
  const { rec } = await managerPaths(wsId, record.cwd);
  await mkdir(rec.slice(0, rec.lastIndexOf('/')), { recursive: true });
  const tmp = `${rec}.tmp.${String(process.pid)}.${Date.now().toString(36)}`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  await rename(tmp, rec);
}

async function readLastExit(wsId: string): Promise<number | undefined> {
  try {
    const { exit } = await managerPaths(wsId);
    const raw = (await readFile(exit, 'utf8')).trim();
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

/** Live view: the record plus whether its tmux session is actually up. */
export async function managerView(
  wsId: string,
  exec: ManagerExec = defaultExec,
): Promise<ManagerView> {
  const session = managerSessionName(wsId);
  const base = {
    workspaceId: wsId,
    tmuxSession: session,
    attachCommand: managerAttachCommand(wsId),
  };
  const record = await readManager(wsId);
  if (!record) return { ...base, status: 'never' };
  const running = await tmuxSessionExists(session, exec);
  if (running) {
    // Drop any previous run's ending rather than reporting a LIVE session with a
    // `stoppedAt` next to it, which a UI would render as contradictory state.
    const live = { ...record };
    delete live.stoppedAt;
    delete live.lastExit;
    return { ...base, ...live, status: 'running' };
  }
  const lastExit = record.lastExit ?? (await readLastExit(wsId));
  return {
    ...base,
    ...record,
    status: 'stopped',
    ...(lastExit === undefined ? {} : { lastExit }),
  };
}

export interface StartManagerSessionInput {
  wsId: string;
  root: string;
  agent: ManagerAgent;
  argv: string[];
  sessionId?: string;
  exec?: ManagerExec;
  env?: NodeJS.ProcessEnv;
}

/**
 * Start the manager in a detached tmux session on the hub's own machine.
 *
 * The session is the process's home: a client attaches to it instead of the hub
 * proxying a PTY, which is what lets the CLI, the tray and a plain terminal all
 * reach the same running agent.
 */
export async function startManagerSession(input: StartManagerSessionInput): Promise<ManagerRecord> {
  const exec = input.exec ?? defaultExec;
  const session = managerSessionName(input.wsId);
  const { exit } = await managerPaths(input.wsId, input.root);
  // A stale exit code from the previous run would be reported as this run's.
  await rm(exit, { force: true }).catch(() => {});
  const script = buildManagerShellScript({
    argv: input.argv,
    env: { AGENTBOX_WORKSPACE: input.wsId, AGENTBOX_MANAGER: '1' },
    exitFile: exit,
  });
  // TMUX/TMUX_PANE would make tmux refuse to nest when the hub itself was
  // started from inside a tmux pane.
  const env = { ...(input.env ?? process.env) };
  delete env['TMUX'];
  delete env['TMUX_PANE'];
  await exec(
    'tmux',
    ['new-session', '-d', '-s', session, '-c', input.root, '--', loginShell(env), '-lc', script],
    { env },
  );
  const record: ManagerRecord = {
    agent: input.agent,
    argv: input.argv,
    cwd: input.root,
    tmuxSession: session,
    startedAt: new Date().toISOString(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  await writeManager(input.wsId, record);
  return record;
}

/** Kill the manager session. Idempotent: a session that is already gone is fine. */
export async function stopManagerSession(
  wsId: string,
  exec: ManagerExec = defaultExec,
): Promise<ManagerRecord | null> {
  const session = managerSessionName(wsId);
  await exec('tmux', ['kill-session', '-t', exactTarget(session)]).catch(() => {});
  const record = await readManager(wsId);
  if (!record) return null;
  const lastExit = await readLastExit(wsId);
  const next: ManagerRecord = {
    ...record,
    stoppedAt: new Date().toISOString(),
    ...(lastExit === undefined ? {} : { lastExit }),
  };
  await writeManager(wsId, next);
  return next;
}

/** First user turn of a transcript, as a one-line title. */
function titleFromTranscript(head: string): string {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a truncated last line is expected: we only read a head
    }
    const rec = row as { type?: string; message?: { content?: unknown } };
    if (rec.type !== 'user') continue;
    const content = rec.message?.content;
    let text: string | null = null;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      const block = content.find(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
      );
      if (block) text = block.text;
    }
    if (!text) continue;
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat || flat.startsWith('<')) continue; // skip command/system-reminder wrappers
    return flat.length > SESSION_TITLE_MAX ? `${flat.slice(0, SESSION_TITLE_MAX - 1)}…` : flat;
  }
  return '(untitled)';
}

/**
 * Resumable agent sessions for a folder, read from the agent's OWN store — the
 * manager picker offers "continue where you left off" without the agent running.
 *
 * Only claude is supported today; the others' on-disk session formats are not
 * verified, and offering a session we cannot actually resume is worse than
 * offering none.
 */
export async function listResumableHostSessions(
  root: string,
  agent: string = RESUMABLE_MANAGER_AGENT,
  home: string = homedir(),
): Promise<{ agent: string; supported: boolean; sessions: HostSession[] }> {
  if (agent !== RESUMABLE_MANAGER_AGENT) return { agent, supported: false, sessions: [] };
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectsKey(root));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { agent, supported: true, sessions: [] };
  }
  const rows: { session: HostSession; mtime: number }[] = [];
  for (const name of names) {
    // `agent-*.jsonl` are subagent transcripts; they are not resumable sessions.
    if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
    const file = join(dir, name);
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    let head = '';
    try {
      const fh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(SESSION_HEAD_BYTES);
        const { bytesRead } = await fh.read(buf, 0, SESSION_HEAD_BYTES, 0);
        head = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    rows.push({
      session: {
        id: basename(name, '.jsonl'),
        agent,
        title: titleFromTranscript(head),
        updatedAt: new Date(mtime).toISOString(),
      },
      mtime,
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return {
    agent,
    supported: true,
    sessions: rows.slice(0, SESSION_LIST_MAX).map((r) => r.session),
  };
}
