/**
 * Test 3: Cryptographic hashing works
 *   - sha256 produces correct hashes
 *   - hashObject uses json-stable-stringify for canonical JSON
 *   - hashFileBytes hashes raw bytes
 */
import { sha256, hashObject, hashFileBytes } from '../src/utils/crypto.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

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

// --- Test sha256 basic ---
const expected256 = createHash('sha256').update('hello world').digest('hex');
assert('sha256("hello world") matches Node crypto', sha256('hello world') === expected256);

// --- Test sha256 with empty string ---
const expectedEmpty = createHash('sha256').update('').digest('hex');
assert('sha256("") matches Node crypto', sha256('') === expectedEmpty);

// --- Test hashObject determinism ---
// json-stable-stringify sorts keys, so {b:2,a:1} and {a:1,b:2} must produce same hash
const hash1 = hashObject({ b: 2, a: 1 });
const hash2 = hashObject({ a: 1, b: 2 });
assert('hashObject is key-order independent', hash1 === hash2);

// --- Test hashObject nested objects ---
const hash3 = hashObject({ z: { b: 2, a: 1 }, m: [3, 1, 2] });
const hash4 = hashObject({ m: [3, 1, 2], z: { a: 1, b: 2 } });
assert('hashObject is key-order independent for nested objects', hash3 === hash4);

// --- Test hashObject different values produce different hashes ---
const hash5 = hashObject({ a: 1 });
const hash6 = hashObject({ a: 2 });
assert('hashObject produces different hashes for different values', hash5 !== hash6);

// --- Test hashFileBytes ---
const tmpFile = path.resolve(import.meta.dirname, '..', '_test_tmp_file.bin');
const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
writeFileSync(tmpFile, content);
const fileHash = hashFileBytes(tmpFile);
const expectedFileHash = createHash('sha256').update(content).digest('hex');
assert('hashFileBytes matches direct Buffer hash', fileHash === expectedFileHash);
unlinkSync(tmpFile);

// --- Summary ---
if (passed) {
  console.log('PASS: All crypto integrity checks passed');
} else {
  console.log(`FAIL: ${failures.length} crypto check(s) failed`);
}

process.exit(passed ? 0 : 1);
