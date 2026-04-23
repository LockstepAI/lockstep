import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import * as fs from 'node:fs/promises';

import { resolveWithinRoot, sanitizeTaskId } from '../utils/path-security.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKTREES_DIR = '.lockstep/worktrees';
const BRANCH_PREFIX = 'lockstep-worker-';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function worktreePath(repoPath: string, worktreeName: string): string {
  return resolveWithinRoot(repoPath, path.join(WORKTREES_DIR, sanitizeTaskId(worktreeName)));
}

function branchName(worktreeName: string): string {
  return `${BRANCH_PREFIX}${sanitizeTaskId(worktreeName)}`;
}

async function git(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd: repoPath });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Symlinks heavy directories (e.g. node_modules) from the main repo into a worktree.
 * Skips directories that don't exist in the main repo or already exist in the worktree.
 */
export async function symlinkDirectories(
  repoPath: string,
  worktreePath: string,
  directories: string[],
): Promise<void> {
  for (const dir of directories) {
    const source = path.join(repoPath, dir);
    const target = path.join(worktreePath, dir);

    // Check if the source directory exists in the main repo
    try {
      await fs.stat(source);
    } catch {
      continue; // Source doesn't exist, skip
    }

    // Check if it already exists in the worktree
    try {
      await fs.lstat(target);
      console.warn(`[lockstep] symlink skipped: ${dir} already exists in worktree`);
      continue;
    } catch {
      // Doesn't exist — good, we can create the symlink
    }

    await fs.symlink(source, target, 'dir');
  }
}

/**
 * Creates a new git worktree for a parallel worker.
 * The worktree lives at `<repoPath>/.lockstep/worktrees/<worktreeName>/`
 * on a new branch `lockstep-worker-<worktreeName>`.
 */
export async function createWorktree(
  repoPath: string,
  worktreeName: string,
  symlinkDirs?: string[],
): Promise<WorktreeInfo> {
  const wtPath = worktreePath(repoPath, worktreeName);
  const branch = branchName(worktreeName);

  // Ensure the parent directory exists
  await fs.mkdir(path.dirname(wtPath), { recursive: true });

  await git(repoPath, ['worktree', 'add', wtPath, '-b', branch]);

  if (symlinkDirs && symlinkDirs.length > 0) {
    await symlinkDirectories(repoPath, wtPath, symlinkDirs);
  }

  return { name: worktreeName, path: wtPath, branch };
}

/**
 * Removes a worktree and deletes its associated branch.
 */
export async function removeWorktree(
  repoPath: string,
  worktreeName: string,
): Promise<void> {
  const wtPath = worktreePath(repoPath, worktreeName);
  const branch = branchName(worktreeName);

  await git(repoPath, ['worktree', 'remove', wtPath, '--force']);
  await git(repoPath, ['branch', '-D', branch]);
}

/**
 * Lists all lockstep worktrees (those inside `.lockstep/worktrees/`).
 * Parses the porcelain output of `git worktree list`.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<WorktreeInfo[]> {
  const { stdout } = await git(repoPath, ['worktree', 'list', '--porcelain']);

  const worktrees: WorktreeInfo[] = [];
  const lockstepDir = resolveWithinRoot(repoPath, WORKTREES_DIR);

  // Porcelain format: blocks separated by blank lines.
  // Each block has lines like:
  //   worktree /path/to/worktree
  //   HEAD <sha>
  //   branch refs/heads/<branch>
  const blocks = stdout.split('\n\n');

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length === 0) continue;

    let wtPath = '';
    let branch = '';

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        // branch refs/heads/lockstep-worker-foo -> lockstep-worker-foo
        branch = line.slice('branch '.length).replace('refs/heads/', '');
      }
    }

    // Only include worktrees inside our lockstep directory
    const relative = path.relative(lockstepDir, wtPath);
    if (!wtPath || (relative && (relative.startsWith('..') || path.isAbsolute(relative)))) continue;
    if (!branch.startsWith(BRANCH_PREFIX)) continue;

    const name = branch.slice(BRANCH_PREFIX.length);
    worktrees.push({ name, path: wtPath, branch });
  }

  return worktrees;
}

/**
 * Merges a worktree's branch into the current branch of the main repo.
 * Returns success status and a list of conflicted files (if any).
 */
export async function mergeWorktree(
  repoPath: string,
  worktreeName: string,
): Promise<{ success: boolean; conflicts: string[] }> {
  const branch = branchName(worktreeName);

  try {
    await git(repoPath, ['merge', branch, '--no-edit']);
    return { success: true, conflicts: [] };
  } catch {
    // Merge failed — detect conflicted files
    try {
      const { stdout } = await git(repoPath, [
        'diff', '--name-only', '--diff-filter=U',
      ]);
      const conflicts = stdout
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      return { success: false, conflicts };
    } catch {
      // Could not even detect conflicts — return empty list
      return { success: false, conflicts: [] };
    }
  }
}

/**
 * Removes all lockstep worktrees and their branches.
 */
export async function cleanupAllWorktrees(
  repoPath: string,
): Promise<void> {
  const worktrees = await listWorktrees(repoPath);

  for (const wt of worktrees) {
    await removeWorktree(repoPath, wt.name);
  }
}
