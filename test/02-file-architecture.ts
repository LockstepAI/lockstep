/**
 * Test 2: Public Codex-first launch files exist
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const EXPECTED_FILES = [
  'src/bin/lockstep.ts',
  'src/core/executor.ts',
  'src/core/hasher.ts',
  'src/core/parser.ts',
  'src/core/public-surface.ts',
  'src/agents/base.ts',
  'src/agents/codex.ts',
  'src/agents/factory.ts',
  'src/validators/base.ts',
  'src/validators/registry.ts',
  'src/validators/ai-judge.ts',
  'src/reporters/terminal.ts',
  'src/reporters/markdown-reporter.ts',
  'src/utils/crypto.ts',
  'src/utils/errors.ts',
  'src/utils/version.ts',
  'src/utils/config.ts',
  'src/policy/engine.ts',
  'src/policy/types.ts',
  'templates/blank.yml',
  'templates/nextjs-saas.yml',
  'templates/rest-api.yml',
  'templates/solana-program.yml',
  'package.json',
  'tsconfig.json',
  'README.md',
  '.eslintrc.json',
  '.gitignore',
];

let passed = true;
const missing: string[] = [];

for (const file of EXPECTED_FILES) {
  const fullPath = path.join(ROOT, file);
  if (!existsSync(fullPath)) {
    missing.push(file);
    passed = false;
  }
}

if (passed) {
  console.log(`PASS: All ${EXPECTED_FILES.length} public launch files exist`);
} else {
  console.log(`FAIL: ${missing.length} file(s) missing:`);
  for (const f of missing) {
    console.log(`  - ${f}`);
  }
}

process.exit(passed ? 0 : 1);
