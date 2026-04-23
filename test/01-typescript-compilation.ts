/**
 * Test 1: TypeScript compiles with zero errors
 */
import { execSync } from 'node:child_process';

let passed = true;

try {
  const output = execSync('npx tsc --noEmit', {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  console.log('PASS: TypeScript compiles with zero errors');
} catch (err: any) {
  passed = false;
  const stderr = err.stderr || err.stdout || err.message;
  console.log('FAIL: TypeScript compilation errors detected');
  console.log(stderr);
}

process.exit(passed ? 0 : 1);
