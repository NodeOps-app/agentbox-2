import {
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises';
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
const UNTITLED_SESSION = '(untitled)';

/** Read at most this much of a session-title index (it grows without bound). */
const SESSION_INDEX_BYTES = 1024 * 1024;

/**
 * How many session files one listing may open. A store that is flat across every
 * project holds years of other folders' sessions, and the picker shows 50.
 */
const ROLLOUT_SCAN_MAX = 200;

/**
 * `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl` — the id is the TRAILING 36-char
 * dashed segment, matched explicitly so the date-time prefix cannot be read as one.
 */
const ROLLOUT_UUID_RE =
  /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/u;

/**
 * How each agent we can actually resume spells "continue this session". One
 * takes a flag, the other a SUBCOMMAND (`resume <id>`, verified against codex
 * 0.142.3 — it has no `--resume`), which is why this is a table and not a
 * shared suffix. An agent absent here reports `supported: false`: guessing a
 * spelling would start a FRESH session that looks resumed, which is worse than
 * offering none.
 */
const RESUME_ARGV: Record<string, (sessionId: string) => string[]> = {
  claude: (id) => ['--resume', id],
  codex: (id) => ['resume', id],
};

/** The agents whose host session store we can read AND whose resume argv is verified. */
export const RESUMABLE_MANAGER_AGENTS: readonly string[] = Object.keys(RESUME_ARGV);

export function isResumableManagerAgent(agent: string): boolean {
  return RESUMABLE_MANAGER_AGENTS.includes(agent);
}

/** What a picker opens on when the caller named no agent. */
const DEFAULT_RESUMABLE_AGENT: string = RESUMABLE_MANAGER_AGENTS[0] ?? 'claude';

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
 * The agent's argv: its binary, plus its own resume spelling when the caller
 * named a session. A sessionId for an agent with no verified spelling is
 * refused upstream rather than guessed at here.
 */
export function buildManagerArgv(agent: ManagerAgent, sessionId?: string): string[] {
  if (!sessionId) return [agent];
  const resume = RESUME_ARGV[agent];
  return resume ? [agent, ...resume(sessionId)] : [agent];
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
  // tmux sizes a session to its SMALLEST attached client by default, so a tray
  // pane and a terminal attached at once would clamp the agent's TUI to the
  // lesser grid (and redraw it on every attach). `latest` sizes to the most
  // recently active client instead. Best-effort: an old tmux without the option
  // must not fail a start that already succeeded.
  await exec('tmux', ['set-option', '-t', exactTarget(session), 'window-size', 'latest'], {
    env,
  }).catch(() => {});
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

/** Read at most `bytes` from the start of a file; `null` when it cannot be read. */
async function readHead(file: string, bytes: number): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * One line of text, trimmed to a title. `null` when it is not usable as one.
 *
 * `skipSlash` is for a name the agent DERIVED from a turn: a session whose first
 * turn was `/clear` is indexed under that literal, which names nothing.
 */
function asTitle(text: string, opts: { skipSlash?: boolean } = {}): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Command wrappers and system reminders are not what the user typed.
  if (!flat || flat.startsWith('<')) return null;
  if (opts.skipSlash && flat.startsWith('/')) return null;
  return flat.length > SESSION_TITLE_MAX ? `${flat.slice(0, SESSION_TITLE_MAX - 1)}…` : flat;
}

/** The first `text` block of a content array, whatever the block type is called. */
function firstTextBlock(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const { text } = block as { text?: unknown };
    if (typeof text === 'string' && text) return text;
  }
  return null;
}

/** Parse a JSONL head line by line; a truncated last line is expected. */
function* jsonlRows(head: string): Generator<unknown> {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

/** First user turn of a claude transcript, as a one-line title. */
function titleFromTranscript(head: string): string {
  for (const row of jsonlRows(head)) {
    const rec = row as { type?: string; message?: { content?: unknown } };
    if (rec.type !== 'user') continue;
    const text = firstTextBlock(rec.message?.content);
    const title = text === null ? null : asTitle(text);
    if (title) return title;
  }
  return UNTITLED_SESSION;
}

/**
 * First user turn of a rollout transcript, as a one-line title.
 *
 * A rollout records turns as `response_item` envelopes carrying an OpenAI-shaped
 * message (`payload.role`, `payload.content[].text`), and older writers emit an
 * `event_msg` / `user_message` instead — both are read here because a session
 * listing that silently shows "(untitled)" is indistinguishable from a bug.
 */
function titleFromRollout(head: string): string {
  for (const row of jsonlRows(head)) {
    const rec = row as {
      payload?: { type?: string; role?: string; content?: unknown; message?: unknown };
    };
    const payload = rec.payload;
    if (!payload) continue;
    let text: string | null = null;
    if (payload.role === 'user') text = firstTextBlock(payload.content);
    else if (payload.type === 'user_message' && typeof payload.message === 'string') {
      text = payload.message;
    }
    const title = text === null ? null : asTitle(text);
    if (title) return title;
  }
  return UNTITLED_SESSION;
}

/** Claude's store: one folder per project, one `<uuid>.jsonl` per session. */
async function listProjectTranscripts(
  root: string,
  agent: string,
  home: string,
): Promise<HostSession[]> {
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectsKey(root));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
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
    const head = await readHead(file, SESSION_HEAD_BYTES);
    if (head === null) continue;
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
  return sortAndCap(rows);
}

/**
 * The rollout store: `<home>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
 * FLAT across every project — the folder a session ran in is not in its path, so
 * it has to be read out of each file's first record.
 *
 * Ported from `packages/agent-codex/src/cli/teleport.ts` rather than imported:
 * `@agentbox/relay` does not depend on an agent package (and must not — the hub
 * loads no agent modules), and this is three small functions.
 */
async function listRolloutSessions(
  root: string,
  agent: string,
  home: string,
): Promise<HostSession[]> {
  const candidates = await findRolloutFiles(join(home, '.codex', 'sessions'));
  if (candidates.length === 0) return [];
  const wanted = await canonicalPath(root);
  const titles = await readThreadNames(join(home, '.codex', 'session_index.jsonl'));
  const rows: { session: HostSession; mtime: number }[] = [];
  for (const { file, id } of candidates) {
    const head = await readHead(file, SESSION_HEAD_BYTES);
    if (head === null) continue;
    const cwd = cwdFromRollout(head);
    if (cwd === null) continue;
    if (cwd !== root && (await canonicalPath(cwd)) !== wanted) continue;
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    const indexed = titles.get(id);
    rows.push({
      session: {
        id,
        agent,
        title:
          (indexed === undefined ? null : asTitle(indexed, { skipSlash: true })) ??
          titleFromRollout(head),
        updatedAt: new Date(mtime).toISOString(),
      },
      mtime,
    });
  }
  return sortAndCap(rows);
}

function sortAndCap(rows: { session: HostSession; mtime: number }[]): HostSession[] {
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, SESSION_LIST_MAX).map((r) => r.session);
}

/** Resolve symlinks so `/tmp/x` and `/private/tmp/x` compare equal; the raw path on failure. */
async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * The three fixed levels of the rollout store, newest-first and bounded.
 *
 * No recursion and no globbing: the depth is part of the format. Names sort
 * chronologically at every level (`YYYY`, `MM`, `DD`, then a timestamped
 * filename), so descending order visits the most recent sessions first — which
 * is what makes the scan cap keep the ones a picker would actually show.
 */
async function findRolloutFiles(sessionsRoot: string): Promise<{ file: string; id: string }[]> {
  const out: { file: string; id: string }[] = [];
  const desc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
  for (const y of (await safeReaddir(sessionsRoot)).filter((n) => /^\d{4}$/u.test(n)).sort(desc)) {
    const yDir = join(sessionsRoot, y);
    for (const m of (await safeReaddir(yDir)).filter((n) => /^\d{2}$/u.test(n)).sort(desc)) {
      const mDir = join(yDir, m);
      for (const d of (await safeReaddir(mDir)).filter((n) => /^\d{2}$/u.test(n)).sort(desc)) {
        const dDir = join(mDir, d);
        for (const name of (await safeReaddir(dDir)).sort(desc)) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const id = ROLLOUT_UUID_RE.exec(name)?.[1];
          if (id === undefined) continue;
          out.push({ file: join(dDir, name), id });
          if (out.length >= ROLLOUT_SCAN_MAX) return out;
        }
      }
    }
  }
  return out;
}

/** The folder a rollout ran in, from its first record. */
function cwdFromRollout(head: string): string | null {
  const nl = head.indexOf('\n');
  const first = nl === -1 ? head : head.slice(0, nl);
  try {
    const parsed = JSON.parse(first) as { type?: string; payload?: { cwd?: unknown } };
    if (parsed.type === 'session_meta' && typeof parsed.payload?.cwd === 'string') {
      return parsed.payload.cwd;
    }
  } catch {
    /* not a session_meta line: treat the file as unattributable */
  }
  return null;
}

/** `{id, thread_name}` rows the agent maintains next to its rollouts, if any. */
async function readThreadNames(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const head = await readHead(file, SESSION_INDEX_BYTES);
  if (head === null) return out;
  for (const row of jsonlRows(head)) {
    const rec = row as { id?: unknown; thread_name?: unknown };
    if (typeof rec.id === 'string' && typeof rec.thread_name === 'string') {
      out.set(rec.id, rec.thread_name);
    }
  }
  return out;
}

/**
 * Resumable agent sessions for a folder, read from the agent's OWN store — the
 * manager picker offers "continue where you left off" without the agent running.
 *
 * Only the agents in `RESUMABLE_MANAGER_AGENTS` are read; the others' on-disk
 * session formats are not verified, and offering a session we cannot actually
 * resume is worse than offering none.
 */
export async function listResumableHostSessions(
  root: string,
  agent: string = DEFAULT_RESUMABLE_AGENT,
  home: string = homedir(),
): Promise<{ agent: string; supported: boolean; sessions: HostSession[] }> {
  if (!isResumableManagerAgent(agent)) return { agent, supported: false, sessions: [] };
  const sessions =
    agent === 'codex'
      ? await listRolloutSessions(root, agent, home)
      : await listProjectTranscripts(root, agent, home);
  return { agent, supported: true, sessions };
}
