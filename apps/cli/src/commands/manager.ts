/**
 * `agentbox manager` — the coding agent that runs LOCALLY in a workspace folder,
 * reads the task list, groups tasks into boxes and watches them.
 *
 * The hub owns the process: it starts the agent in a detached tmux session on its
 * own machine, so the CLI, the tray and a plain terminal all attach to the SAME
 * session instead of the hub proxying a terminal to each of them. That is why
 * `start`/`stop` go through the API while `attach` is a local `tmux attach`.
 */
import { spawnSync } from 'node:child_process';
import { isCancel, log, select } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { withHubClient } from '../control-plane/with-hub.js';
import { resolveWorkspace, WorkspaceRefError } from '../lib/workspace-ref.js';
import { renderTable } from '../lib/text-table.js';
import { detectHostTerminal, spawnInNewTerminal } from '../terminal/host.js';
import type {
  HubApiClient,
  HubApiManager,
  HubApiWorkspace,
} from '../control-plane/hub-api-client.js';
import type { AttachOpenIn } from '@agentbox/config';
import { visibleAgentSpecs } from '@agentbox/agent-registry';

/**
 * Agents a manager can be. Registry-driven, so an agent added with
 * `agentbox agent add` is offered too; a SERVICE agent is excluded because a
 * manager is a session you attach to, not a daemon.
 */
function managerAgents(): string[] {
  return visibleAgentSpecs()
    .filter((spec) => spec.caps?.surface !== 'service')
    .map((spec) => spec.id);
}

interface WorkspaceOpt {
  workspace?: string;
}

async function mustResolve(client: HubApiClient, ref?: string): Promise<HubApiWorkspace> {
  try {
    return await resolveWorkspace(client, ref);
  } catch (err) {
    if (err instanceof WorkspaceRefError) {
      log.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

function printManager(m: HubApiManager): void {
  log.info(`manager: ${m.status}${m.agent ? ` (${m.agent})` : ''}`);
  if (m.cwd) process.stdout.write(`  folder   ${m.cwd}\n`);
  if (m.sessionId) process.stdout.write(`  session  ${m.sessionId}\n`);
  if (m.startedAt) process.stdout.write(`  started  ${m.startedAt}\n`);
  if (m.status === 'stopped' && m.lastExit !== undefined) {
    process.stdout.write(`  exited   ${String(m.lastExit)}\n`);
  }
  if (m.status === 'running') process.stdout.write(`  attach   ${m.attachCommand}\n`);
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${String(hours)}h ago` : `${String(Math.round(hours / 24))}d ago`;
}

/**
 * True when the hub this command is talking to runs on THIS machine.
 *
 * The manager's tmux session lives on the hub's host, so attaching to it is only
 * a local `tmux attach` when the hub is local. Against a control box the session
 * is on the VPS, and running tmux here would fail with a bare non-zero exit that
 * reads as a broken manager.
 */
async function hubIsLocal(): Promise<boolean> {
  const { resolveHubTarget } = await import('./hub.js');
  const target = await resolveHubTarget(undefined, { preferLocal: true });
  return target?.onThisMachine ?? true;
}

/** Attach to the manager's tmux session in this terminal (or a new pane). */
async function attachToSession(m: HubApiManager, openIn?: AttachOpenIn): Promise<boolean> {
  if (!(await hubIsLocal())) {
    log.error(
      `the manager runs on the hub's machine, not this one. Reach its session there with:\n  ${m.attachCommand}`,
    );
    return false;
  }
  // `=` is tmux's exact-match prefix: without it a session whose name merely
  // starts with this one would match.
  const target = `=${m.tmuxSession}`;
  if (openIn && openIn !== 'same') {
    const host = detectHostTerminal();
    if (host === 'unknown') {
      log.error('--attach-in needs a supported terminal (tmux, cmux, herdr, iTerm2).');
      return false;
    }
    const spawned = await spawnInNewTerminal({
      host,
      mode: openIn,
      argv: ['tmux', 'attach-session', '-t', target],
      cwd: m.cwd ?? process.cwd(),
      title: 'manager',
    });
    if (!spawned.launched) {
      log.error(spawned.error ?? `could not open a new ${host} ${openIn}`);
      return false;
    }
    log.success(spawned.note || `attached in a new ${host} ${openIn}`);
    return true;
  }
  // Inside tmux already: `attach` would refuse to nest, so switch the client.
  const inTmux = (process.env['TMUX'] ?? '').length > 0;
  const args = inTmux ? ['switch-client', '-t', target] : ['attach-session', '-t', target];
  const r = spawnSync('tmux', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    log.error(`could not attach: tmux ${args.join(' ')} exited ${String(r.status ?? -1)}`);
    return false;
  }
  return true;
}

const statusCommand = new Command('status')
  .description("Show the workspace manager's state")
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('-j, --json', 'print the state as JSON')
  .action(async (opts: WorkspaceOpt & { json?: boolean }) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      const manager = await client.getManager(ws.id);
      if (opts.json) process.stdout.write(JSON.stringify(manager, null, 2) + '\n');
      else printManager(manager);
    });
  });

const startCommand = new Command('start')
  .description('Start the manager agent in the workspace folder')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--agent <agent>', `which agent to run (${managerAgents().join(' | ')})`, 'claude')
  .option('--session <id>', 'resume this agent session (claude only)')
  .option('--new', 'start a fresh session without asking which to resume')
  .option('--restart', 'replace a manager that is already running')
  .option('--attach', 'attach to the session once it is up')
  .action(
    async (
      opts: WorkspaceOpt & {
        agent: string;
        session?: string;
        new?: boolean;
        restart?: boolean;
        attach?: boolean;
      },
    ) => {
      const agents = managerAgents();
      if (!agents.includes(opts.agent)) {
        log.error(`unknown agent "${opts.agent}" (expected ${agents.join(', ')})`);
        process.exit(4);
      }
      await withHubClient({ preferLocal: true }, async (client) => {
        const ws = await mustResolve(client, opts.workspace);
        let sessionId = opts.session;
        // Offer to resume only when the user said neither --session nor --new,
        // and only where a resumable session actually exists.
        if (!sessionId && !opts.new && process.stdout.isTTY) {
          const found = await client.listManagerSessions(ws.id, opts.agent).catch(() => null);
          if (found?.supported && found.sessions.length > 0) {
            const picked = await select({
              message: `Resume a ${opts.agent} session in ${ws.name}?`,
              options: [
                { value: '', label: 'New session' },
                ...found.sessions.map((s) => ({
                  value: s.id,
                  label: s.title,
                  hint: `${s.id.slice(0, 8)} · ${ago(s.updatedAt)}`,
                })),
              ],
            });
            if (isCancel(picked)) {
              log.info('cancelled.');
              return;
            }
            if (picked) sessionId = picked;
          }
        }
        const manager = await client.startManager(ws.id, {
          agent: opts.agent,
          ...(sessionId ? { sessionId } : {}),
          ...(opts.restart ? { restart: true } : {}),
        });
        printManager(manager);
        if (opts.attach && !(await attachToSession(manager))) process.exit(1);
      });
    },
  );

const stopCommand = new Command('stop')
  .description('Stop the manager agent')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .action(async (opts: WorkspaceOpt) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      printManager(await client.stopManager(ws.id));
    });
  });

const attachCommand = new Command('attach')
  .description("Attach to the manager's terminal session")
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--attach-in <mode>', 'open in a new split | window | tab instead of this terminal')
  .action(async (opts: WorkspaceOpt & { attachIn?: string }) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      const manager = await client.getManager(ws.id);
      if (manager.status !== 'running') {
        log.error(
          manager.status === 'never'
            ? `no manager for ${ws.name} yet. Start one with \`agentbox manager start\`.`
            : `the manager for ${ws.name} is not running. Start it with \`agentbox manager start\`.`,
        );
        process.exit(2);
      }
      const mode = opts.attachIn as AttachOpenIn | undefined;
      if (mode && !['split', 'window', 'tab'].includes(mode)) {
        log.error(`--attach-in must be one of split, window, tab`);
        process.exit(4);
      }
      if (!(await attachToSession(manager, mode))) process.exit(1);
    });
  });

const sessionsCommand = new Command('sessions')
  .description('List agent sessions in the workspace folder that a manager could resume')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--agent <agent>', 'which agent to list sessions for', 'claude')
  .option('-j, --json', 'print the listing as JSON')
  .action(async (opts: WorkspaceOpt & { agent: string; json?: boolean }) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const ws = await mustResolve(client, opts.workspace);
      const found = await client.listManagerSessions(ws.id, opts.agent);
      if (opts.json) {
        process.stdout.write(JSON.stringify(found, null, 2) + '\n');
        return;
      }
      if (!found.supported) {
        log.info(`resuming a ${found.agent} session is not supported yet.`);
        return;
      }
      if (found.sessions.length === 0) {
        log.info(`no ${found.agent} sessions in ${ws.root}.`);
        return;
      }
      renderTable(
        ['id', 'title', 'updated'],
        found.sessions.map((s) => [s.id, s.title, ago(s.updatedAt)]),
      );
    });
  });

export const managerCommand = new Command('manager')
  .description('The agent that runs locally in a workspace and orchestrates its boxes')
  .addCommand(statusCommand, { isDefault: true })
  .addCommand(startCommand)
  .addCommand(stopCommand)
  .addCommand(attachCommand)
  .addCommand(sessionsCommand);
