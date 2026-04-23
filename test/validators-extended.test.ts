/**
 * Extended validator tests — covers edge cases and behaviors not exercised
 * in the existing validators.test.ts or audit-fixes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { runValidation } from '../src/validators/registry.js';

// ---------------------------------------------------------------------------
// Test workspace
// ---------------------------------------------------------------------------

const TEST_DIR = join(process.cwd(), '.test-validators-ext-' + Date.now());
const ctx = { workingDirectory: TEST_DIR, stepTimeout: 30 };

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });

  // Empty file
  writeFileSync(join(TEST_DIR, 'empty.txt'), '');

  // A subdirectory
  mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true });

  // Symlink pointing to a real file
  writeFileSync(join(TEST_DIR, 'real-target.txt'), 'symlink target content');
  symlinkSync(
    join(TEST_DIR, 'real-target.txt'),
    join(TEST_DIR, 'link-to-real.txt'),
  );

  // Dangling symlink
  symlinkSync(
    join(TEST_DIR, 'nonexistent-target.txt'),
    join(TEST_DIR, 'dangling-link.txt'),
  );

  // Multiline file for file_contains tests
  writeFileSync(
    join(TEST_DIR, 'multiline.txt'),
    'first line\nSECOND LINE\nthird line\n',
  );

  // Valid JSON files for json_valid tests
  writeFileSync(join(TEST_DIR, 'obj.json'), '{"name":"test","version":"1.0","author":"me"}');
  writeFileSync(join(TEST_DIR, 'empty-obj.json'), '{}');
  writeFileSync(join(TEST_DIR, 'array.json'), '[1,2,3]');
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ===========================================================================
// file_exists — extended
// ===========================================================================

describe('file_exists (extended)', () => {
  it('accepts the public artifact_ready alias', async () => {
    const r = await runValidation(
      { type: 'artifact_ready', target: 'empty.txt' } as any,
      ctx,
    );
    expect(r.passed).toBe(true);
    expect(r.type).toBe('file_exists');
  });

  it('passes for an empty file', async () => {
    const r = await runValidation(
      { type: 'file_exists', target: 'empty.txt' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('passes for a directory as target', async () => {
    const r = await runValidation(
      { type: 'file_exists', target: 'subdir' },
      ctx,
    );
    // existsSync returns true for directories
    expect(r.passed).toBe(true);
  });

  it('passes for a valid symlink', async () => {
    const r = await runValidation(
      { type: 'file_exists', target: 'link-to-real.txt' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('fails for a dangling symlink', async () => {
    const r = await runValidation(
      { type: 'file_exists', target: 'dangling-link.txt' },
      ctx,
    );
    // existsSync follows symlinks and returns false if target is missing
    expect(r.passed).toBe(false);
  });
});

// ===========================================================================
// file_contains — extended
// ===========================================================================

describe('file_contains (extended)', () => {
  it('fails with error details when file does not exist', async () => {
    const r = await runValidation(
      { type: 'file_contains', path: 'does-not-exist.txt', pattern: 'foo' },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.details).toContain('Error reading file');
  });

  it('multiline regex with ^ and $ matches inner lines', async () => {
    const r = await runValidation(
      {
        type: 'file_contains',
        path: 'multiline.txt',
        pattern: '^SECOND LINE$',
        is_regex: true,
      },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('multiline regex ^ does not match middle of a line', async () => {
    const r = await runValidation(
      {
        type: 'file_contains',
        path: 'multiline.txt',
        pattern: '^ECOND',
        is_regex: true,
      },
      ctx,
    );
    expect(r.passed).toBe(false);
  });
});

// ===========================================================================
// command_passes — extended
// ===========================================================================

describe('command_passes (extended)', () => {
  it('timeout kills a long-running command', async () => {
    const r = await runValidation(
      { type: 'command_passes', command: 'sleep 10', timeout: 1 },
      ctx,
    );
    expect(r.passed).toBe(false);
    // Duration should be roughly around the timeout, not 10 seconds
    expect(r.duration_ms).toBeDefined();
    expect(r.duration_ms!).toBeLessThan(5000);
  });

  it('captures stdout_hash and stderr_hash as 64-char hex strings', async () => {
    const r = await runValidation(
      { type: 'command_passes', command: 'echo deterministic' },
      ctx,
    );
    expect(r.passed).toBe(true);
    expect(r.stdout_hash).toBeDefined();
    expect(r.stdout_hash).toHaveLength(64);
    expect(r.stdout_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stderr_hash).toBeDefined();
    expect(r.stderr_hash).toHaveLength(64);
    expect(r.stderr_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs in the correct workingDirectory', async () => {
    const r = await runValidation(
      { type: 'command_passes', command: 'pwd' },
      { workingDirectory: TEST_DIR },
    );
    expect(r.passed).toBe(true);
    // The validator itself doesn't expose stdout on pass, but we can verify via
    // command_output which uses the same executeCommand under the hood
    const r2 = await runValidation(
      { type: 'command_output', command: 'pwd', pattern: TEST_DIR },
      { workingDirectory: TEST_DIR },
    );
    expect(r2.passed).toBe(true);
  });
});

// ===========================================================================
// command_output — extended
// ===========================================================================

describe('command_output (extended)', () => {
  it('supports regex matching', async () => {
    const r = await runValidation(
      {
        type: 'command_output',
        command: 'echo "version 3.14.2"',
        pattern: 'version \\d+\\.\\d+\\.\\d+',
        is_regex: true,
      },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('strips ANSI escape codes before matching', async () => {
    const r = await runValidation(
      {
        type: 'command_output',
        command: "printf '\\x1b[31mhello\\x1b[0m'",
        pattern: 'hello',
      },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('fails when exit code is nonzero even if pattern matches stdout', async () => {
    const r = await runValidation(
      {
        type: 'command_output',
        command: 'echo "expected output" && exit 1',
        pattern: 'expected output',
      },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.exit_code).toBe(1);
    expect(r.details).toContain('exited with code');
  });
});

// ===========================================================================
// test_passes — extended
// ===========================================================================

describe('test_passes (extended)', () => {
  it('respects per-validator timeout override', async () => {
    // The validator config.timeout overrides context.stepTimeout
    const r = await runValidation(
      { type: 'test_passes', command: 'sleep 10', timeout: 1 },
      { workingDirectory: TEST_DIR, stepTimeout: 300 },
    );
    expect(r.passed).toBe(false);
    expect(r.duration_ms).toBeDefined();
    expect(r.duration_ms!).toBeLessThan(5000);
  });
});

// ===========================================================================
// lint_passes — extended
// ===========================================================================

describe('lint_passes (extended)', () => {
  it('uses "npx eslint ." as the default command', async () => {
    // When no command is specified, lint_passes should run 'npx eslint .'
    // which will likely fail in our temp directory (no eslint config).
    // We just need to verify the target is set to the default command.
    const r = await runValidation(
      { type: 'lint_passes' },
      ctx,
    );
    expect(r.target).toBe('npx eslint .');
  });
});

// ===========================================================================
// type_check — extended
// ===========================================================================

describe('type_check (extended)', () => {
  it('uses "npx tsc --noEmit" as the default command', async () => {
    const r = await runValidation(
      { type: 'type_check' },
      ctx,
    );
    expect(r.target).toBe('npx tsc --noEmit');
  });
});

// ===========================================================================
// json_valid — extended
// ===========================================================================

describe('json_valid (extended)', () => {
  it('passes when schema required keys are present', async () => {
    const r = await runValidation(
      {
        type: 'json_valid',
        path: 'obj.json',
        schema: { required: ['name', 'version'] },
      },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('fails when a required key is missing', async () => {
    const r = await runValidation(
      {
        type: 'json_valid',
        path: 'obj.json',
        schema: { required: ['name', 'missing_key'] },
      },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.details).toContain('missing_key');
  });

  it('passes for an empty JSON object without schema', async () => {
    const r = await runValidation(
      { type: 'json_valid', path: 'empty-obj.json' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('passes for a JSON array', async () => {
    const r = await runValidation(
      { type: 'json_valid', path: 'array.json' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('fails for a non-existent file', async () => {
    const r = await runValidation(
      { type: 'json_valid', path: 'no-such-file.json' },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.details).toContain('Error reading file');
  });
});

// ===========================================================================
// api_responds — extended
// ===========================================================================

describe('api_responds (extended)', () => {
  it('fails on connection refused (nothing listening on port 1)', async () => {
    const r = await runValidation(
      { type: 'api_responds', url: 'http://127.0.0.1:1', status: 200, timeout: 2 },
      ctx,
    );
    expect(r.passed).toBe(false);
    expect(r.details).toBeDefined();
  });

  it('fails with timeout message when request takes too long', async () => {
    // Use a non-routable IP to trigger a real timeout
    const r = await runValidation(
      { type: 'api_responds', url: 'http://192.0.2.1:1', status: 200, timeout: 1 },
      ctx,
    );
    expect(r.passed).toBe(false);
    // Could be a timeout or connection error depending on the platform
    expect(r.details).toBeDefined();
  });
});
