/**
 * Test 10: End-to-end — generate a receipt and verify it
 *
 * We construct a complete receipt programmatically using the same functions
 * the executor uses, write it to disk, then verify it with `lockstep verify`.
 */
import { computeStepHash, computeCriteriaHash } from '../src/core/hasher.js';
import type { LockstepReceipt, StepProof, AttemptRecord } from '../src/core/hasher.js';
import { sha256, hashObject, hashFileBytes } from '../src/utils/crypto.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const TMP_DIR = path.resolve(import.meta.dirname, '..', '_test_tmp_e2e');
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

// --- Create a spec file to hash ---
const specContent = `version: "1"
steps:
  - name: "Initialize project"
    prompt: "Run npm init and create package.json"
    validate:
      - type: file_exists
        target: "package.json"
        label: "package.json created"
      - type: command_passes
        command: "node -e 'console.log(1)'"
  - name: "Add TypeScript"
    prompt: "Install typescript and create tsconfig.json"
    validate:
      - type: file_exists
        target: "tsconfig.json"
      - type: command_passes
        command: "npx tsc --version"
  - name: "Build project"
    prompt: "Create src/index.ts with a hello world function"
    validate:
      - type: file_exists
        target: "src/index.ts"
      - type: file_contains
        path: "src/index.ts"
        pattern: "function"
`;

const specPath = path.join(TMP_DIR, 'test-spec.yml');
writeFileSync(specPath, specContent);
const specHash = hashFileBytes(specPath);

// --- Build 3-step receipt with proper chaining ---
function buildAttempt(promptText: string, stdout: string): AttemptRecord {
  return {
    attempt_number: 1,
    prompt_hash: sha256(promptText),
    agent_stdout_hash: sha256(stdout),
    agent_stderr_hash: sha256(''),
    validations: [
      { type: 'file_exists', passed: true, message: 'File exists', required: true },
      { type: 'command_passes', passed: true, message: 'Command passed', required: true },
    ],
    all_required_passed: true,
    started_at: '2025-06-15T10:00:00Z',
    completed_at: '2025-06-15T10:01:00Z',
  };
}

// Step 1
const step1Criteria = computeCriteriaHash([
  { type: 'file_exists', target: 'package.json', label: 'package.json created' },
  { type: 'command_passes', command: 'node -e \'console.log(1)\'' },
]);

const step1Partial: Omit<StepProof, 'step_hash'> = {
  step_index: 0,
  step_name: 'Initialize project',
  criteria_hash: step1Criteria,
  attempts: [buildAttempt('Run npm init and create package.json', 'Done')],
  final_attempt: 1,
  all_passed: true,
  previous_step_hash: 'genesis',
};
const step1: StepProof = { ...step1Partial, step_hash: computeStepHash({ ...step1Partial, step_hash: '' }) };
// Fix: computeStepHash destructures out step_hash, so we need the full object
const step1Hash = hashObject(step1Partial);
const step1Final: StepProof = { ...step1Partial, step_hash: step1Hash };

// Step 2
const step2Criteria = computeCriteriaHash([
  { type: 'file_exists', target: 'tsconfig.json' },
  { type: 'command_passes', command: 'npx tsc --version' },
]);

const step2Partial: Omit<StepProof, 'step_hash'> = {
  step_index: 1,
  step_name: 'Add TypeScript',
  criteria_hash: step2Criteria,
  attempts: [buildAttempt('Install typescript and create tsconfig.json', 'TypeScript installed')],
  final_attempt: 1,
  all_passed: true,
  previous_step_hash: step1Hash,
};
const step2Hash = hashObject(step2Partial);
const step2Final: StepProof = { ...step2Partial, step_hash: step2Hash };

// Step 3
const step3Criteria = computeCriteriaHash([
  { type: 'file_exists', target: 'src/index.ts' },
  { type: 'file_contains', path: 'src/index.ts', pattern: 'function' },
]);

const step3Partial: Omit<StepProof, 'step_hash'> = {
  step_index: 2,
  step_name: 'Build project',
  criteria_hash: step3Criteria,
  attempts: [buildAttempt('Create src/index.ts with a hello world function', 'Created')],
  final_attempt: 1,
  all_passed: true,
  previous_step_hash: step2Hash,
};
const step3Hash = hashObject(step3Partial);
const step3Final: StepProof = { ...step3Partial, step_hash: step3Hash };

// --- Assemble receipt ---
const receipt: LockstepReceipt = {
  version: '1',
  hash_algorithm: 'sha256',
  canonicalization: 'json-stable-stringify',
  lockstep_version: '0.1.0',
  node_version: process.version,
  platform: process.platform,
  runner_cli_version: '1.0.0',
  spec_file: 'test-spec.yml',
  spec_hash: specHash,
  agent: 'codex',
  judge_model: 'provider-default',
  judge_mode: 'codex',
  judge_runs: 3,
  started_at: '2025-06-15T10:00:00Z',
  completed_at: '2025-06-15T10:03:00Z',
  total_steps: 3,
  steps_passed: 3,
  steps_failed: 0,
  step_proofs: [step1Final, step2Final, step3Final],
  chain_hash: step3Hash,
  status: 'completed',
};

// --- Verify chain integrity manually first ---
assert('Step 1 previous_step_hash is genesis', step1Final.previous_step_hash === 'genesis');
assert('Step 2 previous_step_hash links to step 1', step2Final.previous_step_hash === step1Hash);
assert('Step 3 previous_step_hash links to step 2', step3Final.previous_step_hash === step2Hash);
assert('chain_hash equals last step hash', receipt.chain_hash === step3Hash);

// Verify computeStepHash matches
const recomputed1 = computeStepHash(step1Final);
assert('computeStepHash(step1) matches stored hash', recomputed1 === step1Hash);

const recomputed2 = computeStepHash(step2Final);
assert('computeStepHash(step2) matches stored hash', recomputed2 === step2Hash);

const recomputed3 = computeStepHash(step3Final);
assert('computeStepHash(step3) matches stored hash', recomputed3 === step3Hash);

// --- Write receipt and verify via CLI ---
const receiptPath = path.join(TMP_DIR, 'receipt.json');
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

try {
  const output = execSync(
    `npx tsx src/bin/lockstep.ts verify "${receiptPath}"`,
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }
  );
  assert('lockstep verify exits 0 for valid receipt', true);
  assert('Verify output confirms validity', output.includes('VALID'));
} catch (err: any) {
  const output = (err.stdout || '') + (err.stderr || '');
  assert('lockstep verify exits 0 for valid receipt', false);
  console.log(`    Exit code: ${err.status}`);
  console.log(`    Output: ${output.substring(0, 300)}`);
}

// --- Cleanup ---
unlinkSync(specPath);
unlinkSync(receiptPath);
try { const { rmdirSync } = await import('node:fs'); rmdirSync(TMP_DIR); } catch {}

// --- Summary ---
if (passed) {
  console.log('PASS: All E2E receipt flow checks passed');
} else {
  console.log(`FAIL: ${failures.length} E2E receipt flow check(s) failed`);
}

process.exit(passed ? 0 : 1);
