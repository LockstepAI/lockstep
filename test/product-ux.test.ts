import { describe, expect, it } from 'vitest';

import { buildContractGenerationPrompt } from '../src/product/contract.js';
import { buildDefaultsSummary, buildPolicySummary, buildSpecSummary } from '../src/product/review.js';
import type { LockstepPolicy } from '../src/policy/types.js';
import type { LockstepSpec } from '../src/core/parser.js';

describe('product UX helpers', () => {
  it('builds a contract prompt that includes workflow, rigor, and policy context', () => {
    const prompt = buildContractGenerationPrompt({
      projectSummary: 'TypeScript SDK and API',
      objective: 'Build a typed billing client with tests.',
      deliverables: 'sdk/src/client.ts, sdk/src/client.test.ts',
      mustPass: 'npm test --prefix sdk, npm run build --prefix sdk',
      constraints: 'Do not weaken existing lint rules.',
      workflowPreset: 'guarded',
      rigor: 'enterprise',
    }, process.cwd(), {
      mode: 'review',
      review: { provider: 'claude', threshold: 8 },
      filesystem: { protected: ['.env'] },
    });

    expect(prompt).toContain('Execution preset:');
    expect(prompt).toContain('Guarded');
    expect(prompt).toContain('Enterprise');
    expect(prompt).toContain('sdk/src/client.ts');
    expect(prompt).toContain('review=claude threshold=8');
    expect(prompt).toContain('Do not weaken existing lint rules.');
  });

  it('summarizes defaults, policy, and spec in a readable way', () => {
    const defaults = buildDefaultsSummary({
      workflow_preset: 'guarded',
      contract_rigor: 'production',
      agent: 'claude',
      judge_mode: 'codex',
      execution_mode: 'standard',
      claude_auth_mode: 'interactive',
    });
    expect(defaults[0]).toContain('Workflow: Guarded');
    expect(defaults.join('\n')).toContain('Claude auth: interactive');

    const policy: LockstepPolicy = {
      mode: 'review',
      review: { provider: 'claude', threshold: 8 },
      shell: { deny: ['wrangler deploy'] },
    };
    const policyLines = buildPolicySummary(policy);
    expect(policyLines.join('\n')).toContain('Review: claude threshold 8');
    expect(policyLines.join('\n')).toContain('Shell deny: 1 patterns');

    const spec: LockstepSpec = {
      version: '1',
      config: {
        agent: 'claude',
        judge_mode: 'codex',
        max_retries: 3,
        step_timeout: 300,
        working_directory: '.',
        execution_mode: 'standard',
      },
      steps: [
        {
          name: 'Scaffold',
          prompt: 'Create files',
          validate: [
            { type: 'file_exists', target: 'package.json' },
          ],
        },
        {
          name: 'Review',
          prompt: 'Finalize',
          validate: [
            { type: 'file_exists', target: 'src/index.ts' },
            { type: 'ai_judge', criteria: 'Quality', threshold: 8, evaluation_targets: ['src/index.ts'] },
          ],
        },
      ],
    };
    const specLines = buildSpecSummary(spec);
    expect(specLines.join('\n')).toContain('Runner: claude');
    expect(specLines.join('\n')).toContain('Final ai_judge threshold: 8');
    expect(specLines.join('\n')).toContain('- Review (2 validators, review gate)');
  });
});
