import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { getContractRigorProfile, getWorkflowPreset, type ContractRigor, type WorkflowPreset } from './presets.js';
import type { LockstepPolicy } from '../policy/types.js';

export interface ContractDraftAnswers {
  projectSummary: string;
  objective: string;
  deliverables?: string;
  mustPass?: string;
  constraints?: string;
  workflowPreset: WorkflowPreset;
  rigor: ContractRigor;
}

function splitList(value: string | undefined): string[] {
  return Array.from(new Set(
    (value ?? '')
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ));
}

function summarizeRepository(workingDirectory: string): string {
  if (!existsSync(workingDirectory)) {
    return 'Repository snapshot unavailable.';
  }

  const entries = readdirSync(workingDirectory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.lockstep'))
    .slice(0, 24)
    .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`);

  const packageJsonPath = path.join(workingDirectory, 'package.json');
  let packageSummary = '';
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
      const name = typeof parsed.name === 'string' ? parsed.name : 'unknown';
      packageSummary = `package.json name=${name}`;
    } catch {
      packageSummary = 'package.json present';
    }
  }

  return [
    packageSummary,
    entries.length > 0 ? `top-level=${entries.join(', ')}` : '',
  ]
    .filter((segment) => segment.length > 0)
    .join('\n');
}

function summarizePolicy(policy: LockstepPolicy | undefined): string {
  if (!policy) {
    return 'No repo policy file present.';
  }

  const lines: string[] = [`mode=${policy.mode ?? 'strict'}`];
  if (policy.review && policy.mode !== 'strict') {
    lines.push(`review=${policy.review.provider ?? 'codex'} threshold=${policy.review.threshold ?? 8}`);
  }
  if (policy.shell?.deny?.length) {
    lines.push(`shell deny=${policy.shell.deny.join(', ')}`);
  }
  if (policy.shell?.require_approval?.length) {
    lines.push(`shell approval=${policy.shell.require_approval.join(', ')}`);
  }
  if (policy.filesystem?.protected?.length) {
    lines.push(`protected paths=${policy.filesystem.protected.join(', ')}`);
  }
  if (policy.network?.allow?.length) {
    lines.push(`network allow=${policy.network.allow.join(', ')}`);
  }
  if (policy.network?.block_all_other) {
    lines.push('network block_all_other=true');
  }

  return lines.join('\n');
}

export function buildContractGenerationPrompt(
  answers: ContractDraftAnswers,
  workingDirectory: string,
  policy?: LockstepPolicy,
): string {
  const workflow = getWorkflowPreset(answers.workflowPreset);
  const rigor = getContractRigorProfile(answers.rigor);
  const deliverables = splitList(answers.deliverables);
  const mustPass = splitList(answers.mustPass);

  return [
    'Draft a Lockstep contract spec for this repository and objective.',
    'Use the Lockstep YAML format exactly.',
    'This contract will be executed locally with a strict validation and proof workflow.',
    '',
    'Execution preset:',
    `- ${workflow.label}: ${workflow.description}`,
    '',
    'Rigor profile:',
    `- ${rigor.label}: ${rigor.description}`,
    ...rigor.generationNotes.map((note) => `- ${note}`),
    '',
    'Project summary:',
    answers.projectSummary || 'Not provided.',
    '',
    'Objective:',
    answers.objective,
    '',
    ...(deliverables.length > 0
      ? [
          'Required deliverables:',
          ...deliverables.map((entry) => `- ${entry}`),
          '',
        ]
      : []),
    ...(mustPass.length > 0
      ? [
          'Must-pass verification commands or checks:',
          ...mustPass.map((entry) => `- ${entry}`),
          '',
        ]
      : []),
    ...(answers.constraints?.trim()
      ? [
          'Additional constraints:',
          answers.constraints.trim(),
          '',
        ]
      : []),
    'Active repo policy summary:',
    summarizePolicy(policy),
    '',
    'Repository snapshot:',
    summarizeRepository(workingDirectory),
    '',
    'Contract requirements:',
    '- Build one or more realistic phases with structural validators, then a final quality/review gate when appropriate.',
    '- Keep steps small enough to complete within Lockstep step timeouts.',
    '- Respect the active repo policy boundaries when choosing validation commands and target files.',
    '- Prefer explicit file paths and explicit verification commands over vague checks.',
    '- If the objective is multi-surface or monorepo-scale, split it into multiple specs or phases.',
  ].join('\n');
}
