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
const SESSION_HEAD_BYTES = 256 * 1024;

/**
 * A rollout's first record can be enormous — its `session_meta` carries the
 * agent's base instructions and every configured tool, measured at 49 KB on a
 * plain setup and growing with each MCP server. The folder sits ~200 bytes into
 * it, but the line only parses whole, so the reader follows the line rather than
 * a fixed head. The cap is a bound on a pathological file, not on a normal one.
 */
const SESSION_FIRST_LINE_MAX = 4 * 1024 * 1024;
const SESSION_TITLE_MAX = 120;
const SESSION_LIST_MAX = 50;
const UNTITLED_SESSION = '(untitled)';

/**
 * Read at most this much of a session-title index. It is append-only, so the
 * rows a picker needs are the NEWEST ones — read the tail, not the head.
 */
const SESSION_INDEX_BYTES = 1024 * 1024;

/**
 * How many session files one listing may open. A store that is flat across every
 * project holds years of other folders' sessions, and the picker shows 50.
 *
 * The candidates are ranked by mtime BEFORE this cap applies: a session created
 * weeks ago and resumed yesterday keeps writing to its original file, so cutting
 * by filename (creation time) would drop exactly the sessions a user is still
 * working in. Measured drift between the two on a real store: 22 hours.
 */
const ROLLOUT_SCAN_MAX = 200;

/**
 * How many files one listing may `stat` to rank them. Ten times the read budget:
 * a stat is cheap where opening and parsing a multi-megabyte record is not, and
 * this is the outer bound on a store that has grown for years.
 */
const ROLLOUT_STAT_MAX = 2000;

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
  // Last line before the id becomes argv on this machine: a value that reads as
  // an option would be parsed by the AGENT, not by us, and both agents expose
  // flags that drop their approval gate. The API refuses this shape too; the
  // check is here as well because this function is the one that builds argv.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)) return [agent];
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
  // `latest` sizes the window to the most recently active client, so a tray pane
  // and a terminal attached at once don't clamp the agent's TUI to the lesser
  // grid. It is tmux's own default, but a user config may set `smallest`, and
  // this session is shared by design. `window-size` is a WINDOW option, so the
  // target must be a window (`<session>:` = that session's current window) — a
  // bare session target answers "no such window" and the call is lost.
  // Best-effort: an old tmux without the option must not fail a start that
  // already succeeded.
  await exec(
    'tmux',
    ['set-option', '-w', '-t', `${exactTarget(session)}:`, 'window-size', 'latest'],
    { env },
  ).catch((err: unknown) => {
    // Best-effort, but not silent: swallowing this whole is how a wrong target
    // form shipped once already, invisible to everything but a unit test that
    // could only assert the argv we sent, never what tmux made of it.
    console.warn(
      `[manager] could not pin the tmux window size: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
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
/**
 * The file's first line, however long it is (bounded against a pathological one).
 * Reading a fixed head instead would silently drop every session whose opening
 * record outgrew the buffer, and that record is the only place the folder is
 * recorded.
 */
async function readFirstLine(file: string): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let text = '';
      let pos = 0;
      while (pos < SESSION_FIRST_LINE_MAX) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
        if (bytesRead === 0) return text;
        pos += bytesRead;
        text += chunk.subarray(0, bytesRead).toString('utf8');
        const nl = text.indexOf('\n');
        if (nl !== -1) return text.slice(0, nl);
      }
      return null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** The LAST `bytes` of a file, with any partial leading line dropped. */
async function readTail(file: string, bytes: number): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      if (start === 0) return text;
      const nl = text.indexOf('\n');
      return nl === -1 ? '' : text.slice(nl + 1);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function readHead(file: string, bytes: number, start = 0): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, start);
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
function asTitle(
  text: string,
  opts: { skipSlash?: boolean; skipInjected?: boolean } = {},
): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Command wrappers and system reminders are not what the user typed.
  if (!flat || flat.startsWith('<')) return null;
  if (opts.skipSlash && flat.startsWith('/')) return null;
  if (opts.skipInjected && isInjectedContext(flat)) return null;
  return flat.length > SESSION_TITLE_MAX ? `${flat.slice(0, SESSION_TITLE_MAX - 1)}…` : flat;
}

/**
 * Context an agent injects as if the user had typed it.
 *
 * A rollout's early `role: 'user'` records are not all turns: the repo's
 * instructions file and the harness's own preambles arrive the same way, so
 * scraping blindly names every session in a repo after its AGENTS.md. Measured
 * on a real store: 8 of 8 sessions in one folder shared one assessor preamble.
 */
function isInjectedContext(flat: string): boolean {
  if (flat.startsWith('#')) return true;
  return INJECTED_PREFIXES.some((p) => flat.startsWith(p));
}

const INJECTED_PREFIXES = [
  'The following is the',
  'AGENTS.md',
  'You are ',
  'Caveat:',
  'This session is being continued',
];

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
    const title = text === null ? null : asTitle(text, { skipInjected: true });
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
 *
 * Both record shapes are accepted because the store mixes writers across agent
 * versions; only the `role: 'user'` form appears in a store written by a current
 * one, so the other branch is a compatibility path, not the common case.
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
    const title = text === null ? null : asTitle(text, { skipInjected: true });
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
  const candidates = await rolloutCandidates(join(home, '.codex', 'sessions'));
  if (candidates.length === 0) return [];
  const wanted = await canonicalPath(root);
  const titles = await readThreadNames(join(home, '.codex', 'session_index.jsonl'));
  const rows: { session: HostSession; mtime: number }[] = [];
  for (const { file, id, mtime } of candidates) {
    const first = await readFirstLine(file);
    if (first === null) continue;
    const cwd = cwdFromRollout(first);
    if (cwd === null) continue;
    if (cwd !== root && (await canonicalPath(cwd)) !== wanted) continue;
    const indexed = titles.get(id);
    // Scrape AFTER the opening record: it alone can be hundreds of kilobytes, so
    // a head read from byte zero would spend its whole budget on the metadata and
    // never reach a turn. `first` is already in hand and holds no user text.
    const indexedTitle = indexed === undefined ? null : asTitle(indexed, { skipSlash: true });
    const title =
      indexedTitle ??
      titleFromRollout(
        (await readHead(file, SESSION_HEAD_BYTES, Buffer.byteLength(first, 'utf8') + 1)) ?? '',
      );
    rows.push({
      session: { id, agent, title, updatedAt: new Date(mtime).toISOString() },
      mtime,
    });
  }
  return sortAndCap(rows);
}

/**
 * Every rollout in the store, newest-ACTIVITY first and capped.
 *
 * Ranking by mtime before the cap is what makes the cap honest: the filename
 * carries creation time, but a resumed session keeps appending to its original
 * file, so a name-ordered cut drops the sessions someone is still working in.
 */
async function rolloutCandidates(
  sessionsRoot: string,
): Promise<{ file: string; id: string; mtime: number }[]> {
  const files = await findRolloutFiles(sessionsRoot);
  const dated: { file: string; id: string; mtime: number }[] = [];
  for (const { file, id } of files) {
    try {
      dated.push({ file, id, mtime: (await stat(file)).mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  dated.sort((a, b) => b.mtime - a.mtime);
  return dated.slice(0, ROLLOUT_SCAN_MAX);
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
 * filename), so descending order visits the most recently CREATED sessions
 * first. That is not the same as most recently used, which is why the caller
 * ranks by mtime before applying the read budget.
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
          if (out.length >= ROLLOUT_STAT_MAX) return out;
        }
      }
    }
  }
  return out;
}

/**
 * The folder a rollout ran in, from its opening record — and `null` for a
 * session no human started.
 *
 * The store holds the agent's own internal threads alongside real ones: a
 * `guardian_review` thread assessing a command, a `subagent` thread doing part
 * of a task. On one real store those were 49 of 71 files. They have no user turn
 * to name them and resuming one puts the user inside the agent's plumbing, so
 * they are skipped here exactly as claude's `agent-*.jsonl` transcripts are.
 * An absent marker means a writer too old to record one: kept, not guessed at.
 */
function cwdFromRollout(head: string): string | null {
  const nl = head.indexOf('\n');
  const first = nl === -1 ? head : head.slice(0, nl);
  try {
    const parsed = JSON.parse(first) as {
      type?: string;
      payload?: { cwd?: unknown; thread_source?: unknown };
    };
    if (parsed.type !== 'session_meta' || typeof parsed.payload?.cwd !== 'string') return null;
    const source = parsed.payload.thread_source;
    if (typeof source === 'string' && source !== 'user') return null;
    return parsed.payload.cwd;
  } catch {
    /* not a session_meta line: treat the file as unattributable */
  }
  return null;
}

/** `{id, thread_name}` rows the agent maintains next to its rollouts, if any. */
async function readThreadNames(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const tail = await readTail(file, SESSION_INDEX_BYTES);
  if (tail === null) return out;
  for (const row of jsonlRows(tail)) {
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
