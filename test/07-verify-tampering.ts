/**
 * Test 7: lockstep verify detects tampering (modified hashes, broken chains)
 */
import { computeStepHash, computeCriteriaHash } from '../src/core/hasher.js';
import type { LockstepReceipt, StepProof, AttemptRecord } from '../src/core/hasher.js';
import { hashObject } from '../src/utils/crypto.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const TMP_DIR = path.resolve(import.meta.dirname, '..', '_test_tmp_verify');
mkdirSync(TMP_DIR, { recursive: true });

let passed = true;
const failures: string[] = [];

function assert(label: string, condition: boolean) {
  if (!condition) {
    passed = false;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  } else {
    console.log(`  PASS: ${label}`);
  }
}

// Build a valid receipt programmatically
function buildValidReceipt(): LockstepReceipt {
  const attempt: AttemptRecord = {
    attempt_number: 1,
    prompt_hash: hashObject('test prompt'),
    agent_stdout_hash: hashObject('test stdout'),
    agent_stderr_hash: hashObject(''),
    validations: [
      { type: 'file_exists', passed: true, message: 'File exists', required: true },
    ],
    all_required_passed: true,
    started_at: '2025-01-01T00:00:00Z',
    completed_at: '2025-01-01T00:01:00Z',
  };

  const criteriaHash = computeCriteriaHash([
    { type: 'file_exists', target: 'package.json' },
  ]);

  const step1Partial: Omit<StepProof, 'step_hash'> = {
    step_index: 0,
    step_name: 'Step 1',
    criteria_hash: criteriaHash,
    attempts: [attempt],
    final_attempt: 1,
    all_passed: true,
    previous_step_hash: 'genesis',
  };
  const step1Hash = hashObject(step1Partial);
  const step1: StepProof = { ...step1Partial, step_hash: step1Hash };

  const step2Partial: Omit<StepProof, 'step_hash'> = {
    step_index: 1,
    step_name: 'Step 2',
    criteria_hash: criteriaHash,
    attempts: [attempt],
    final_attempt: 1,
    all_passed: true,
    previous_step_hash: step1Hash,
  };
  const step2Hash = hashObject(step2Partial);
  const step2: StepProof = { ...step2Partial, step_hash: step2Hash };

  return {
    version: '1',
    hash_algorithm: 'sha256',
    canonicalization: 'json-stable-stringify',
    lockstep_version: '0.1.0',
    node_version: process.version,
    platform: process.platform,
    runner_cli_version: 'test',
    spec_file: 'nonexistent.yml',
    spec_hash: 'abc123',
    agent: 'codex',
    judge_model: 'provider-default',
    judge_mode: 'codex',
    judge_runs: 3,
    started_at: '2025-01-01T00:00:00Z',
    completed_at: '2025-01-01T00:02:00Z',
    total_steps: 2,
    steps_passed: 2,
    steps_failed: 0,
    step_proofs: [step1, step2],
    chain_hash: step2Hash,
    status: 'completed',
  };
}

// --- Test: valid receipt passes verify ---
const validReceipt = buildValidReceipt();
const validPath = path.join(TMP_DIR, 'valid-receipt.json');
writeFileSync(validPath, JSON.stringify(validReceipt, null, 2));

try {
  execSync(`npx tsx src/bin/lockstep.ts verify "${validPath}"`, {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert('Valid receipt passes verification', true);
} catch (err: any) {
  // It might exit 0 but output still gets captured, or exit non-zero
  // The spec hash won't match because spec file doesn't exist, but chain should be valid
  // Check if it's the spec file warning vs actual chain failure
  const output = (err.stdout || '') + (err.stderr || '');
  // The verify command exits 0 if chain is valid even with spec file warning
  assert('Valid receipt passes verification', false);
  console.log(`    Output: ${output.substring(0, 200)}`);
}

// --- Test: tampered step hash detected ---
const tamperedHash = buildValidReceipt();
tamperedHash.step_proofs[0].step_hash = 'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd';
// Also update chain to make chain_hash still point to last step
tamperedHash.chain_hash = tamperedHash.step_proofs[1].step_hash;

const tamperedHashPath = path.join(TMP_DIR, 'tampered-hash.json');
writeFileSync(tamperedHashPath, JSON.stringify(tamperedHash, null, 2));

try {
  execSync(`npx tsx src/bin/lockstep.ts verify "${tamperedHashPath}"`, {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert('Tampered step hash is detected', false);
} catch (err: any) {
  // Non-zero exit means tampering detected
  assert('Tampered step hash is detected (exit code 1)', err.status === 1);
}

// --- Test: broken chain link detected ---
const brokenChain = buildValidReceipt();
brokenChain.step_proofs[1].previous_step_hash = 'wrong_hash_value';
// Recompute step2 hash with broken previous link
const { step_hash: _, ...hashable } = brokenChain.step_proofs[1];
brokenChain.step_proofs[1].step_hash = hashObject(hashable);
brokenChain.chain_hash = brokenChain.step_proofs[1].step_hash;

const brokenChainPath = path.join(TMP_DIR, 'broken-chain.json');
writeFileSync(brokenChainPath, JSON.stringify(brokenChain, null, 2));

try {
  execSync(`npx tsx src/bin/lockstep.ts verify "${brokenChainPath}"`, {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert('Broken chain link is detected', false);
} catch (err: any) {
  assert('Broken chain link is detected (exit code 1)', err.status === 1);
}

// --- Test: mismatched chain_hash detected ---
const badChainHash = buildValidReceipt();
badChainHash.chain_hash = 'wrong_final_hash';

const badChainHashPath = path.join(TMP_DIR, 'bad-chain-hash.json');
writeFileSync(badChainHashPath, JSON.stringify(badChainHash, null, 2));

try {
  execSync(`npx tsx src/bin/lockstep.ts verify "${badChainHashPath}"`, {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert('Mismatched chain_hash is detected', false);
} catch (err: any) {
  assert('Mismatched chain_hash is detected (exit code 1)', err.status === 1);
}

// --- Test: step count mismatch detected ---
const stepCountBad = buildValidReceipt();
stepCountBad.total_steps = 5; // says 5 but only 2 proofs

const stepCountPath = path.join(TMP_DIR, 'step-count-bad.json');
writeFileSync(stepCountPath, JSON.stringify(stepCountBad, null, 2));

try {
  execSync(`npx tsx src/bin/lockstep.ts verify "${stepCountPath}"`, {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert('Step count mismatch is detected', false);
} catch (err: any) {
  assert('Step count mismatch is detected (exit code 1)', err.status === 1);
}

// --- Cleanup ---
unlinkSync(validPath);
unlinkSync(tamperedHashPath);
unlinkSync(brokenChainPath);
unlinkSync(badChainHashPath);
unlinkSync(stepCountPath);
try { const { rmdirSync } = await import('node:fs'); rmdirSync(TMP_DIR); } catch {}

// --- Summary ---
if (passed) {
  console.log('PASS: All tampering detection checks passed');
} else {
  console.log(`FAIL: ${failures.length} tampering detection check(s) failed`);
}

process.exit(passed ? 0 : 1);
