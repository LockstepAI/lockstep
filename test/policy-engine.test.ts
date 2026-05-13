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

  it('blocks Bash redirection writes to protected files', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['.env'],
        writable: ['src/**'],
      },
    }, dir);

    const decision = engine.evaluateShellCommand('printf tampered > .env');

    expect(decision.allowed).toBe(false);
    expect(decision.tool).toBe('Bash');
    expect(decision.rule).toBe('policy:filesystem:protected:.env');
    expect(decision.reason).toContain('Shell command writes to restricted path ".env"');
  });

  it('blocks tee writes to protected files', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['secrets/**'],
        writable: ['src/**'],
      },
    }, dir);

    const decision = engine.evaluateShellCommand('echo nope | tee secrets/prod.key');

    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('policy:filesystem:protected:secrets/**');
  });

  it('blocks protected writes hidden inside nested shell wrappers', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['.env', 'secrets/**'],
        writable: ['src/**'],
      },
    }, dir);

    const envDecision = engine.evaluateShellCommand("bash -lc 'printf tampered > .env'");
    const secretDecision = engine.evaluateShellCommand('sh -c "touch secrets/prod.key"');

    expect(envDecision.allowed).toBe(false);
    expect(envDecision.rule).toBe('policy:filesystem:protected:.env');
    expect(secretDecision.allowed).toBe(false);
    expect(secretDecision.rule).toBe('policy:filesystem:protected:secrets/**');
  });

  it('blocks protected reads through direct file tools', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['.env', 'secrets/**'],
      },
    }, dir);

    const envDecision = engine.evaluateFileRead('.env');
    const secretDecision = engine.evaluateFileRead('secrets/prod.key');
    const srcDecision = engine.evaluateFileRead('src/index.ts');

    expect(envDecision.allowed).toBe(false);
    expect(envDecision.rule).toBe('policy:filesystem:protected_read:.env');
    expect(secretDecision.allowed).toBe(false);
    expect(secretDecision.rule).toBe('policy:filesystem:protected_read:secrets/**');
    expect(srcDecision.allowed).toBe(true);
  });

  it('blocks shell read commands against protected paths', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['.env', 'secrets/**'],
      },
    }, dir);

    const grepDecision = engine.evaluateShellCommand('grep -R prod-secret secrets');
    const rgDecision = engine.evaluateShellCommand('rg prod-secret secrets/prod.key');
    const nodeDecision = engine.evaluateShellCommand('node -e "require(\'fs\').readFileSync(\'secrets/prod.key\', \'utf8\')"');

    expect(grepDecision.allowed).toBe(false);
    expect(grepDecision.rule).toBe('policy:filesystem:protected_read:secrets/**');
    expect(rgDecision.allowed).toBe(false);
    expect(rgDecision.rule).toBe('policy:filesystem:protected_read:secrets/**');
    expect(nodeDecision.allowed).toBe(false);
    expect(nodeDecision.rule).toBe('policy:filesystem:protected_read:secrets/**');
  });

  it('matches protected directory roots for /** patterns', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['secrets/**'],
      },
    }, dir);

    const decision = engine.evaluateFileRead('secrets');

    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('policy:filesystem:protected_read:secrets/**');
  });

  it('blocks protected writes hidden in common inline scripts', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['.env', 'prod.db'],
        writable: ['src/**'],
      },
    }, dir);

    const nodeDecision = engine.evaluateShellCommand('node -e "require(\'fs\').writeFileSync(\'prod.db\', \'tampered\')"');
    const pythonDecision = engine.evaluateShellCommand('python -c "open(\'.env\', \'w\').write(\'tampered\')"');

    expect(nodeDecision.allowed).toBe(false);
    expect(nodeDecision.rule).toBe('policy:filesystem:protected:prod.db');
    expect(pythonDecision.allowed).toBe(false);
    expect(pythonDecision.rule).toBe('policy:filesystem:protected:.env');
  });

  it('allows Bash redirection writes inside writable paths', () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const engine = new PolicyEngine({
      mode: 'strict',
      filesystem: {
        protected: ['.env'],
        writable: ['src/**'],
      },
    }, dir);

    const decision = engine.evaluateShellCommand('printf ok > src/generated.txt');

    expect(decision.allowed).toBe(true);
    expect(decision.tool).toBe('Bash');
  });
});
