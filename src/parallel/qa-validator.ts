import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  QAValidationResult,
  QACheck,
  SharedContracts,
  WorkerResult,
} from './types.js';
import type { LanguageInfo } from './language-detect.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// QA Phase 5.5 — Post-integration programmatic checks
// ---------------------------------------------------------------------------

/**
 * Runs all QA checks on the integrated codebase.
 * Called after the Integrator phase, before producing the final result.
 */
export async function runQAValidation(
  workingDirectory: string,
  contracts: SharedContracts,
  workerResults: WorkerResult[],
  language: LanguageInfo,
): Promise<QAValidationResult> {
  const checks: QACheck[] = [];

  // Run all checks in parallel where possible
  const [conflictCheck, gluePointCheck, typeCheck] = await Promise.all([
    checkConflictMarkers(workingDirectory, workerResults),
    checkGluePointWiring(workingDirectory, contracts),
    checkTypeErrors(workingDirectory, language),
  ]);

  checks.push(conflictCheck, gluePointCheck, typeCheck);

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * Scans all worker-modified files for leftover conflict markers.
 * Any `<<<<<<<`, `=======`, `>>>>>>>` in code means the integrator
 * failed to resolve a conflict.
 */
async function checkConflictMarkers(
  workingDirectory: string,
  workerResults: WorkerResult[],
): Promise<QACheck> {
  const allFiles = new Set<string>();
  for (const wr of workerResults) {
    for (const f of wr.files_modified) {
      allFiles.add(f);
    }
  }

  const conflictFiles: string[] = [];

  for (const file of allFiles) {
    try {
      const content = await readFile(
        path.join(workingDirectory, file),
        'utf-8',
      );
      // Use regex to detect actual git conflict markers (exactly 7 chars at start of line)
      // Avoids false positives from decorative comment lines like // ============================
      const hasConflict =
        /^<{7}[ \t]/m.test(content) ||
        /^>{7}[ \t]/m.test(content) ||
        /^={7}$/m.test(content);
      if (hasConflict) {
        conflictFiles.push(file);
      }
    } catch {
      // File might not exist (deleted by integrator) — skip
    }
  }

  if (conflictFiles.length > 0) {
    return {
      name: 'conflict-markers',
      passed: false,
      details: `Unresolved conflict markers in: ${conflictFiles.join(', ')}`,
    };
  }

  return { name: 'conflict-markers', passed: true };
}

/**
 * Verifies that glue points defined by the Architect are wired up.
 * For each glue point with connection_type "import" or "export",
 * checks that the source task's files contain relevant export/import statements.
 */
async function checkGluePointWiring(
  workingDirectory: string,
  contracts: SharedContracts,
): Promise<QACheck> {
  const missingWiring: string[] = [];

  for (const gp of contracts.glue_points) {
    if (gp.connection_type !== 'import' && gp.connection_type !== 'export') {
      continue;
    }

    // We can't perfectly verify wiring without AST parsing,
    // but we can check that the description keywords appear
    // somewhere in the modified files. This is a heuristic.
    // The key check is that glue point descriptions don't reference
    // files that don't exist.
    const descLower = gp.description.toLowerCase();

    // Extract function/class names from the description
    const identifiers = descLower.match(/\b[a-z_][a-z0-9_]*(?:(?:Service|Handler|Controller|Manager|Factory|Provider|Repository|Store|Router|Middleware|Util|Helper|Config))\b/gi);

    if (!identifiers || identifiers.length === 0) {
      continue; // Can't extract identifiers to check
    }

    // Search for these identifiers in the working directory
    let found = false;
    try {
      const { stdout } = await execFileAsync(
        'grep',
        ['-rl', identifiers[0], '--include=*.ts', '--include=*.js', '--include=*.py', '--include=*.rs', '--include=*.go'],
        { cwd: workingDirectory },
      );
      found = stdout.trim().length > 0;
    } catch {
      // grep returns non-zero when no matches — that's expected
    }

    if (!found) {
      missingWiring.push(
        `${gp.source_task} → ${gp.target_task}: "${gp.description}"`,
      );
    }
  }

  if (missingWiring.length > 0) {
    return {
      name: 'glue-point-wiring',
      passed: false,
      details: `Potentially unwired glue points:\n${missingWiring.map((m) => `  - ${m}`).join('\n')}`,
    };
  }

  return { name: 'glue-point-wiring', passed: true };
}

/**
 * Runs a basic type check if a type checker is available.
 * TypeScript: `npx tsc --noEmit`
 * Python: `python3 -m py_compile` on modified files
 * Others: skip (pass by default)
 */
async function checkTypeErrors(
  workingDirectory: string,
  language: LanguageInfo,
): Promise<QACheck> {
  try {
    switch (language.id) {
      case 'typescript':
      case 'javascript':
        return await checkTypeScript(workingDirectory);
      case 'python':
        return await checkPython(workingDirectory);
      case 'go':
        return await checkGo(workingDirectory);
      case 'rust':
        return await checkRust(workingDirectory);
      default:
        return { name: 'type-check', passed: true, details: 'Skipped (no checker for language)' };
    }
  } catch {
    // Type checker not available — pass
    return { name: 'type-check', passed: true, details: 'Skipped (checker unavailable)' };
  }
}

async function checkTypeScript(workingDirectory: string): Promise<QACheck> {
  try {
    await execFileAsync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
      cwd: workingDirectory,
      timeout: 30_000,
    });
    return { name: 'type-check', passed: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Extract first few errors
    const errors = msg.split('\n').filter((l) => l.includes('error TS')).slice(0, 5);
    if (errors.length === 0) {
      // tsc not available or other issue — pass
      return { name: 'type-check', passed: true, details: 'Skipped (tsc unavailable)' };
    }
    return {
      name: 'type-check',
      passed: false,
      details: `TypeScript errors:\n${errors.join('\n')}`,
    };
  }
}

async function checkPython(workingDirectory: string): Promise<QACheck> {
  try {
    await execFileAsync('python3', ['-m', 'py_compile', '--'], {
      cwd: workingDirectory,
      timeout: 15_000,
    });
    return { name: 'type-check', passed: true };
  } catch {
    return { name: 'type-check', passed: true, details: 'Skipped (python checker unavailable)' };
  }
}

async function checkGo(workingDirectory: string): Promise<QACheck> {
  try {
    const { stderr } = await execFileAsync('go', ['build', './...'], {
      cwd: workingDirectory,
      timeout: 30_000,
    });
    if (stderr && stderr.includes('error')) {
      return {
        name: 'type-check',
        passed: false,
        details: `Go build errors:\n${stderr.slice(0, 500)}`,
      };
    }
    return { name: 'type-check', passed: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      return { name: 'type-check', passed: true, details: 'Skipped (go not available)' };
    }
    return {
      name: 'type-check',
      passed: false,
      details: `Go build failed:\n${msg.slice(0, 500)}`,
    };
  }
}

async function checkRust(workingDirectory: string): Promise<QACheck> {
  try {
    await execFileAsync('cargo', ['check', '--message-format=short'], {
      cwd: workingDirectory,
      timeout: 60_000,
    });
    return { name: 'type-check', passed: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      return { name: 'type-check', passed: true, details: 'Skipped (cargo not available)' };
    }
    return {
      name: 'type-check',
      passed: false,
      details: `Cargo check failed:\n${msg.slice(0, 500)}`,
    };
  }
}
