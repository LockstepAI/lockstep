/**
 * Test 9: README has all required sections
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const README = readFileSync(path.resolve(import.meta.dirname, '..', 'README.md'), 'utf-8');

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

// Required sections (check for heading text, case insensitive)
const REQUIRED_SECTIONS = [
  { name: 'The Problem', pattern: /the\s+problem/i },
  { name: 'What Lockstep Proves', pattern: /what\s+lockstep\s+proves/i },
  { name: 'Quick Start', pattern: /quick\s+start/i },
  { name: 'How It Works', pattern: /how\s+it\s+works/i },
  { name: 'The Spec File', pattern: /the\s+spec\s+file/i },
  { name: 'The AI Judge', pattern: /the\s+ai\s+judge/i },
  { name: 'Verify Any Receipt', pattern: /verify\s+(any\s+)?receipt/i },
  { name: 'Validator Reference', pattern: /validator\s+reference/i },
  { name: 'Templates', pattern: /templates/i },
  { name: 'CLI Reference', pattern: /cli\s+reference/i },
  { name: 'Contributing', pattern: /contributing/i },
  { name: 'License', pattern: /license/i },
];

for (const section of REQUIRED_SECTIONS) {
  assert(`README has "${section.name}" section`, section.pattern.test(README));
}

// Check README has reasonable content
assert('README is at least 2000 characters', README.length >= 2000);
assert('README mentions lockstep', /lockstep/i.test(README));
assert('README includes code examples', README.includes('```'));
assert('README mentions installation', /install|npm|npx/i.test(README));

// --- Summary ---
if (passed) {
  console.log('PASS: All README quality checks passed');
} else {
  console.log(`FAIL: ${failures.length} README quality check(s) failed`);
}

process.exit(passed ? 0 : 1);
