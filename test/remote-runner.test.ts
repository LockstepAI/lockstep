import { describe, expect, it } from 'vitest';
import { parseLocalSpec } from '../src/remote/runner.js';

describe('remote runner spec parsing', () => {
  it('accepts public launch vocabulary aliases before executing API-backed runs', () => {
    const spec = parseLocalSpec(`
version: "1"
config:
  runner: claude
  review_mode: codex
brief: Public vocabulary spec
phases:
  - name: Foundation
    prompt: Create the base files
    signals:
      - signal: artifact_ready
        artifact: package.json
      - signal: artifact_match
        artifact: package.json
        expect: name
`);

    expect(spec.config?.agent).toBe('claude');
    expect(spec.config?.judge_mode).toBe('codex');
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0].validate).toEqual([
      { signal: 'artifact_ready', artifact: 'package.json', type: 'file_exists', target: 'package.json' },
      { signal: 'artifact_match', artifact: 'package.json', expect: 'name', type: 'file_contains', path: 'package.json', pattern: 'name' },
    ]);
  });
});
