import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

import { PolicyEngine } from '../src/policy/engine.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `lockstep-policy-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanupDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('PolicyEngine modes', () => {
  it('strict mode escalates risky shell commands for human approval', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({ mode: 'strict' }, dir);

    const decision = engine.evaluateShellCommand('DROP TABLE users;');

    expect(decision.allowed).toBe(false);
    expect(decision.needs_approval).toBe(true);
    expect(decision.mode).toBe('strict');
    expect(decision.reviewed).not.toBe(true);
  });

  it('review mode auto-allows risky actions when Codex review clears the threshold', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    execFileSyncMock.mockReturnValue(JSON.stringify({
      score: 9.2,
      verdict: 'allow',
      reasoning: 'This is a repo-local cleanup inside the expected test fixture.',
      risk_tags: ['repo-local'],
    }));

    const engine = new PolicyEngine({
      mode: 'review',
      review: { threshold: 8 },
    }, dir);

    const decision = engine.evaluateShellCommand('git clean -fd temp-fixture');

    expect(decision.allowed).toBe(true);
    expect(decision.needs_approval).toBe(false);
    expect(decision.mode).toBe('review');
    expect(decision.reviewed).toBe(true);
    expect(decision.review_score).toBe(9.2);
    expect(decision.reason).toContain('Allowed after AI review');
  });

  it('review mode falls back to human approval when Codex review escalates', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    execFileSyncMock.mockReturnValue(JSON.stringify({
      score: 3.5,
      verdict: 'escalate',
      reasoning: 'This action is destructive and not clearly justified by repository context.',
      risk_tags: ['destructive'],
    }));

    const engine = new PolicyEngine({
      mode: 'review',
      review: { threshold: 8 },
    }, dir);

    const decision = engine.evaluateShellCommand('DROP DATABASE prod;');

    expect(decision.allowed).toBe(false);
    expect(decision.needs_approval).toBe(true);
    expect(decision.mode).toBe('review');
    expect(decision.reviewed).toBe(true);
    expect(decision.review_score).toBe(3.5);
    expect(decision.reason).toContain('Escalated for developer approval');
  });

  it('review mode can use Claude as the policy reviewer', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: JSON.stringify({
        structured_output: {
          score: 8.7,
          verdict: 'allow',
          reasoning: 'This only cleans a repo-local generated fixture directory.',
          risk_tags: ['repo-local'],
        },
      }),
      stderr: '',
    });

    const engine = new PolicyEngine({
      mode: 'review',
      review: { provider: 'claude', threshold: 8 },
    }, dir);

    const decision = engine.evaluateShellCommand('git clean -fd temp-fixture');

    expect(decision.allowed).toBe(true);
    expect(decision.reviewed).toBe(true);
    expect(decision.review_score).toBe(8.7);
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it('yolo mode allows risky actions while still recording the AI review result', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    execFileSyncMock.mockReturnValue(JSON.stringify({
      score: 2.1,
      verdict: 'escalate',
      reasoning: 'This is high-risk, but yolo mode means allow and log it.',
      risk_tags: ['destructive', 'yolo'],
    }));

    const engine = new PolicyEngine({
      mode: 'yolo',
      review: { threshold: 8 },
    }, dir);

    const decision = engine.evaluateShellCommand('git push --force origin main');

    expect(decision.allowed).toBe(true);
    expect(decision.needs_approval).toBe(false);
    expect(decision.mode).toBe('yolo');
    expect(decision.reviewed).toBe(true);
    expect(decision.review_score).toBe(2.1);
    expect(decision.reason).toContain('Allowed by yolo mode');
  });

  it('writes policy decisions to the .lockstep policy log', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({ mode: 'strict' }, dir);

    engine.evaluateShellCommand('echo hello');

    const logPath = join(dir, '.lockstep', 'policy-log.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      allowed: true,
      action: 'echo hello',
      tool: 'Bash',
    });
  });
});
