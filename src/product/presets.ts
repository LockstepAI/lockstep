export type WorkflowPreset = 'plan' | 'guarded' | 'autonomous' | 'ci';
export type ContractRigor = 'balanced' | 'production' | 'enterprise';

export interface WorkflowPresetDefinition {
  id: WorkflowPreset;
  label: string;
  description: string;
  executionMode: 'standard' | 'yolo';
}

export interface ContractRigorDefinition {
  id: ContractRigor;
  label: string;
  description: string;
  generationNotes: string[];
}

export const WORKFLOW_PRESETS: readonly WorkflowPresetDefinition[] = [
  {
    id: 'plan',
    label: 'Plan',
    description: 'Read-heavy exploration and careful first passes before wider execution.',
    executionMode: 'standard',
  },
  {
    id: 'guarded',
    label: 'Guarded',
    description: 'Recommended default. Strong policy and review with normal local execution.',
    executionMode: 'standard',
  },
  {
    id: 'autonomous',
    label: 'Autonomous',
    description: 'Longer uninterrupted local execution inside the declared policy boundary.',
    executionMode: 'yolo',
  },
  {
    id: 'ci',
    label: 'CI',
    description: 'Headless, repeatable runs with narrow tool surfaces and deterministic contracts.',
    executionMode: 'standard',
  },
] as const;

export const CONTRACT_RIGOR_PROFILES: readonly ContractRigorDefinition[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Good developer defaults without over-constraining fast iteration.',
    generationNotes: [
      'Keep the plan concrete and production-leaning, but avoid unnecessary release-process scaffolding.',
      'Use validators that are strict enough for daily development without inflating the step graph.',
    ],
  },
  {
    id: 'production',
    label: 'Production',
    description: 'Strong default for shipping product work with strict checks and explicit review.',
    generationNotes: [
      'Bias toward strict lint, typecheck, test, and ai_judge gates.',
      'Require explicit artifacts and runnable verification commands for user-visible behavior.',
      'Prefer narrower, composable steps over broad speculative scaffolds.',
    ],
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    description: 'Highest rigor for regulated or high-risk teams with clear boundaries and auditability.',
    generationNotes: [
      'Treat operational safety, policy alignment, and blast-radius reduction as first-class constraints.',
      'Prefer explicit health checks, structured logs, narrow writable surfaces, and conservative review language.',
      'Require clear validation for security-sensitive boundaries, deploy surfaces, and external integrations.',
    ],
  },
] as const;

export function getWorkflowPreset(
  preset: WorkflowPreset | undefined,
): WorkflowPresetDefinition {
  return WORKFLOW_PRESETS.find((entry) => entry.id === preset)
    ?? WORKFLOW_PRESETS.find((entry) => entry.id === 'guarded')!;
}

export function getContractRigorProfile(
  profile: ContractRigor | undefined,
): ContractRigorDefinition {
  return CONTRACT_RIGOR_PROFILES.find((entry) => entry.id === profile)
    ?? CONTRACT_RIGOR_PROFILES.find((entry) => entry.id === 'production')!;
}

export function listWorkflowPresetIds(): WorkflowPreset[] {
  return WORKFLOW_PRESETS.map((entry) => entry.id);
}

export function listContractRigorIds(): ContractRigor[] {
  return CONTRACT_RIGOR_PROFILES.map((entry) => entry.id);
}
