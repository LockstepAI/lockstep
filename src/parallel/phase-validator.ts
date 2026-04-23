import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TaskDecomposition, SharedContracts, DecompositionScore } from './types.js';
import type { LanguageInfo } from './language-detect.js';
import { scoreDecomposition, getScoreWarnings } from './decomposition-scorer.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Coordinator quality validation
// ---------------------------------------------------------------------------

/**
 * Validates coordinator output quality beyond structural correctness.
 * Returns errors (fatal) and warnings (informational).
 */
export function validateCoordinatorQuality(
  decomposition: TaskDecomposition,
): PhaseValidationResult & { score: DecompositionScore } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const task of decomposition.sub_tasks) {
    if (task.prompt.length < 20) {
      warnings.push(
        `Task "${task.id}" has a very short prompt (${task.prompt.length} chars)`,
      );
    }

    if (task.files.length === 0 && task.reads.length === 0) {
      warnings.push(
        `Task "${task.id}" owns no files and reads nothing`,
      );
    }
  }

  // Single-task decomposition is valid but wasteful
  if (decomposition.sub_tasks.length === 1) {
    warnings.push(
      'Single sub-task decomposition — parallel adds overhead without benefit',
    );
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const taskMap = new Map(decomposition.sub_tasks.map((t) => [t.id, t]));

  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.depends_on) {
        if (hasCycle(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const task of decomposition.sub_tasks) {
    if (hasCycle(task.id)) {
      errors.push(`Circular dependency detected involving task "${task.id}"`);
      break;
    }
  }

  // Decomposition scoring
  const score = scoreDecomposition(decomposition);
  const scoreWarnings = getScoreWarnings(score);
  warnings.push(...scoreWarnings);

  return { valid: errors.length === 0, errors, warnings, score };
}

// ---------------------------------------------------------------------------
// Architect quality validation
// ---------------------------------------------------------------------------

/**
 * Validates architect output: glue point references and contract syntax.
 */
export async function validateArchitectQuality(
  contracts: SharedContracts,
  decomposition: TaskDecomposition,
  language: LanguageInfo,
): Promise<PhaseValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate glue points reference valid task IDs
  const taskIds = new Set(decomposition.sub_tasks.map((t) => t.id));

  for (let i = 0; i < contracts.glue_points.length; i++) {
    const gp = contracts.glue_points[i];
    if (!taskIds.has(gp.source_task)) {
      errors.push(
        `glue_points[${i}]: source_task "${gp.source_task}" is not a valid sub-task`,
      );
    }
    if (!taskIds.has(gp.target_task)) {
      errors.push(
        `glue_points[${i}]: target_task "${gp.target_task}" is not a valid sub-task`,
      );
    }
    if (gp.source_task === gp.target_task) {
      warnings.push(
        `glue_points[${i}]: source and target are the same task "${gp.source_task}"`,
      );
    }
  }

  // Syntax-check contracts content
  const syntaxResult = await checkContractsSyntax(
    contracts.contracts_content,
    language,
  );

  if (!syntaxResult.valid) {
    errors.push(`Contracts syntax error: ${syntaxResult.error}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Syntax checkers (best-effort, skip if tool unavailable)
// ---------------------------------------------------------------------------

async function checkContractsSyntax(
  content: string,
  language: LanguageInfo,
): Promise<{ valid: boolean; error?: string }> {
  if (!content.trim()) {
    return { valid: false, error: 'contracts_content is empty' };
  }

  try {
    switch (language.id) {
      case 'typescript':
      case 'javascript':
        return await checkTypeScriptSyntax(content);
      case 'python':
        return await checkPythonSyntax(content);
      default:
        return { valid: true };
    }
  } catch {
    // Checker unavailable — skip
    return { valid: true };
  }
}

async function checkTypeScriptSyntax(
  content: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Use esbuild's transform API (available as devDep) for fast syntax checking
    const esbuild = await import('esbuild');
    await esbuild.transform(content, { loader: 'ts' });
    return { valid: true };
  } catch (err: unknown) {
    // If esbuild isn't available, skip
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_MODULE_NOT_FOUND') {
      return { valid: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Extract first error line
    const firstError = msg.split('\n').find((l) => l.includes('ERROR')) ?? msg.slice(0, 200);
    return { valid: false, error: firstError };
  }
}

async function checkPythonSyntax(
  content: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    await execFileAsync('python3', [
      '-c',
      `import ast; ast.parse(${JSON.stringify(content)})`,
    ], { timeout: 5_000 });
    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lastLine = msg.split('\n').filter(Boolean).pop() ?? 'Python syntax error';
    return { valid: false, error: lastLine };
  }
}
