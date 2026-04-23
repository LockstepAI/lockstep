import type { LockstepPolicy } from '../policy/types.js';
import type { LockstepSpec } from '../core/parser.js';
import type { LockstepRC } from '../utils/config.js';
import { getContractRigorProfile, getWorkflowPreset } from './presets.js';

export function buildDefaultsSummary(rc: LockstepRC): string[] {
  const workflow = getWorkflowPreset(rc.workflow_preset);
  const rigor = getContractRigorProfile(rc.contract_rigor);

  return [
    `Workflow: ${workflow.label} (${workflow.description})`,
    `Runner: ${rc.agent ?? 'codex'}`,
    `Judge: ${rc.judge_mode ?? rc.agent ?? 'codex'}`,
    `Autonomy: ${rc.execution_mode ?? workflow.executionMode}`,
    `Rigor: ${rigor.label}`,
    `Runner model: ${rc.agent_model ?? 'provider-default'}`,
    `Judge model: ${rc.judge_model ?? 'provider-default'}`,
    `Claude auth: ${rc.claude_auth_mode ?? 'auto'}`,
  ];
}

export function buildPolicySummary(policy: LockstepPolicy | undefined): string[] {
  if (!policy || Object.keys(policy).length === 0) {
    return ['No custom policy file. Built-in safety rules only.'];
  }

  const lines = [`Mode: ${policy.mode ?? 'strict'}`];
  if (policy.review && policy.mode !== 'strict') {
    lines.push(`Review: ${(policy.review.provider ?? 'codex')} threshold ${policy.review.threshold ?? 8}${policy.review.model ? ` model ${policy.review.model}` : ''}`);
  }
  if (policy.shell?.deny?.length) {
    lines.push(`Shell deny: ${policy.shell.deny.length} patterns`);
  }
  if (policy.shell?.require_approval?.length) {
    lines.push(`Shell approval: ${policy.shell.require_approval.length} patterns`);
  }
  if (policy.filesystem?.writable?.length) {
    lines.push(`Writable paths: ${policy.filesystem.writable.length}`);
  }
  if (policy.filesystem?.protected?.length) {
    lines.push(`Protected paths: ${policy.filesystem.protected.length}`);
  }
  if (policy.network?.allow?.length) {
    lines.push(`Network allowlist: ${policy.network.allow.join(', ')}`);
  }
  if (policy.network?.block_all_other) {
    lines.push('Network: block all other outbound domains');
  }

  return lines;
}

export function buildSpecSummary(spec: LockstepSpec): string[] {
  const validatorCount = spec.steps.reduce((total, step) => total + step.validate.length, 0);
  const aiJudgeSteps = spec.steps.filter((step) => step.validate.some((validator) => validator.type === 'ai_judge'));
  const finalJudge = aiJudgeSteps.at(-1)?.validate.find((validator) => validator.type === 'ai_judge');

  const lines = [
    `Working directory: ${spec.config.working_directory}`,
    `Runner: ${spec.config.agent}`,
    `Judge: ${spec.config.judge_mode ?? spec.config.agent}`,
    `Autonomy: ${spec.config.execution_mode ?? 'standard'}`,
    `Phases: ${spec.steps.length}`,
    `Validators: ${validatorCount}`,
    `Max retries: ${spec.config.max_retries}`,
    `Step timeout: ${spec.config.step_timeout}s`,
  ];

  if (finalJudge) {
    lines.push(`Final ai_judge threshold: ${String(finalJudge.threshold ?? 'unknown')}`);
  }

  lines.push('Phases:');
  for (const step of spec.steps) {
    const hasJudge = step.validate.some((validator) => validator.type === 'ai_judge');
    lines.push(`- ${step.name} (${step.validate.length} validators${hasJudge ? ', review gate' : ''})`);
  }

  return lines;
}
