import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export function getLockstepVersion(): string {
  try {
    const startDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = startDir;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (pkg.name === '@lockstep-ai/lockstep' || pkg.name === 'lockstep') return pkg.version || 'unknown';
      } catch { /* keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
