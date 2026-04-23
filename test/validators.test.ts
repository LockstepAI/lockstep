import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runValidation } from '../src/validators/registry.js';

const TEST_DIR = join(process.cwd(), '.test-validators-' + Date.now());
const ctx = { workingDirectory: TEST_DIR };

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'Hello World\n');
  writeFileSync(join(TEST_DIR, 'data.json'), '{"name":"test","version":"1.0"}');
  writeFileSync(join(TEST_DIR, 'bad.json'), 'not json{{{');
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('file_exists', () => {
  it('passes for existing file', async () => {
    const r = await runValidation({ type: 'file_exists', target: 'hello.txt' }, ctx);
    expect(r.passed).toBe(true);
  });

  it('fails for missing file', async () => {
    const r = await runValidation({ type: 'file_exists', target: 'nope.txt' }, ctx);
    expect(r.passed).toBe(false);
  });
});

describe('file_not_exists', () => {
  it('passes for missing file', async () => {
    const r = await runValidation({ type: 'file_not_exists', target: 'nope.txt' }, ctx);
    expect(r.passed).toBe(true);
  });

  it('fails for existing file', async () => {
    const r = await runValidation({ type: 'file_not_exists', target: 'hello.txt' }, ctx);
    expect(r.passed).toBe(false);
  });
});

describe('file_contains', () => {
  it('passes when pattern found', async () => {
    const r = await runValidation({ type: 'file_contains', path: 'hello.txt', pattern: 'Hello' }, ctx);
    expect(r.passed).toBe(true);
  });

  it('fails when pattern not found', async () => {
    const r = await runValidation({ type: 'file_contains', path: 'hello.txt', pattern: 'Goodbye' }, ctx);
    expect(r.passed).toBe(false);
  });

  it('supports regex', async () => {
    const r = await runValidation({ type: 'file_contains', path: 'hello.txt', pattern: 'H[eE]llo', is_regex: true }, ctx);
    expect(r.passed).toBe(true);
  });
});

describe('file_not_contains', () => {
  it('passes when pattern absent', async () => {
    const r = await runValidation({ type: 'file_not_contains', path: 'hello.txt', pattern: 'Goodbye' }, ctx);
    expect(r.passed).toBe(true);
  });

  it('fails when pattern found', async () => {
    const r = await runValidation({ type: 'file_not_contains', path: 'hello.txt', pattern: 'Hello' }, ctx);
    expect(r.passed).toBe(false);
  });
});

describe('command_passes', () => {
  it('passes for exit code 0', async () => {
    const r = await runValidation({ type: 'command_passes', command: 'echo ok' }, ctx);
    expect(r.passed).toBe(true);
  });

  it('fails for non-zero exit', async () => {
    const r = await runValidation({ type: 'command_passes', command: 'exit 1' }, ctx);
    expect(r.passed).toBe(false);
  });
});

describe('command_output', () => {
  it('passes when stdout matches pattern', async () => {
    const r = await runValidation({ type: 'command_output', command: 'echo hello world', pattern: 'hello' }, ctx);
    expect(r.passed).toBe(true);
  });

  it('fails when stdout does not match', async () => {
    const r = await runValidation({ type: 'command_output', command: 'echo hello', pattern: 'goodbye' }, ctx);
    expect(r.passed).toBe(false);
  });
});

describe('json_valid', () => {
  it('passes for valid json', async () => {
    const r = await runValidation({ type: 'json_valid', path: 'data.json' }, ctx);
    expect(r.passed).toBe(true);
  });

  it('fails for invalid json', async () => {
    const r = await runValidation({ type: 'json_valid', path: 'bad.json' }, ctx);
    expect(r.passed).toBe(false);
  });
});

describe('unknown validator', () => {
  it('fails gracefully', async () => {
    const r = await runValidation({ type: 'nonexistent_type', target: 'x' }, ctx);
    expect(r.passed).toBe(false);
  });
});
