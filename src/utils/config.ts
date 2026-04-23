import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ClaudeAuthMode } from './providers.js';
import type { ContractRigor, WorkflowPreset } from '../product/presets.js';
import { isClaudeAuthMode, isProviderName } from './providers.js';
import { listContractRigorIds, listWorkflowPresetIds } from '../product/presets.js';

export interface LockstepRC {
  api_key?: string;
  agent?: 'codex' | 'claude';
  agent_model?: string;
  execution_mode?: 'standard' | 'yolo';
  judge_mode?: 'codex' | 'claude';
  judge_model?: string;
  claude_auth_mode?: ClaudeAuthMode;
  workflow_preset?: WorkflowPreset;
  contract_rigor?: ContractRigor;
}

const RC_PATH = path.join(homedir(), '.locksteprc');

export function loadRC(): LockstepRC {
  if (!existsSync(RC_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(RC_PATH, 'utf-8')) as Record<string, unknown>;
    return {
      ...(typeof parsed.api_key === 'string' ? { api_key: parsed.api_key } : {}),
      ...(isProviderName(parsed.agent) ? { agent: parsed.agent } : {}),
      ...(typeof parsed.agent_model === 'string' ? { agent_model: parsed.agent_model } : {}),
      ...(parsed.execution_mode === 'standard' || parsed.execution_mode === 'yolo'
        ? { execution_mode: parsed.execution_mode }
        : {}),
      ...(isProviderName(parsed.judge_mode) ? { judge_mode: parsed.judge_mode } : {}),
      ...(typeof parsed.judge_model === 'string' ? { judge_model: parsed.judge_model } : {}),
      ...(isClaudeAuthMode(parsed.claude_auth_mode) ? { claude_auth_mode: parsed.claude_auth_mode as ClaudeAuthMode } : {}),
      ...(typeof parsed.workflow_preset === 'string' && listWorkflowPresetIds().includes(parsed.workflow_preset as WorkflowPreset)
        ? { workflow_preset: parsed.workflow_preset as WorkflowPreset }
        : {}),
      ...(typeof parsed.contract_rigor === 'string' && listContractRigorIds().includes(parsed.contract_rigor as ContractRigor)
        ? { contract_rigor: parsed.contract_rigor as ContractRigor }
        : {}),
    };
  } catch {
    return {};
  }
}

export function saveRC(config: LockstepRC): void {
  writeFileSync(RC_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export const DEFAULTS = {
  agent: 'codex' as const,
  judge_mode: 'codex' as const,
  max_retries: 3,
  step_timeout: 300,
  working_directory: '.',
  judge_runs: 3,
} as const;
