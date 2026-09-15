/**
 * Variables that name the agent session a process runs in. A process AgentBox
 * launches on the host (the hub daemon, a manager's tmux session) must not
 * inherit them from whoever started it: a hub started from inside a claude
 * session would otherwise hand that session's identity to every manager it runs,
 * and their own `agentbox` calls would be attributed to it. User configuration
 * (`CLAUDE_EFFORT`, `CLAUDE_CODE_USE_*`, API keys) is left alone.
 */
export const AGENT_SESSION_ENV_VARS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_AGENTS_SELECT',
  'CLAUDE_BG_BACKEND',
  'CLAUDE_BG_SOCKET_TOKENS_PATH',
  'CODEX_THREAD_ID',
  'AGENTBOX_MANAGER',
  'AGENTBOX_WORKSPACE',
];

/**
 * `env` without the agent-session variables, and without TMUX/TMUX_PANE: those
 * name a pane the child does not run in (and make tmux refuse to nest).
 */
export function scrubAgentSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of [...AGENT_SESSION_ENV_VARS, 'TMUX', 'TMUX_PANE']) delete out[key];
  return out;
}
