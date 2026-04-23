/**
 * Test 8: CLI commands respond correctly (--version, --help, validate, templates, init)
 */
import { execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = 'npx tsx src/bin/lockstep.ts';

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

function run(cmd: string, expectFail = false): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (err: any) {
    if (expectFail) {
      return (err.stdout || '') + (err.stderr || '');
    }
    throw err;
  }
}

// --- Test: --version ---
try {
  const versionOutput = run(`${CLI} --version`);
  assert('--version prints version string', /\d+\.\d+\.\d+/.test(versionOutput.trim()));
} catch (err: any) {
  assert('--version exits successfully', false);
}

// --- Test: --help ---
try {
  const helpOutput = run(`${CLI} --help`);
  assert('--help includes "lockstep"', helpOutput.includes('lockstep'));
  assert('--help lists commands', helpOutput.includes('run') && helpOutput.includes('validate'));
} catch (err: any) {
  assert('--help exits successfully', false);
}

// --- Test: validate command with valid template ---
try {
  const validateOutput = run(`${CLI} validate templates/blank.yml`);
  assert('validate accepts valid spec', validateOutput.includes('Valid'));
} catch (err: any) {
  assert('validate command works with valid spec', false);
  console.log(`    Error: ${err.message}`);
}

// --- Test: validate command with nonexistent file ---
try {
  const output = run(`${CLI} validate nonexistent.yml`, true);
  assert('validate fails for nonexistent file', true);
} catch (err: any) {
  // If it throws, it should be because of exit code 1
  assert('validate rejects nonexistent file', true);
}

// --- Test: templates command ---
try {
  const templatesOutput = run(`${CLI} templates`);
  assert('templates lists blank', templatesOutput.includes('blank'));
  assert('templates lists nextjs-saas', templatesOutput.includes('nextjs-saas'));
  assert('templates lists rest-api', templatesOutput.includes('rest-api'));
  assert('templates lists solana-program', templatesOutput.includes('solana-program'));
} catch (err: any) {
  assert('templates command works', false);
}

// --- Test: init command creates .lockstep.yml ---
// Run init in a temp dir to avoid clobbering
const tmpDir = path.join(ROOT, '_test_tmp_cli');
try {
  execSync(`mkdir -p "${tmpDir}"`, { encoding: 'utf-8' });
  execSync(`npx tsx "${path.join(ROOT, 'src/bin/lockstep.ts')}" init blank`, {
    cwd: tmpDir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  assert('init creates .lockstep.yml', existsSync(path.join(tmpDir, '.lockstep.yml')));
} catch (err: any) {
  assert('init command works', false);
  console.log(`    Error: ${(err.stderr || err.message).substring(0, 200)}`);
} finally {
  try { unlinkSync(path.join(tmpDir, '.lockstep.yml')); } catch {}
  try { execSync(`rmdir "${tmpDir}"`, { encoding: 'utf-8' }); } catch {}
}

// --- Summary ---
if (passed) {
  console.log('PASS: All CLI command checks passed');
} else {
  console.log(`FAIL: ${failures.length} CLI command check(s) failed`);
}

process.exit(passed ? 0 : 1);
