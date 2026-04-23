import { describe, it, expect } from 'vitest';
import { sha256, hashObject, hashFileBytes } from '../src/utils/crypto.js';
import { computeStepHash, computeCriteriaHash } from '../src/core/hasher.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('sha256', () => {
  it('produces consistent hashes', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
  });

  it('produces different hashes for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('returns 64-char hex string', () => {
    expect(sha256('test')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('hashObject', () => {
  it('is key-order invariant', () => {
    expect(hashObject({ b: 2, a: 1 })).toBe(hashObject({ a: 1, b: 2 }));
  });

  it('different values produce different hashes', () => {
    expect(hashObject({ x: 1 })).not.toBe(hashObject({ x: 2 }));
  });

  it('nested objects are key-order invariant', () => {
    const a = hashObject({ outer: { z: 1, a: 2 } });
    const b = hashObject({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });
});

describe('hashFileBytes', () => {
  it('hashes file content', () => {
    const tmp = join(tmpdir(), 'lockstep-test-' + Date.now());
    writeFileSync(tmp, 'test content');
    const hash = hashFileBytes(tmp);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    unlinkSync(tmp);
  });
});

describe('computeCriteriaHash', () => {
  it('strips labels from criteria', () => {
    const h1 = computeCriteriaHash([{ type: 'file_exists', target: '/a', label: 'Label A' }]);
    const h2 = computeCriteriaHash([{ type: 'file_exists', target: '/a', label: 'Label B' }]);
    expect(h1).toBe(h2);
  });

  it('preserves semantic differences', () => {
    const h1 = computeCriteriaHash([{ type: 'file_exists', target: '/a' }]);
    const h2 = computeCriteriaHash([{ type: 'file_exists', target: '/b' }]);
    expect(h1).not.toBe(h2);
  });

  it('order matters', () => {
    const a = { type: 'file_exists', target: '/a' };
    const b = { type: 'file_exists', target: '/b' };
    expect(computeCriteriaHash([a, b])).not.toBe(computeCriteriaHash([b, a]));
  });

  it('materializes defaults', () => {
    const h1 = computeCriteriaHash([{ type: 'file_exists', target: '/a' }]);
    const h2 = computeCriteriaHash([{ type: 'file_exists', target: '/a', optional: false }]);
    expect(h1).toBe(h2);
  });
});

describe('computeStepHash', () => {
  it('produces consistent hash for same proof', () => {
    const proof = {
      step_index: 0,
      step_name: 'test',
      criteria_hash: 'abc',
      attempts: [],
      final_attempt: 0,
      all_passed: true,
      previous_step_hash: 'genesis',
      step_hash: '',
    };
    const h1 = computeStepHash(proof);
    const h2 = computeStepHash(proof);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('different proofs produce different hashes', () => {
    const base = {
      step_index: 0,
      step_name: 'test',
      criteria_hash: 'abc',
      attempts: [],
      final_attempt: 0,
      all_passed: true,
      previous_step_hash: 'genesis',
      step_hash: '',
    };
    const h1 = computeStepHash(base);
    const h2 = computeStepHash({ ...base, step_name: 'different' });
    expect(h1).not.toBe(h2);
  });
});
