import type {
  WorkerResult,
  TaskDecomposition,
  FailureAttribution,
} from './types.js';

// ---------------------------------------------------------------------------
// Failure attribution — map validation errors to specific workers
// ---------------------------------------------------------------------------

/**
 * Extracts file paths from an error message.
 * Matches patterns like:
 *   src/foo/bar.ts
 *   src/foo/bar.ts:42
 *   src/foo/bar.ts(42,5)
 *   './src/foo/bar.ts'
 *   "src/foo/bar.ts"
 */
export function extractFilePaths(errorMessage: string): string[] {
  const patterns = [
    // Quoted paths
    /['"]([^'"]+\.[a-z]{1,4})(?:[:(\s]|['"])/gi,
    // Path:line:col or path:line
    /(?:^|\s)([\w./-]+\.[a-z]{1,4})(?::(\d+)(?::(\d+))?)?/gm,
    // Path(line,col)
    /([\w./-]+\.[a-z]{1,4})\(\d+,\d+\)/g,
  ];

  const paths = new Set<string>();

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(errorMessage)) !== null) {
      const filePath = match[1];
      // Filter out obvious non-paths
      if (
        filePath &&
        filePath.includes('/') &&
        !filePath.startsWith('http') &&
        !filePath.startsWith('//')
      ) {
        paths.add(filePath);
      }
    }
  }

  return [...paths];
}

/**
 * Maps file paths to the workers that own them.
 */
function buildFileOwnershipMap(
  decomposition: TaskDecomposition,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const task of decomposition.sub_tasks) {
    for (const file of task.files) {
      map.set(file, task.id);
    }
  }
  return map;
}

/**
 * Attributes a validation failure to specific workers based on
 * file paths mentioned in the error message.
 *
 * Returns attributions sorted by confidence (highest first).
 */
export function attributeFailure(
  errorMessage: string,
  decomposition: TaskDecomposition,
  workerResults: WorkerResult[],
): FailureAttribution[] {
  const filePaths = extractFilePaths(errorMessage);
  const ownershipMap = buildFileOwnershipMap(decomposition);

  // Count how many error-referenced files each worker owns
  const workerHits = new Map<string, string[]>();

  for (const filePath of filePaths) {
    // Direct match
    let owner = ownershipMap.get(filePath);

    // Try matching by file basename if direct match fails
    if (!owner) {
      for (const [ownedFile, taskId] of ownershipMap) {
        if (filePath.endsWith(ownedFile) || ownedFile.endsWith(filePath)) {
          owner = taskId;
          break;
        }
      }
    }

    if (owner) {
      const hits = workerHits.get(owner) ?? [];
      hits.push(filePath);
      workerHits.set(owner, hits);
    }
  }

  // Also check worker results for files_modified matching error paths
  for (const wr of workerResults) {
    for (const modifiedFile of wr.files_modified) {
      for (const errorPath of filePaths) {
        if (
          modifiedFile === errorPath ||
          modifiedFile.endsWith(errorPath) ||
          errorPath.endsWith(modifiedFile)
        ) {
          const hits = workerHits.get(wr.sub_task_id) ?? [];
          if (!hits.includes(modifiedFile)) {
            hits.push(modifiedFile);
          }
          workerHits.set(wr.sub_task_id, hits);
        }
      }
    }
  }

  if (workerHits.size === 0 && filePaths.length === 0) {
    // Can't attribute — return all failed workers
    return workerResults
      .filter((wr) => !wr.agent_result.success)
      .map((wr) => ({
        worker_id: wr.sub_task_id,
        confidence: 0.2,
        reason: 'Worker failed with no attributable file paths',
        files: [],
      }));
  }

  // Build attributions with confidence based on hit count
  const totalHits = [...workerHits.values()].reduce((s, h) => s + h.length, 0);
  const attributions: FailureAttribution[] = [];

  for (const [workerId, files] of workerHits) {
    attributions.push({
      worker_id: workerId,
      confidence: totalHits > 0 ? files.length / totalHits : 0.5,
      reason: `Files referenced in error: ${files.join(', ')}`,
      files,
    });
  }

  return attributions.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Determines which workers to retry based on failure attribution.
 * Returns worker IDs that should be retried.
 */
export function selectWorkersForRetry(
  attributions: FailureAttribution[],
  minConfidence: number = 0.3,
): string[] {
  if (attributions.length === 0) return [];

  return attributions
    .filter((a) => a.confidence >= minConfidence)
    .map((a) => a.worker_id);
}
