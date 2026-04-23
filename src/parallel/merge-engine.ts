import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  WeaveConfig,
  MergeResult,
  MergeConflict,
  WorkerResult,
  ParallelConfig,
} from './types.js';
import { preMergeConfigFiles } from './config-merge.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd: repoPath });
}

async function which(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [binary]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Weave detection
// ---------------------------------------------------------------------------

const WEAVE_SUPPORTED_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go',
  '.java', '.c', '.cpp', '.rb', '.cs', '.php', '.swift',
  '.json', '.yaml', '.yml', '.toml', '.md',
];

/**
 * Detects whether the `weave-driver` binary is available in PATH.
 * Returns configuration describing Weave's availability and supported extensions.
 */
export async function detectWeave(): Promise<WeaveConfig> {
  const binaryPath = await which('weave-driver');
  if (!binaryPath) {
    return { available: false, binary_path: '', supported_extensions: [] };
  }

  // Verify it actually runs (weave-driver has no --version flag; calling with
  // no args prints usage to stderr and exits non-zero, which is expected)
  try {
    await execFileAsync(binaryPath, ['--help']);
    return {
      available: true,
      binary_path: binaryPath,
      supported_extensions: [...WEAVE_SUPPORTED_EXTENSIONS],
    };
  } catch {
    // weave-driver prints usage to stderr on --help with exit code 2 — that's fine,
    // it means the binary exists and runs. Only truly missing binaries throw ENOENT.
    return {
      available: true,
      binary_path: binaryPath,
      supported_extensions: [...WEAVE_SUPPORTED_EXTENSIONS],
    };
  }
}

// ---------------------------------------------------------------------------
// Weave git merge driver configuration
// ---------------------------------------------------------------------------

/**
 * Configures Weave as the git merge driver for a repository.
 * Creates `.gitattributes` entries that route supported file types through Weave.
 * Must be called BEFORE any merge operations.
 */
export async function configureWeaveDriver(
  repoPath: string,
  weaveConfig: WeaveConfig,
): Promise<void> {
  if (!weaveConfig.available) return;

  // Set git config for the weave merge driver
  await git(repoPath, ['config', 'merge.weave.name', 'Weave semantic merge driver']);
  await git(repoPath, ['config', 'merge.weave.driver', 'weave-driver %O %A %B %L %P']);

  // Build .gitattributes content for supported extensions
  const gitattributesPath = path.join(repoPath, '.gitattributes');
  const weaveMarkerStart = '# lockstep-weave-start';
  const weaveMarkerEnd = '# lockstep-weave-end';

  const weaveLines = weaveConfig.supported_extensions
    .map((ext) => `*${ext} merge=weave`)
    .join('\n');

  const weaveBlock = `${weaveMarkerStart}\n${weaveLines}\n${weaveMarkerEnd}`;

  // Read existing .gitattributes or start fresh
  let existing = '';
  try {
    existing = await readFile(gitattributesPath, 'utf-8');
  } catch {
    // File doesn't exist — that's fine
  }

  // Replace existing weave block or append
  const markerRegex = new RegExp(
    `${weaveMarkerStart}[\\s\\S]*?${weaveMarkerEnd}`,
  );

  let updated: string;
  if (markerRegex.test(existing)) {
    updated = existing.replace(markerRegex, weaveBlock);
  } else {
    updated = existing ? `${existing}\n${weaveBlock}\n` : `${weaveBlock}\n`;
  }

  await writeFile(gitattributesPath, updated, 'utf-8');
  await git(repoPath, ['add', '.gitattributes']);
}

/**
 * Removes Weave merge driver configuration from the repository.
 * Called during cleanup to leave the repo in a clean state.
 */
export async function removeWeaveConfig(repoPath: string): Promise<void> {
  // Remove git config entries (ignore errors if they don't exist)
  try {
    await git(repoPath, ['config', '--unset', 'merge.weave.name']);
  } catch { /* already unset */ }
  try {
    await git(repoPath, ['config', '--unset', 'merge.weave.driver']);
  } catch { /* already unset */ }

  // Remove weave block from .gitattributes
  const gitattributesPath = path.join(repoPath, '.gitattributes');
  try {
    const content = await readFile(gitattributesPath, 'utf-8');
    const markerRegex = /# lockstep-weave-start[\s\S]*?# lockstep-weave-end\n?/;
    const cleaned = content.replace(markerRegex, '');

    if (cleaned.trim()) {
      await writeFile(gitattributesPath, cleaned, 'utf-8');
    } else {
      // .gitattributes is now empty — remove the staged version
      // but keep the file (git checkout will handle it)
      await writeFile(gitattributesPath, '', 'utf-8');
    }
    await git(repoPath, ['add', '.gitattributes']);
  } catch {
    // .gitattributes doesn't exist — nothing to clean
  }
}

// ---------------------------------------------------------------------------
// Git state helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current branch name.
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

/**
 * Returns the current commit hash.
 */
async function getCurrentCommit(repoPath: string): Promise<string> {
  const { stdout } = await git(repoPath, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

/**
 * Returns files modified between a commit and HEAD.
 */
export async function getModifiedFiles(
  repoPath: string,
  sinceCommit: string,
): Promise<string[]> {
  const { stdout } = await git(repoPath, ['diff', '--name-only', `${sinceCommit}..HEAD`]);
  return stdout
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

// ---------------------------------------------------------------------------
// Merge abort
// ---------------------------------------------------------------------------

/**
 * Aborts a merge in progress.
 */
export async function abortMerge(repoPath: string): Promise<void> {
  await git(repoPath, ['merge', '--abort']);
}

// ---------------------------------------------------------------------------
// Auto-resolve conflict markers
// ---------------------------------------------------------------------------

/**
 * Heuristically resolves git conflict markers in a file.
 * Strategy:
 *   - For barrel exports / index files: combine all export lines from both sides
 *   - For import sections: combine imports from both sides
 *   - General: keep both sides (deduplicated) to avoid syntax errors
 *
 * Returns the resolved content, or null if no conflict markers found.
 */
function autoResolveConflictMarkers(content: string): string | null {
  const conflictRegex = /^<{7}\s.*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}\s.*$/gm;

  if (!conflictRegex.test(content)) {
    return null;
  }

  // Reset regex state
  conflictRegex.lastIndex = 0;

  const resolved = content.replace(conflictRegex, (_match, ours: string, theirs: string) => {
    const oursLines = ours.trimEnd().split('\n').filter((l: string) => l.trim());
    const theirsLines = theirs.trimEnd().split('\n').filter((l: string) => l.trim());

    // Deduplicate: keep all unique lines, preserving order (ours first, then theirs additions)
    const seen = new Set<string>();
    const combined: string[] = [];

    for (const line of oursLines) {
      const normalized = line.trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        combined.push(line);
      }
    }
    for (const line of theirsLines) {
      const normalized = line.trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        combined.push(line);
      }
    }

    return combined.join('\n');
  });

  return resolved;
}

/**
 * Scans all files in the repo for conflict markers and auto-resolves them.
 * Returns the number of files resolved.
 */
export async function autoResolveAllConflicts(repoPath: string): Promise<number> {
  // Find files with conflict markers
  let conflictedFiles: string[];
  try {
    const { stdout } = await execFileAsync('grep', [
      '-rl', '--include=*.ts', '--include=*.tsx', '--include=*.js',
      '--include=*.jsx', '--include=*.json', '--include=*.yaml',
      '--include=*.yml', '--include=*.md',
      '<<<<<<<', repoPath,
    ]);
    conflictedFiles = stdout.split('\n').filter((f) => f.trim());
  } catch {
    // grep returns exit code 1 when no matches found
    return 0;
  }

  let resolved = 0;
  for (const filePath of conflictedFiles) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const resolvedContent = autoResolveConflictMarkers(content);
      if (resolvedContent !== null) {
        await writeFile(filePath, resolvedContent, 'utf-8');
        resolved++;
      }
    } catch {
      // Skip files we can't read/write
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Conflict parsing
// ---------------------------------------------------------------------------

/**
 * Reads conflicted files and extracts structured conflict information.
 */
export async function getConflictDetails(
  repoPath: string,
  branchA: string,
  branchB: string,
): Promise<MergeConflict[]> {
  // List conflicted files
  const { stdout } = await git(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  const conflictedFiles = stdout
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  const conflicts: MergeConflict[] = [];

  for (const file of conflictedFiles) {
    const filePath = path.join(repoPath, file);
    let content = '';
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      // Can't read file — record conflict with empty markers
    }

    // Extract conflict markers
    const markerRegex = /(<{7}[\s\S]*?>{7}[^\n]*)/g;
    const markers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(content)) !== null) {
      markers.push(match[1]);
    }

    conflicts.push({
      file,
      worktree_a: branchA,
      worktree_b: branchB,
      conflict_markers: markers.join('\n---\n'),
      is_semantic: true, // If Weave was active, remaining conflicts are genuinely semantic
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Commit worker changes
// ---------------------------------------------------------------------------

/**
 * Ensures a worker's changes are committed in their worktree.
 * No-op if there are no uncommitted changes.
 */
async function commitWorkerChanges(
  worktreePath: string,
  subTaskId: string,
): Promise<boolean> {
  // Check if there are any changes to commit
  const { stdout: status } = await git(worktreePath, ['status', '--porcelain']);
  if (!status.trim()) {
    return false; // Nothing to commit
  }

  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-m', `lockstep worker ${subTaskId}`]);
  return true;
}

// ---------------------------------------------------------------------------
// Main merge engine
// ---------------------------------------------------------------------------

/**
 * Attempts an octopus merge of all branches at once.
 * This is O(1) and works when no two branches touch the same file.
 * Returns null if the octopus merge fails (conflicts detected).
 */
async function tryOctopusMerge(
  workerResults: WorkerResult[],
  repoPath: string,
): Promise<MergeResult | null> {
  const currentBranch = await getCurrentBranch(repoPath);
  const rollbackCommit = await getCurrentCommit(repoPath);

  const branches = workerResults.map((wr) => wr.branch_name);

  try {
    await git(repoPath, ['merge', '-s', 'octopus', '--no-edit', ...branches]);

    // Octopus succeeded — collect all modified files
    const mergedFiles = await getModifiedFiles(repoPath, rollbackCommit);

    return {
      success: true,
      merged_branch: currentBranch,
      conflicts: [],
      merged_files: mergedFiles,
      weave_used: false,
      weave_resolved: 0,
      git_fallback: false,
    };
  } catch {
    // Octopus failed — rollback and return null
    try {
      await git(repoPath, ['merge', '--abort']);
    } catch {
      // May not be in merge state
    }
    try {
      await git(repoPath, ['reset', '--hard', rollbackCommit]);
    } catch {
      // Already at rollback point
    }
    return null;
  }
}

/**
 * Merges all worker worktree branches into the current branch.
 *
 * Strategy (based on config):
 * 1. Commit all worker changes
 * 2. Pre-merge deterministic config files (package.json, tsconfig.json)
 * 3. If merge_tree: use binary merge tree O(log N)
 * 4. Else: try octopus merge (all branches at once) O(1)
 * 5. If octopus fails, fall back to sequential Weave merge O(N)
 * 6. Clean up Weave config
 *
 * Falls back to standard `git merge` when Weave is not installed.
 */
export async function mergeAllWorktrees(
  workerResults: WorkerResult[],
  repoPath: string,
  config?: ParallelConfig,
): Promise<MergeResult> {
  const currentBranch = await getCurrentBranch(repoPath);
  const rollbackCommit = await getCurrentCommit(repoPath);

  // Commit all worker changes first
  for (const worker of workerResults) {
    await commitWorkerChanges(worker.worktree_path, worker.sub_task_id);
  }

  // Pre-merge config files deterministically
  for (const worker of workerResults) {
    if (worker.files_modified.length > 0) {
      await preMergeConfigFiles(repoPath, worker.worktree_path, worker.files_modified);
    }
  }

  // Binary merge tree: merge pairs in parallel O(log N)
  if (config?.merge_tree && workerResults.length > 2) {
    const treeResult = await mergeWithBinaryTree(workerResults, repoPath);
    if (treeResult) {
      return treeResult;
    }
    // Binary tree failed — fall back to octopus/sequential
  }

  // Try octopus merge first (fastest path)
  const octopusResult = await tryOctopusMerge(workerResults, repoPath);
  if (octopusResult) {
    return octopusResult;
  }

  // Octopus failed — fall back to sequential merge with Weave
  const weaveConfig = await detectWeave();
  if (weaveConfig.available) {
    await configureWeaveDriver(repoPath, weaveConfig);
  }

  const allConflicts: MergeConflict[] = [];
  const mergedFiles: string[] = [];
  let weaveResolved = 0;

  try {
    for (const worker of workerResults) {
      // Attempt merge
      try {
        await git(repoPath, ['merge', worker.branch_name, '--no-edit']);

        // Merge succeeded — collect modified files
        const modified = await getModifiedFiles(repoPath, rollbackCommit);
        for (const file of modified) {
          if (!mergedFiles.includes(file)) {
            mergedFiles.push(file);
          }
        }

        // If Weave is active, any multi-branch merge that succeeds without
        // conflicts is potentially a Weave-resolved merge (git alone might
        // have conflicted). We conservatively count successful merges after
        // the first one as weave-assisted.
        if (weaveConfig.available && workerResults.indexOf(worker) > 0) {
          weaveResolved++;
        }
      } catch {
        // Merge failed — extract conflict details
        const conflicts = await getConflictDetails(
          repoPath,
          currentBranch,
          worker.branch_name,
        );

        // If Weave was NOT active, conflicts may not be truly semantic
        for (const conflict of conflicts) {
          conflict.is_semantic = weaveConfig.available;
        }

        allConflicts.push(...conflicts);

        // Auto-resolve conflict markers heuristically before committing.
        // This prevents cascading corruption where conflict markers from
        // one merge cause more conflicts in subsequent merges.
        const autoResolved = await autoResolveAllConflicts(repoPath);
        if (autoResolved > 0) {
          weaveResolved += autoResolved;
          // Remove conflicts that were auto-resolved from the list
          const remainingConflicts: MergeConflict[] = [];
          for (const c of allConflicts) {
            const filePath = path.join(repoPath, c.file);
            try {
              const content = await readFile(filePath, 'utf-8');
              if (content.includes('<<<<<<<')) {
                remainingConflicts.push(c);
              }
            } catch {
              remainingConflicts.push(c);
            }
          }
          allConflicts.length = 0;
          allConflicts.push(...remainingConflicts);
        }

        // Commit the (now hopefully resolved) state so subsequent merges
        // can layer on top cleanly.
        try {
          await git(repoPath, ['add', '-A']);
          await git(repoPath, ['commit', '--no-edit', '-m', `lockstep merge ${worker.branch_name}`]);
        } catch {
          // If committing fails, abort and continue
          try {
            await abortMerge(repoPath);
          } catch {
            // merge --abort can fail if no merge is in progress — ignore
          }
        }
      }
    }
  } finally {
    // Always clean up Weave config
    if (weaveConfig.available) {
      await removeWeaveConfig(repoPath);
    }
  }

  return {
    success: allConflicts.length === 0,
    merged_branch: currentBranch,
    conflicts: allConflicts,
    merged_files: mergedFiles,
    weave_used: weaveConfig.available,
    weave_resolved: weaveResolved,
    git_fallback: !weaveConfig.available,
    merge_strategy: 'sequential',
  };
}

// ---------------------------------------------------------------------------
// Binary merge tree — O(log N) merge strategy
// ---------------------------------------------------------------------------

/**
 * Merges worker branches using a binary tree strategy.
 * Pairs of branches are merged in parallel at each level, reducing
 * the total merge depth from O(N) to O(log N).
 *
 * Example with 4 branches: [A, B, C, D]
 *   Level 1: merge(A,B) and merge(C,D) in parallel → [AB, CD]
 *   Level 2: merge(AB, CD) → [ABCD]
 *
 * Each intermediate merge creates a temporary branch.
 * Returns null if any merge in the tree fails.
 */
async function mergeWithBinaryTree(
  workerResults: WorkerResult[],
  repoPath: string,
): Promise<MergeResult | null> {
  const currentBranch = await getCurrentBranch(repoPath);
  const rollbackCommit = await getCurrentCommit(repoPath);

  // Start with the worker branch names
  let branches = workerResults.map((wr) => wr.branch_name);
  let tempBranches: string[] = [];
  let level = 0;

  try {
    // Reduce branches pairwise until we have a single result
    while (branches.length > 1) {
      const pairs: [string, string][] = [];
      const nextLevel: string[] = [];

      // Pair up branches; if odd count, the last one passes through
      for (let i = 0; i < branches.length; i += 2) {
        if (i + 1 < branches.length) {
          pairs.push([branches[i], branches[i + 1]]);
        } else {
          nextLevel.push(branches[i]); // Odd one out — pass through
        }
      }

      // Merge each pair sequentially (git can't handle concurrent
      // checkout/merge on the same working directory)
      for (let idx = 0; idx < pairs.length; idx++) {
        const [a, b] = pairs[idx];
        const tempBranch = `lockstep-merge-tree-L${level}-${idx}`;
        tempBranches.push(tempBranch);

        try {
          // Create temp branch from first branch
          await git(repoPath, ['branch', tempBranch, a]);
          // Checkout temp branch
          await git(repoPath, ['checkout', tempBranch]);
          // Merge second branch into it
          await git(repoPath, ['merge', b, '--no-edit']);
          // Auto-resolve any conflict markers
          const autoResolved = await autoResolveAllConflicts(repoPath);
          if (autoResolved > 0) {
            await git(repoPath, ['add', '-A']);
            await git(repoPath, ['commit', '--no-edit', '-m', `lockstep tree merge L${level}-${idx} (auto-resolved)`]);
          }
          // Go back to original branch
          await git(repoPath, ['checkout', currentBranch]);
          nextLevel.push(tempBranch);
        } catch {
          // Pair merge failed — try auto-resolve before giving up
          try {
            const autoResolved = await autoResolveAllConflicts(repoPath);
            if (autoResolved > 0) {
              await git(repoPath, ['add', '-A']);
              await git(repoPath, ['commit', '--no-edit', '-m', `lockstep tree merge L${level}-${idx} (auto-resolved)`]);
              await git(repoPath, ['checkout', currentBranch]);
              nextLevel.push(tempBranch);
            } else {
              // Can't resolve — tree merge fails
              await cleanupTempBranches(repoPath, tempBranches, currentBranch, rollbackCommit);
              return null;
            }
          } catch {
            await cleanupTempBranches(repoPath, tempBranches, currentBranch, rollbackCommit);
            return null;
          }
        }
      }

      branches = nextLevel;
      level++;
    }

    // Final step: merge the single remaining branch into current
    if (branches.length === 1 && branches[0] !== currentBranch) {
      await git(repoPath, ['checkout', currentBranch]);
      await git(repoPath, ['merge', branches[0], '--no-edit']);
    }

    const mergedFiles = await getModifiedFiles(repoPath, rollbackCommit);

    // Clean up temp branches
    for (const temp of tempBranches) {
      try {
        await git(repoPath, ['branch', '-D', temp]);
      } catch {
        // Already deleted or doesn't exist
      }
    }

    return {
      success: true,
      merged_branch: currentBranch,
      conflicts: [],
      merged_files: mergedFiles,
      weave_used: false,
      weave_resolved: 0,
      git_fallback: false,
      merge_strategy: 'tree',
    };
  } catch {
    // Tree merge failed — clean up
    await cleanupTempBranches(repoPath, tempBranches, currentBranch, rollbackCommit);
    return null;
  }
}

async function cleanupTempBranches(
  repoPath: string,
  tempBranches: string[],
  targetBranch: string,
  rollbackCommit: string,
): Promise<void> {
  try {
    await git(repoPath, ['checkout', targetBranch]);
  } catch { /* already on target */ }
  try {
    await git(repoPath, ['merge', '--abort']);
  } catch { /* no merge in progress */ }
  try {
    await git(repoPath, ['reset', '--hard', rollbackCommit]);
  } catch { /* already at rollback */ }

  for (const temp of tempBranches) {
    try {
      await git(repoPath, ['branch', '-D', temp]);
    } catch { /* already deleted */ }
  }
}
