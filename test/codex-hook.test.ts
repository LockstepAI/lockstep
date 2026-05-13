import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { evaluatePreToolUsePayload } from '../src/policy/codex-hook.js';

const cleanupDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockstep-codex-hook-'));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Codex PreToolUse policy hook', () => {
  it('denies protected-file shell writes before Codex can execute them', () => {
    const dir = makeTempDir();

    const output = evaluatePreToolUsePayload(
      {
        hook_event_name: 'PreToolUse',
        cwd: dir,
        tool_input: {
          command: 'printf tampered > .env',
        },
      },
      {
        mode: 'review',
        filesystem: {
          protected: ['.env'],
          writable: ['src/**'],
        },
      },
      dir,
    );

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(output?.hookSpecificOutput.permissionDecisionReason).toContain('.env');
    expect(output?.hookSpecificOutput.permissionDecisionReason).toContain('policy:filesystem:protected:.env');
  });

  it('denies protected-file writes hidden behind a nested shell wrapper', () => {
    const dir = makeTempDir();

    const output = evaluatePreToolUsePayload(
      {
        hook_event_name: 'PreToolUse',
        cwd: dir,
        tool_input: {
          command: "bash -lc 'printf tampered > .env'",
        },
      },
      {
        filesystem: {
          protected: ['.env'],
          writable: ['src/**'],
        },
      },
      dir,
    );

    expect(output?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output?.hookSpecificOutput.permissionDecisionReason).toContain('policy:filesystem:protected:.env');
  });

  it('allows safe shell commands without returning hook output', () => {
    const dir = makeTempDir();

    const output = evaluatePreToolUsePayload(
      {
        hook_event_name: 'PreToolUse',
        cwd: dir,
        tool_input: {
          command: 'npm test',
        },
      },
      {
        filesystem: {
          protected: ['.env'],
          writable: ['src/**'],
        },
      },
      dir,
    );

    expect(output).toBeNull();
  });

  it('denies protected reads when Codex exposes a readable path payload', () => {
    const dir = makeTempDir();

    const output = evaluatePreToolUsePayload(
      {
        hook_event_name: 'PreToolUse',
        cwd: dir,
        tool_name: 'Read',
        tool_input: {
          file_path: 'secrets/prod.key',
        },
      },
      {
        filesystem: {
          protected: ['secrets/**'],
        },
      },
      dir,
    );

    expect(output?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output?.hookSpecificOutput.permissionDecisionReason).toContain('protected_read');
  });
});
