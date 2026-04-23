import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

import { generatePolicyDraft } from '../src/policy/draft.js';

afterEach(() => {
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
});

describe('generatePolicyDraft', () => {
  it('normalizes an LLM draft into a concrete policy YAML', () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      summary: 'Protect prod paths and keep deploys gated.',
      policy: {
        mode: 'review',
        review: {
          provider: 'codex',
          threshold: 8.5,
        },
        shell: {
          deny: ['wrangler deploy', 'wrangler deploy'],
          require_approval: ['git push --force'],
        },
        filesystem: {
          protected: ['.env', 'infra/prod/**'],
        },
      },
    }));

    const draft = generatePolicyDraft({
      projectSummary: 'TypeScript monorepo',
      policyBrief: 'Protect prod deploys and secrets.',
      mode: 'review',
      reviewProvider: 'codex',
    }, process.cwd());

    expect(draft.source).toBe('llm');
    expect(draft.policy.review?.provider).toBe('codex');
    expect(draft.policy.review?.threshold).toBe(8.5);
    expect(draft.policy.shell?.deny).toEqual(['wrangler deploy']);
    expect(draft.yaml).toContain('provider: codex');
    expect(draft.yaml).toContain('protected:');
  });

  it('falls back to deterministic drafting when provider output is unavailable', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('codex unavailable');
    });

    const draft = generatePolicyDraft({
      projectSummary: 'API service',
      policyBrief: 'Block destructive SQL and protect secrets.',
      neverDo: 'DROP DATABASE, TRUNCATE',
      requireApproval: 'kubectl delete',
      protectedPaths: '.env, secrets/**',
      writablePaths: 'src/, tests/',
      networkDomains: 'api.example.com',
      networkBlockAllOther: true,
      mode: 'review',
      reviewProvider: 'claude',
      reviewModel: 'sonnet',
    }, process.cwd());

    expect(draft.source).toBe('fallback');
    expect(draft.summary).toContain('fallback');
    expect(draft.policy.review?.provider).toBe('claude');
    expect(draft.policy.shell?.deny).toEqual(['DROP DATABASE', 'TRUNCATE']);
    expect(draft.policy.network?.block_all_other).toBe(true);
    expect(draft.yaml).toContain('provider: claude');
  });

  it('can draft through Claude structured output', () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: JSON.stringify({
        structured_output: {
          summary: 'Keep writes inside src and block prod deploys.',
          policy: {
            mode: 'strict',
            shell: {
              deny: ['vercel --prod'],
            },
            filesystem: {
              writable: ['src/'],
            },
          },
        },
      }),
      stderr: '',
    });

    const draft = generatePolicyDraft({
      projectSummary: 'Next.js app',
      policyBrief: 'Local development only.',
      mode: 'strict',
      reviewProvider: 'claude',
    }, process.cwd());

    expect(draft.source).toBe('llm');
    expect(draft.policy.mode).toBe('strict');
    expect(draft.policy.shell?.deny).toEqual(['vercel --prod']);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });
});
