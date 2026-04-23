/**
 * Extended hasher tests — covers normalizeCriteria edge cases, hash
 * determinism, ordering sensitivity, and step_hash exclusion.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeCriteria,
  computeCriteriaHash,
  computeStepHash,
} from '../src/core/hasher.js';
import type { StepProof } from '../src/core/hasher.js';

// ===========================================================================
// normalizeCriteria
// ===========================================================================

describe('normalizeCriteria', () => {
  it('strips label from known validator types', () => {
    const result = normalizeCriteria([
      { type: 'file_exists', target: 'index.ts', label: 'Check file' },
    ]);
    expect(result[0]).not.toHaveProperty('label');
    expect(result[0]).toHaveProperty('type', 'file_exists');
    expect(result[0]).toHaveProperty('target', 'index.ts');
  });

  it('strips description from known validator types', () => {
    const result = normalizeCriteria([
      { type: 'command_passes', command: 'echo ok', description: 'sanity check' },
    ]);
    expect(result[0]).not.toHaveProperty('description');
    expect(result[0]).toHaveProperty('command', 'echo ok');
  });

  it('retains only whitelisted fields for file_exists', () => {
    const result = normalizeCriteria([
      {
        type: 'file_exists',
        target: 'app.ts',
        label: 'discard me',
        description: 'discard me too',
        custom_field: 'should be gone',
        optional: true,
      },
    ]);
    const keys = Object.keys(result[0]);
    expect(keys).toContain('type');
    expect(keys).toContain('target');
    expect(keys).toContain('optional');
    expect(keys).not.toContain('label');
    expect(keys).not.toContain('description');
    expect(keys).not.toContain('custom_field');
  });

  it('retains only whitelisted fields for file_contains', () => {
    const result = normalizeCriteria([
      {
        type: 'file_contains',
        path: 'hello.txt',
        pattern: 'world',
        is_regex: true,
        label: 'remove',
        extra_stuff: 42,
      },
    ]);
    expect(result[0]).toHaveProperty('type', 'file_contains');
    expect(result[0]).toHaveProperty('path', 'hello.txt');
    expect(result[0]).toHaveProperty('pattern', 'world');
    expect(result[0]).toHaveProperty('is_regex', true);
    expect(result[0]).not.toHaveProperty('label');
    expect(result[0]).not.toHaveProperty('extra_stuff');
  });

  it('materializes optional: false as default', () => {
    const result = normalizeCriteria([
      { type: 'file_exists', target: 'x.ts' },
    ]);
    expect(result[0]).toHaveProperty('optional', false);
  });

  it('materializes is_regex: false as default for file_contains', () => {
    const result = normalizeCriteria([
      { type: 'file_contains', path: 'a.txt', pattern: 'hello' },
    ]);
    expect(result[0]).toHaveProperty('is_regex', false);
  });

  it('unknown validator type keeps all non-label/description fields', () => {
    const result = normalizeCriteria([
      {
        type: 'my_custom_validator',
        target: 'x',
        foo: 'bar',
        baz: 123,
        label: 'should be stripped',
        description: 'should also be stripped',
      },
    ]);
    expect(result[0]).toHaveProperty('type', 'my_custom_validator');
    expect(result[0]).toHaveProperty('target', 'x');
    expect(result[0]).toHaveProperty('foo', 'bar');
    expect(result[0]).toHaveProperty('baz', 123);
    expect(result[0]).not.toHaveProperty('label');
    expect(result[0]).not.toHaveProperty('description');
    // Unknown types still get optional materialized
    expect(result[0]).toHaveProperty('optional', false);
  });

  it('is idempotent (normalizing twice gives the same result)', () => {
    const input = [
      {
        type: 'file_contains',
        path: 'x.ts',
        pattern: 'hello',
        label: 'to strip',
        description: 'also strip',
      },
    ];
    const first = normalizeCriteria(input);
    const second = normalizeCriteria(first);
    expect(second).toEqual(first);
  });
});

// ===========================================================================
// computeCriteriaHash
// ===========================================================================

describe('computeCriteriaHash', () => {
  it('order of validators matters ([A,B] != [B,A])', () => {
    const a = { type: 'file_exists', target: 'a.ts' };
    const b = { type: 'file_exists', target: 'b.ts' };

    const h1 = computeCriteriaHash([a, b]);
    const h2 = computeCriteriaHash([b, a]);
    expect(h1).not.toBe(h2);
  });

  it('explicit optional:false matches implicit default', () => {
    const h1 = computeCriteriaHash([
      { type: 'file_exists', target: 'index.ts' },
    ]);
    const h2 = computeCriteriaHash([
      { type: 'file_exists', target: 'index.ts', optional: false },
    ]);
    expect(h1).toBe(h2);
  });

  it('explicit is_regex:false matches implicit default for file_contains', () => {
    const h1 = computeCriteriaHash([
      { type: 'file_contains', path: 'f.txt', pattern: 'p' },
    ]);
    const h2 = computeCriteriaHash([
      { type: 'file_contains', path: 'f.txt', pattern: 'p', is_regex: false },
    ]);
    expect(h1).toBe(h2);
  });

  it('produces a 64-char hex string', () => {
    const h = computeCriteriaHash([
      { type: 'command_passes', command: 'echo hi' },
    ]);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ===========================================================================
// computeStepHash
// ===========================================================================

describe('computeStepHash', () => {
  const baseProof: StepProof = {
    step_index: 0,
    step_name: 'build',
    criteria_hash: 'abc123',
    attempts: [],
    final_attempt: 0,
    all_passed: true,
    previous_step_hash: 'genesis',
    step_hash: '',
  };

  it('step_hash field is excluded from computation', () => {
    const proof1 = { ...baseProof, step_hash: 'x' };
    const proof2 = { ...baseProof, step_hash: 'y' };
    const proof3 = { ...baseProof, step_hash: 'completely-different-value' };

    const h1 = computeStepHash(proof1);
    const h2 = computeStepHash(proof2);
    const h3 = computeStepHash(proof3);

    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('is consistent across 100 calls', () => {
    const expected = computeStepHash(baseProof);
    for (let i = 0; i < 100; i++) {
      expect(computeStepHash(baseProof)).toBe(expected);
    }
  });

  it('different step_name produces different hash', () => {
    const proof2 = { ...baseProof, step_name: 'deploy' };
    expect(computeStepHash(baseProof)).not.toBe(computeStepHash(proof2));
  });

  it('different all_passed produces different hash', () => {
    const proof2 = { ...baseProof, all_passed: false };
    expect(computeStepHash(baseProof)).not.toBe(computeStepHash(proof2));
  });

  it('produces a 64-char hex string', () => {
    const h = computeStepHash(baseProof);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
