import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import type { LockstepPolicy } from './types.js';

export { PolicyEngine } from './engine.js';

const POLICY_FILENAMES = [
  '.lockstep-policy.yml',
  '.lockstep-policy.yaml',
  'lockstep-policy.yml',
];

export function loadPolicy(workingDirectory: string): LockstepPolicy {
  for (const filename of POLICY_FILENAMES) {
    const filePath = path.join(workingDirectory, filename);
    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = yaml.load(readFileSync(filePath, 'utf-8')) as LockstepPolicy | null;
    return parsed ?? {};
  }

  return {};
}
export type { LockstepPolicy, PolicyDecision, PolicyLog } from './types.js';
