/**
 * Regression tests for all bugs found in the security audit.
 * Each test is tagged with the bug number from the audit report.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runValidation } from '../src/validators/registry.js';
import {
  computeCriteriaHash,
  normalizeCriteria,
  computeStepHash,
} from '../src/core/hasher.js';
import type { StepProof } from '../src/core/hasher.js';
import { createAgent } from '../src/agents/factory.js';
import { buildAgentPrompt } from '../src/core/executor.js';

// ---------------------------------------------------------------------------
// Test workspace
// ---------------------------------------------------------------------------

const TEST_DIR = join(process.cwd(), '.test-audit-' + Date.now());
const ctx = { workingDirectory: TEST_DIR, stepTimeout: 30 };

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'Hello World\nLine two\n');
  writeFileSync(join(TEST_DIR, 'data.json'), '{"name":"test","version":"1.0"}');
  writeFileSync(join(TEST_DIR, 'secret.env'), 'API_KEY=secret123');
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ===========================================================================
// HASHER FIXES
// ===========================================================================

describe('Audit Fix #3: rubric field in criteria_hash', () => {
  it('rubric=true produces different hash than default', () => {
    const h1 = computeCriteriaHash([
      { type: 'ai_judge', criteria: 'test quality', threshold: 7 },
    ]);
    const h2 = computeCriteriaHash([
      { type: 'ai_judge', criteria: 'test quality', threshold: 7, rubric: true },
    ]);
    expect(h1).not.toBe(h2);
  });

  it('rubric=false matches default (false is the default)', () => {
    const h1 = computeCriteriaHash([
      { type: 'ai_judge', criteria: 'test quality', threshold: 7 },
    ]);
    const h2 = computeCriteriaHash([
      { type: 'ai_judge', criteria: 'test quality', threshold: 7, rubric: false },
    ]);
    expect(h1).toBe(h2);
  });

  it('rubric is in the normalized output', () => {
    const normalized = normalizeCriteria([
      { type: 'ai_judge', criteria: 'test', threshold: 7 },
    ]);
    expect(normalized[0]).toHaveProperty('rubric', false);
  });
});

describe('Hasher: label/description stripping', () => {
  it('label does not affect criteria_hash', () => {
    const h1 = computeCriteriaHash([
      { type: 'file_exists', target: 'index.ts' },
    ]);
    const h2 = computeCriteriaHash([
      { type: 'file_exists', target: 'index.ts', label: 'Check index exists' },
    ]);
    expect(h1).toBe(h2);
  });

  it('description does not affect criteria_hash', () => {
    const h1 = computeCriteriaHash([
      { type: 'command_passes', command: 'npm test' },
    ]);
    const h2 = computeCriteriaHash([
      { type: 'command_passes', command: 'npm test', description: 'Run unit tests' },
    ]);
    expect(h1).toBe(h2);
  });
});

describe('Hasher: step_hash chain integrity', () => {
  it('changing previous_step_hash changes step_hash', () => {
    const proof1: StepProof = {
      step_index: 0,
      step_name: 'test',
      criteria_hash: 'abc',
      attempts: [],
      final_attempt: 0,
      all_passed: true,
      previous_step_hash: 'genesis',
      step_hash: '',
    };
    const proof2: StepProof = { ...proof1, previous_step_hash: 'different' };

    expect(computeStepHash(proof1)).not.toBe(computeStepHash(proof2));
  });

  it('step_hash is deterministic for same input', () => {
    const proof: StepProof = {
      step_index: 0,
      step_name: 'test',
      criteria_hash: 'abc',
      attempts: [],
      final_attempt: 0,
      all_passed: true,
      previous_step_hash: 'genesis',
      step_hash: '',
    };
    expect(computeStepHash(proof)).toBe(computeStepHash(proof));
  });
});

// ===========================================================================
// VALIDATOR FIXES
// ===========================================================================

describe('Audit Fix #5: api_responds security', () => {
  it('rejects non-http URL schemes', async () => {
    const r = await runValidation(
      { type: 'api_responds', url: 'file:///etc/passwd', status: 200 },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.details).toContain('Unsupported URL scheme');
  });

  it('rejects ftp scheme', async () => {
    const r = await runValidation(
      { type: 'api_responds', url: 'ftp://evil.com/data', status: 200 },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.details).toContain('Unsupported URL scheme');
  });

  it('rejects invalid URLs', async () => {
    const r = await runValidation(
      { type: 'api_responds', url: 'not-a-url', status: 200 },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.details).toContain('Invalid URL');
  });
});

describe('Audit Fix #6: file_not_contains regex flag consistency', () => {
  it('uses multiline flag (m) for regex matching', async () => {
    // Write a file with content on different lines
    writeFileSync(join(TEST_DIR, 'multiline.txt'), 'line1\nTARGET_LINE\nline3\n');

    // ^ should match start of any line with 'm' flag
    const r = await runValidation(
      { type: 'file_not_contains', path: 'multiline.txt', pattern: '^TARGET_LINE$', is_regex: true },
      ctx,
    );
    // Pattern IS found, so file_not_contains should FAIL
    expect(r.passed).toBe(false);
  });

  it('file_contains also uses multiline flag', async () => {
    const r = await runValidation(
      { type: 'file_contains', path: 'multiline.txt', pattern: '^TARGET_LINE$', is_regex: true },
      ctx,
    );
    expect(r.passed).toBe(true);
  });
});

describe('Audit Fix #10: comment accuracy (1 MB not 10 KB)', () => {
  it('MAX_TRUNCATED_BYTES allows up to 1 MB', async () => {
    // Create a file that generates >10KB but <1MB of output
    const bigOutput = 'x'.repeat(50_000); // 50 KB
    writeFileSync(join(TEST_DIR, 'big-output.sh'), `#!/bin/bash\necho "${bigOutput}"\nexit 1`);

    const r = await runValidation(
      { type: 'command_passes', command: `echo "${'x'.repeat(50_000)}" && exit 1` },
      ctx,
    );
    expect(r.passed).toBe(false);
    // stdout_truncated should contain the full 50KB, not be truncated at 10KB
    if (r.stdout_truncated) {
      expect(r.stdout_truncated.length).toBeGreaterThan(10_000);
    }
  });
});

// ===========================================================================
// AGENT ADAPTER TESTS
// ===========================================================================

describe('Agent factory', () => {
  const unsupported = [
    'openai',
    'api',
    'experimental-runner',
    'custom-runner',
  ];

  for (const input of unsupported) {
    it(`createAgent('${input}') is rejected for the supported launch providers`, () => {
      expect(() => createAgent(input)).toThrow('Unsupported runner for this launch');
    });
  }

  it(`createAgent('codex') returns agent named 'codex'`, () => {
    const agent = createAgent('codex');
    expect(agent.name).toBe('codex');
  });

  it(`createAgent('codex-cli') returns agent named 'codex'`, () => {
    const agent = createAgent('codex-cli');
    expect(agent.name).toBe('codex');
  });

  it(`createAgent('claude') returns agent named 'claude'`, () => {
    const agent = createAgent('claude');
    expect(agent.name).toBe('claude');
  });

  it(`createAgent('claude-code') returns agent named 'claude'`, () => {
    const agent = createAgent('claude-code');
    expect(agent.name).toBe('claude');
  });

  it('throws for unknown agent type', () => {
    expect(() => createAgent('nonexistent')).toThrow('Unsupported runner for this launch');
  });

  it('default (undefined) returns codex', () => {
    const agent = createAgent(undefined);
    expect(agent.name).toBe('codex');
  });
});

// ===========================================================================
// PROMPT BUILDER TESTS
// ===========================================================================

describe('buildAgentPrompt', () => {
  it('includes context when provided', () => {
    const prompt = buildAgentPrompt(
      { name: 'test', prompt: 'Do the thing', validate: [] } as any,
      'Project context here',
    );
    expect(prompt).toContain('## Project Context');
    expect(prompt).toContain('Project context here');
    expect(prompt).toContain('## Task');
    expect(prompt).toContain('Do the thing');
  });

  it('excludes context when empty', () => {
    const prompt = buildAgentPrompt(
      { name: 'test', prompt: 'Do the thing', validate: [] } as any,
      '',
    );
    expect(prompt).not.toContain('## Project Context');
    expect(prompt).toContain('## Task');
  });

  it('includes retry failure details', () => {
    const prompt = buildAgentPrompt(
      { name: 'test', prompt: 'Do the thing', validate: [] } as any,
      '',
      {
        failures: [
          { type: 'file_exists', target: 'index.ts', passed: false, details: 'File not found' },
        ],
      },
    );
    expect(prompt).toContain('## Previous Attempt Failed');
    expect(prompt).toContain('artifact_ready');
    expect(prompt).toContain('File not found');
  });
});

// ===========================================================================
// EXECUTOR EDGE CASES
// ===========================================================================

describe('Workspace reset with clean state tagging', () => {
  const wsDir = join(TEST_DIR, 'workspace-reset-test');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_COMMITTER_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_EMAIL: 'test@test.com',
  };

  beforeEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'original.txt'), 'original content');
    execSync('git init -q && git add -A && git commit -q -m "init" --allow-empty', {
      cwd: wsDir,
      stdio: 'ignore',
      env: gitEnv,
    });
    // Tag clean state
    execSync('git tag -f lockstep-clean-state', { cwd: wsDir, stdio: 'ignore' });
  });

  it('reset restores to tagged state even after agent commits', () => {
    // Simulate agent modifying and committing
    writeFileSync(join(wsDir, 'agent-file.txt'), 'agent wrote this');
    execSync('git add -A && git commit -q -m "agent commit"', { cwd: wsDir, stdio: 'ignore', env: gitEnv });

    // HEAD now points to agent's commit
    expect(existsSync(join(wsDir, 'agent-file.txt'))).toBe(true);

    // Reset to clean state
    execSync('git reset --hard lockstep-clean-state && git clean -fd', { cwd: wsDir, stdio: 'ignore' });

    // Agent's file should be gone
    expect(existsSync(join(wsDir, 'agent-file.txt'))).toBe(false);
    // Original file should be restored
    expect(readFileSync(join(wsDir, 'original.txt'), 'utf-8')).toBe('original content');
  });

  it('reset handles multiple agent commits', () => {
    // Agent makes 3 commits
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(wsDir, `file${i}.txt`), `content ${i}`);
      execSync(`git add -A && git commit -q -m "agent commit ${i}"`, { cwd: wsDir, stdio: 'ignore', env: gitEnv });
    }

    execSync('git reset --hard lockstep-clean-state && git clean -fd', { cwd: wsDir, stdio: 'ignore' });

    for (let i = 0; i < 3; i++) {
      expect(existsSync(join(wsDir, `file${i}.txt`))).toBe(false);
    }
  });
});

// ===========================================================================
// CRITERIA HASH COMPLETENESS
// ===========================================================================

describe('Criteria hash: all validator types have whitelists', () => {
  const types = [
    'file_exists', 'file_not_exists', 'file_contains', 'file_not_contains',
    'command_passes', 'command_output', 'api_responds', 'json_valid',
    'type_check', 'lint_passes', 'test_passes', 'ai_judge',
  ];

  for (const type of types) {
    it(`${type} has a whitelist entry (extra fields stripped)`, () => {
      // Pass a field that is NOT in any whitelist
      const normalized = normalizeCriteria([{
        type,
        target: 'x', command: 'x', path: 'x', url: 'x', criteria: 'x', threshold: 5,
        _bogus_field_not_in_any_whitelist: true,
      }]);
      // Known types should strip unknown fields
      expect(normalized[0]).not.toHaveProperty('_bogus_field_not_in_any_whitelist');
    });
  }
});

describe('Criteria hash: semantic fields change the hash', () => {
  it('changing command changes hash', () => {
    const h1 = computeCriteriaHash([{ type: 'command_passes', command: 'npm test' }]);
    const h2 = computeCriteriaHash([{ type: 'command_passes', command: 'npm run test' }]);
    expect(h1).not.toBe(h2);
  });

  it('changing threshold changes hash', () => {
    const h1 = computeCriteriaHash([{ type: 'ai_judge', criteria: 'quality', threshold: 7 }]);
    const h2 = computeCriteriaHash([{ type: 'ai_judge', criteria: 'quality', threshold: 8 }]);
    expect(h1).not.toBe(h2);
  });

  it('changing pattern changes hash', () => {
    const h1 = computeCriteriaHash([{ type: 'file_contains', path: 'x.ts', pattern: 'foo' }]);
    const h2 = computeCriteriaHash([{ type: 'file_contains', path: 'x.ts', pattern: 'bar' }]);
    expect(h1).not.toBe(h2);
  });
});
