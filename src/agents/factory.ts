import type { Agent } from './base.js';
import { CodexAgent } from './codex.js';
import { ClaudeAgent } from './claude.js';

export function createAgent(agentType?: string): Agent {
  switch (agentType) {
    case undefined:
    case 'codex':
    case 'codex-cli':
      return new CodexAgent();
    case 'claude':
    case 'claude-code':
      return new ClaudeAgent();
    default:
      throw new Error(
        `Unsupported runner for this launch: ${agentType}. Lockstep currently supports codex and claude.`,
      );
  }
}
