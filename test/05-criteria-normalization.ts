/**
 * Test 5: Criteria normalization strips non-semantic fields and materializes defaults
 */
import { normalizeCriteria, computeCriteriaHash } from '../src/core/hasher.js';

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

// --- Test: label and description are stripped ---
const withLabel = [
  { type: 'file_exists', target: 'foo.ts', label: 'Check foo', optional: false },
];
const withoutLabel = [
  { type: 'file_exists', target: 'foo.ts', optional: false },
];
const norm1 = normalizeCriteria(withLabel);
const norm2 = normalizeCriteria(withoutLabel);

assert('label is stripped from normalized output', !('label' in norm1[0]));
assert('Normalized output matches regardless of label presence',
  JSON.stringify(norm1) === JSON.stringify(norm2));

// --- Test: defaults are materialized ---
const minimal = [{ type: 'file_exists', target: 'bar.ts' }];
const norm3 = normalizeCriteria(minimal);
assert('optional defaults to false', norm3[0].optional === false);

// --- Test: file_contains defaults ---
const fileContains = [{ type: 'file_contains', path: 'x.ts', pattern: 'export' }];
const normFC = normalizeCriteria(fileContains);
assert('file_contains: is_regex defaults to false', normFC[0].is_regex === false);
assert('file_contains: optional defaults to false', normFC[0].optional === false);

// --- Test: only whitelisted fields survive for known types ---
const withExtra = [
  { type: 'command_passes', command: 'echo hi', label: 'test', description: 'desc', extra_field: 42 },
];
const normExtra = normalizeCriteria(withExtra);
assert('Extra fields are stripped from known types', !('extra_field' in normExtra[0]));
assert('label stripped from known type', !('label' in normExtra[0]));
assert('description stripped from known type', !('description' in normExtra[0]));

// --- Test: ai_judge field defaults ---
const aiJudge = [
  { type: 'ai_judge', criteria: 'Quality check', threshold: 7 },
];
const normAJ = normalizeCriteria(aiJudge);
assert('ai_judge: max_variance defaults to null', normAJ[0].max_variance === null);
assert('ai_judge: evaluation_method defaults to file_content', normAJ[0].evaluation_method === 'file_content');
assert('ai_judge: timeout defaults to null', normAJ[0].timeout === null);
assert('ai_judge: optional defaults to false', normAJ[0].optional === false);

// --- Test: deterministic hashing ---
const hash1 = computeCriteriaHash([
  { type: 'file_exists', target: 'a.ts', label: 'Labeled' },
]);
const hash2 = computeCriteriaHash([
  { type: 'file_exists', target: 'a.ts' },
]);
assert('computeCriteriaHash ignores labels', hash1 === hash2);

// --- Test: different criteria produce different hashes ---
const hash3 = computeCriteriaHash([{ type: 'file_exists', target: 'a.ts' }]);
const hash4 = computeCriteriaHash([{ type: 'file_exists', target: 'b.ts' }]);
assert('Different targets produce different hashes', hash3 !== hash4);

// --- Test: public alias types normalize to the same hash ---
const publicAliasHash = computeCriteriaHash([{ type: 'artifact_ready', target: 'a.ts' } as any]);
assert('Public alias types hash the same as internal types', publicAliasHash === hash3);

// --- Test: unknown validator types ---
const unknown = [
  { type: 'custom_validator', foo: 'bar', label: 'Custom', description: 'A custom one' },
];
const normUnknown = normalizeCriteria(unknown);
assert('Unknown type: label is stripped', !('label' in normUnknown[0]));
assert('Unknown type: description is stripped', !('description' in normUnknown[0]));
assert('Unknown type: other fields preserved', normUnknown[0].foo === 'bar');
assert('Unknown type: optional materialized', normUnknown[0].optional === false);

// --- Summary ---
if (passed) {
  console.log('PASS: All criteria normalization checks passed');
} else {
  console.log(`FAIL: ${failures.length} criteria normalization check(s) failed`);
}

process.exit(passed ? 0 : 1);
