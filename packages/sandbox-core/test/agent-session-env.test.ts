import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_ENV_VARS, scrubAgentSessionEnv } from '../src/agent-session-env.js';

describe('scrubAgentSessionEnv', () => {
  it('drops the session identity a launcher inherited, and keeps user configuration', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/Users/dev',
      CLAUDECODE: '1',
      CLAUDE_PID: '29818',
      CLAUDE_CODE_SESSION_ID: '5edc0ee0-ce9a-4e30-962d-bc630388d8bc',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_BG_BACKEND: 'daemon',
      CODEX_THREAD_ID: '01a09ad5-8f51-7ec0-b8f4-2daa8be67500',
      AGENTBOX_MANAGER: '1',
      AGENTBOX_WORKSPACE: '1020d6ffc6aa4e07',
      TMUX: '/private/tmp/tmux-501/default,89157,0',
      TMUX_PANE: '%0',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'sk-test',
      AGENTBOX_HUB_PORT: '8787',
    };
    const out = scrubAgentSessionEnv(env);
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/dev',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_API_KEY: 'sk-test',
      AGENTBOX_HUB_PORT: '8787',
    });
    // A copy: the launcher's own env is untouched.
    expect(env.CLAUDE_PID).toBe('29818');
  });

  it('names every identity variable a claude or codex session exports', () => {
    for (const key of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) {
      expect(AGENT_SESSION_ENV_VARS).toContain(key);
    }
    expect(AGENT_SESSION_ENV_VARS).not.toContain('TMUX');
  });
});
