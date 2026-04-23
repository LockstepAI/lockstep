/**
 * Test 6: All 4 templates validate without errors
 */
import { validateSpec } from '../src/core/parser.js';
import path from 'node:path';

const TEMPLATES_DIR = path.resolve(import.meta.dirname, '..', 'templates');

const TEMPLATES = ['blank.yml', 'nextjs-saas.yml', 'rest-api.yml', 'solana-program.yml'];

let passed = true;
const failures: string[] = [];

for (const tmpl of TEMPLATES) {
  const tmplPath = path.join(TEMPLATES_DIR, tmpl);
  const result = validateSpec(tmplPath);
  if (result.valid) {
    console.log(`  PASS: ${tmpl} validates successfully`);
  } else {
    passed = false;
    failures.push(tmpl);
    console.log(`  FAIL: ${tmpl} has validation errors:`);
    if (result.errors) {
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    }
  }
}

if (passed) {
  console.log(`PASS: All ${TEMPLATES.length} templates validate without errors`);
} else {
  console.log(`FAIL: ${failures.length} template(s) failed validation`);
}

process.exit(passed ? 0 : 1);
