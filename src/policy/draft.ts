import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

import type { ProviderName } from '../utils/providers.js';
import type { LockstepPolicy, LockstepPolicyMode } from './types.js';
import { runStructuredProviderPrompt } from './provider-runner.js';

const DEFAULT_POLICY_REVIEW_THRESHOLD = 8;
const DEFAULT_POLICY_REVIEW_TIMEOUT_SECONDS = 30;

export interface PolicyDraftIntent {
  projectSummary: string;
  policyBrief: string;
  neverDo?: string;
  requireApproval?: string;
  protectedPaths?: string;
  writablePaths?: string;
  networkDomains?: string;
  networkBlockAllOther?: boolean;
  mode: LockstepPolicyMode;
  reviewProvider?: ProviderName;
  reviewModel?: string;
}

export interface PolicyDraftResult {
  summary: string;
  policy: LockstepPolicy;
  yaml: string;
  source: 'llm' | 'fallback';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitPatterns(value: string | undefined): string[] {
  return Array.from(new Set(
    (value ?? '')
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ));
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.trunc(parsed);
}

function numericThreshold(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.max(0, Math.min(10, parsed));
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = Array.from(new Set(
    value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0),
  ));

  return normalized.length > 0 ? normalized : undefined;
}

function summarizeRepositoryLayout(workingDirectory: string): string {
  const topLevelEntries = existsSync(workingDirectory)
    ? readdirSync(workingDirectory, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.lockstep'))
        .slice(0, 20)
        .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`)
    : [];

  let packageSummary = '';
  const packageJsonPath = path.join(workingDirectory, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
      const name = typeof parsed.name === 'string' ? parsed.name : 'unknown';
      const workspaces = Array.isArray(parsed.workspaces)
        ? parsed.workspaces.filter((entry): entry is string => typeof entry === 'string')
        : [];
      packageSummary = workspaces.length > 0
        ? `package.json name=${name}; workspaces=${workspaces.join(', ')}`
        : `package.json name=${name}`;
    } catch {
      packageSummary = 'package.json present';
    }
  }

  return [
    packageSummary,
    topLevelEntries.length > 0 ? `top-level=${topLevelEntries.join(', ')}` : '',
  ]
    .filter((segment) => segment.length > 0)
    .join('\n');
}

function buildDraftSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'policy'],
    properties: {
      summary: {
        type: 'string',
        minLength: 1,
      },
      policy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: ['strict', 'review', 'yolo'],
          },
          review: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: {
                type: 'string',
                enum: ['codex', 'claude'],
              },
              model: { type: 'string' },
              threshold: {
                type: 'number',
                minimum: 0,
                maximum: 10,
              },
              timeout_seconds: {
                type: 'integer',
                minimum: 1,
              },
              enabled: { type: 'boolean' },
            },
          },
          shell: {
            type: 'object',
            additionalProperties: false,
            properties: {
              deny: {
                type: 'array',
                items: { type: 'string' },
              },
              require_approval: {
                type: 'array',
                items: { type: 'string' },
              },
              allow_only: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          filesystem: {
            type: 'object',
            additionalProperties: false,
            properties: {
              writable: {
                type: 'array',
                items: { type: 'string' },
              },
              protected: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          network: {
            type: 'object',
            additionalProperties: false,
            properties: {
              allow: {
                type: 'array',
                items: { type: 'string' },
              },
              block_all_other: { type: 'boolean' },
            },
          },
        },
      },
    },
  };
}

function buildDraftPrompt(
  intent: PolicyDraftIntent,
  workingDirectory: string,
): string {
  const repoSummary = summarizeRepositoryLayout(workingDirectory) || 'No repository snapshot available.';
  return [
    'You are drafting a Lockstep policy file for a coding agent workflow.',
    'Return JSON only.',
    'Be concise, concrete, and conservative.',
    'Use repo-relative glob patterns.',
    'Do not repeat built-in safety rules unless they are materially important.',
    'Prefer shorter lists over exhaustive noisy ones.',
    'If the user leaves a field blank, omit it unless the repository layout strongly suggests a safe default.',
    '',
    'Required outcome:',
    `- mode must be "${intent.mode}"`,
    ...(intent.mode === 'strict'
      ? ['- omit review settings unless needed for documentation']
      : [
          `- review.provider should be "${intent.reviewProvider ?? 'codex'}" unless the request clearly conflicts`,
          '- threshold should usually stay at 8 unless the user explicitly asks otherwise',
          '- timeout_seconds should usually stay at 30 unless the user explicitly asks otherwise',
        ]),
    '',
    'Project context:',
    `Project summary: ${intent.projectSummary || 'Not provided.'}`,
    `Policy brief: ${intent.policyBrief || 'Not provided.'}`,
    `Never do: ${intent.neverDo || 'Not provided.'}`,
    `Require approval: ${intent.requireApproval || 'Not provided.'}`,
    `Protected paths: ${intent.protectedPaths || 'Not provided.'}`,
    `Writable paths: ${intent.writablePaths || 'Not provided.'}`,
    `Allowed network domains: ${intent.networkDomains || 'Not provided.'}`,
    `Block all other network: ${intent.networkBlockAllOther ? 'yes' : 'no'}`,
    '',
    'Repository snapshot:',
    repoSummary,
    '',
    'Generate a short summary plus the policy object.',
  ].join('\n');
}

function normalizePolicy(
  candidate: unknown,
  intent: PolicyDraftIntent,
): LockstepPolicy {
  const policyRecord = isRecord(candidate) ? candidate : {};
  const mode = policyRecord.mode === 'review' || policyRecord.mode === 'yolo' || policyRecord.mode === 'strict'
    ? policyRecord.mode
    : intent.mode;

  const reviewRecord = isRecord(policyRecord.review) ? policyRecord.review : undefined;
  const normalized: LockstepPolicy = {
    mode,
  };

  if (mode !== 'strict') {
    normalized.review = {
      enabled: reviewRecord?.enabled !== false,
      threshold: numericThreshold(reviewRecord?.threshold) ?? DEFAULT_POLICY_REVIEW_THRESHOLD,
      timeout_seconds: positiveIntegerOrUndefined(reviewRecord?.timeout_seconds) ?? DEFAULT_POLICY_REVIEW_TIMEOUT_SECONDS,
      provider: reviewRecord?.provider === 'claude' ? 'claude' : intent.reviewProvider ?? 'codex',
      ...(trimString(reviewRecord?.model ?? intent.reviewModel) ? { model: trimString(reviewRecord?.model ?? intent.reviewModel) } : {}),
    };
  }

  const shellRecord = isRecord(policyRecord.shell) ? policyRecord.shell : undefined;
  const shell = {
    ...(normalizeStringArray(shellRecord?.deny) ? { deny: normalizeStringArray(shellRecord?.deny) } : {}),
    ...(normalizeStringArray(shellRecord?.require_approval)
      ? { require_approval: normalizeStringArray(shellRecord?.require_approval) }
      : {}),
    ...(normalizeStringArray(shellRecord?.allow_only)
      ? { allow_only: normalizeStringArray(shellRecord?.allow_only) }
      : {}),
  };
  if (Object.keys(shell).length > 0) {
    normalized.shell = shell;
  }

  const filesystemRecord = isRecord(policyRecord.filesystem) ? policyRecord.filesystem : undefined;
  const filesystem = {
    ...(normalizeStringArray(filesystemRecord?.writable)
      ? { writable: normalizeStringArray(filesystemRecord?.writable) }
      : {}),
    ...(normalizeStringArray(filesystemRecord?.protected)
      ? { protected: normalizeStringArray(filesystemRecord?.protected) }
      : {}),
  };
  if (Object.keys(filesystem).length > 0) {
    normalized.filesystem = filesystem;
  }

  const networkRecord = isRecord(policyRecord.network) ? policyRecord.network : undefined;
  const networkAllow = normalizeStringArray(networkRecord?.allow);
  const network = {
    ...(networkAllow ? { allow: networkAllow } : {}),
    ...(networkRecord?.block_all_other === true || intent.networkBlockAllOther
      ? { block_all_other: true }
      : {}),
  };
  if (Object.keys(network).length > 0) {
    normalized.network = network;
  }

  return normalized;
}

function buildFallbackPolicy(intent: PolicyDraftIntent): LockstepPolicy {
  const policy: LockstepPolicy = {
    mode: intent.mode,
  };

  if (intent.mode !== 'strict') {
    policy.review = {
      enabled: true,
      threshold: DEFAULT_POLICY_REVIEW_THRESHOLD,
      timeout_seconds: DEFAULT_POLICY_REVIEW_TIMEOUT_SECONDS,
      provider: intent.reviewProvider ?? 'codex',
      ...(intent.reviewModel?.trim() ? { model: intent.reviewModel.trim() } : {}),
    };
  }

  const deny = splitPatterns(intent.neverDo);
  const requireApproval = splitPatterns(intent.requireApproval);
  if (deny.length > 0 || requireApproval.length > 0) {
    policy.shell = {
      ...(deny.length > 0 ? { deny } : {}),
      ...(requireApproval.length > 0 ? { require_approval: requireApproval } : {}),
    };
  }

  const writable = splitPatterns(intent.writablePaths);
  const protectedPaths = splitPatterns(intent.protectedPaths);
  if (writable.length > 0 || protectedPaths.length > 0) {
    policy.filesystem = {
      ...(writable.length > 0 ? { writable } : {}),
      ...(protectedPaths.length > 0 ? { protected: protectedPaths } : {}),
    };
  }

  const allow = splitPatterns(intent.networkDomains);
  if (allow.length > 0 || intent.networkBlockAllOther) {
    policy.network = {
      ...(allow.length > 0 ? { allow } : {}),
      ...(intent.networkBlockAllOther ? { block_all_other: true } : {}),
    };
  }

  return policy;
}

function dumpPolicy(policy: LockstepPolicy): string {
  return yaml.dump(policy, {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  }).trim();
}

export function generatePolicyDraft(
  intent: PolicyDraftIntent,
  workingDirectory: string,
): PolicyDraftResult {
  try {
    const raw = runStructuredProviderPrompt({
      provider: intent.reviewProvider,
      model: intent.reviewModel,
      prompt: buildDraftPrompt(intent, workingDirectory),
      schema: buildDraftSchema(),
      workingDirectory,
      timeoutMs: DEFAULT_POLICY_REVIEW_TIMEOUT_SECONDS * 1000,
    });

    const draftRecord = isRecord(raw) ? raw : {};
    const summary = trimString(draftRecord.summary) ?? 'Generated a conservative Lockstep policy draft.';
    const policy = normalizePolicy(draftRecord.policy, intent);

    return {
      summary,
      policy,
      yaml: dumpPolicy(policy),
      source: 'llm',
    };
  } catch (error) {
    const policy = buildFallbackPolicy(intent);
    const reason = error instanceof Error ? error.message : String(error);
    return {
      summary: `Built a deterministic fallback policy because AI drafting was unavailable: ${reason}`,
      policy,
      yaml: dumpPolicy(policy),
      source: 'fallback',
    };
  }
}
