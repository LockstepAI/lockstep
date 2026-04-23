import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SubTask, WorkerResult } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// File ownership enforcement
// ---------------------------------------------------------------------------

export interface OwnershipEnforcementResult {
  violations: string[];
  reverted: string[];
}

/**
 * Validates that a worker only modified files it owns.
 * Reverts any unauthorized file changes via `git checkout`.
 *
 * Files in `.lockstep/` are always allowed (contracts, summaries, etc.).
 */
export async function enforceFileOwnership(
  workerResult: WorkerResult,
  task: SubTask,
): Promise<OwnershipEnforcementResult> {
  const allowedFiles = new Set(task.files);
  const violations: string[] = [];
  const reverted: string[] = [];

  for (const file of workerResult.files_modified) {
    // Always allow .lockstep/ internal files
    if (file.startsWith('.lockstep/') || file.startsWith('.lockstep\\')) {
      continue;
    }

    if (!allowedFiles.has(file)) {
      violations.push(file);
    }
  }

  if (violations.length === 0) {
    return { violations: [], reverted: [] };
  }

  // Revert unauthorized changes
  for (const file of violations) {
    try {
      await execFileAsync('git', ['checkout', 'HEAD', '--', file], {
        cwd: workerResult.worktree_path,
      });
      reverted.push(file);
    } catch {
      // File might be newly created (untracked) — remove it
      try {
        await execFileAsync('git', ['rm', '-f', file], {
          cwd: workerResult.worktree_path,
        });
        reverted.push(file);
      } catch {
        // Can't revert — leave it, will be caught by merge
      }
    }
  }

  // Update files_modified to exclude reverted files
  const revertedSet = new Set(reverted);
  workerResult.files_modified = workerResult.files_modified.filter(
    (f) => !revertedSet.has(f),
  );
  workerResult.ownership_violations = violations;

  return { violations, reverted };
}

/**
 * Enforces ownership for all worker results.
 * Returns a map of task ID to enforcement result.
 */
export async function enforceAllOwnership(
  workerResults: WorkerResult[],
  tasks: SubTask[],
): Promise<Map<string, OwnershipEnforcementResult>> {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const results = new Map<string, OwnershipEnforcementResult>();

  for (const wr of workerResults) {
    const task = taskMap.get(wr.sub_task_id);
    if (!task) continue;

    if (wr.agent_result.success) {
      const result = await enforceFileOwnership(wr, task);
      results.set(wr.sub_task_id, result);
    }
  }

  return results;
}
