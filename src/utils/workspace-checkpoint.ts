import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveWithinRoot } from './path-security.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface WorkspaceCheckpoint {
  id: string;
  kind: 'git' | 'filesystem';
  metadata: {
    headCommit?: string;
  };
  restore(): Promise<void>;
  dispose(): Promise<void>;
}

function makeCheckpointId(kind: WorkspaceCheckpoint['kind'], seed?: string): string {
  const suffix = seed ? seed.slice(0, 12) : randomBytes(6).toString('hex');
  return `${kind}:${suffix}`;
}

async function isGitRepository(workingDirectory: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: workingDirectory, maxBuffer: MAX_BUFFER },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function hasGitHeadCommit(workingDirectory: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['rev-parse', '--verify', 'HEAD'],
      { cwd: workingDirectory, maxBuffer: MAX_BUFFER },
    );
    return true;
  } catch {
    return false;
  }
}

async function listGitUntrackedFiles(workingDirectory: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: workingDirectory, maxBuffer: MAX_BUFFER },
  );

  return stdout.split('\0').filter((entry) => entry.length > 0);
}

async function clearDirectoryContents(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }

    await rm(path.join(directory, entry.name), { recursive: true, force: true });
  }
}

async function createGitCheckpoint(workingDirectory: string): Promise<WorkspaceCheckpoint> {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'lockstep-git-checkpoint-'));
  const patchPath = path.join(snapshotDir, 'tracked.patch');
  const untrackedRoot = path.join(snapshotDir, 'untracked');

  const { stdout: headStdout } = await execFileAsync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: workingDirectory, maxBuffer: MAX_BUFFER },
  );
  const headCommit = headStdout.trim();

  const { stdout: trackedPatch } = await execFileAsync(
    'git',
    ['diff', '--binary', 'HEAD'],
    { cwd: workingDirectory, maxBuffer: MAX_BUFFER },
  );

  await writeFile(patchPath, trackedPatch, 'utf-8');

  const baselineUntrackedFiles = await listGitUntrackedFiles(workingDirectory);
  await mkdir(untrackedRoot, { recursive: true });

  for (const relativePath of baselineUntrackedFiles) {
    const sourcePath = resolveWithinRoot(workingDirectory, relativePath);
    const snapshotPath = path.join(untrackedRoot, relativePath);
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await cp(sourcePath, snapshotPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      verbatimSymlinks: true,
    });
  }

  return {
    id: makeCheckpointId('git', headCommit),
    kind: 'git',
    metadata: { headCommit },
    async restore(): Promise<void> {
      await execFileAsync(
        'git',
        ['reset', '--hard', headCommit],
        { cwd: workingDirectory, maxBuffer: MAX_BUFFER },
      );

      const currentUntrackedFiles = await listGitUntrackedFiles(workingDirectory);
      const baselineUntrackedSet = new Set(baselineUntrackedFiles);

      for (const relativePath of currentUntrackedFiles) {
        if (baselineUntrackedSet.has(relativePath)) {
          continue;
        }

        const targetPath = resolveWithinRoot(workingDirectory, relativePath);
        await rm(targetPath, { recursive: true, force: true });
      }

      for (const relativePath of baselineUntrackedFiles) {
        const snapshotPath = path.join(untrackedRoot, relativePath);
        const targetPath = resolveWithinRoot(workingDirectory, relativePath);
        await rm(targetPath, { recursive: true, force: true });
        await mkdir(path.dirname(targetPath), { recursive: true });
        await cp(snapshotPath, targetPath, {
          recursive: true,
          force: true,
          errorOnExist: false,
          verbatimSymlinks: true,
        });
      }

      if (trackedPatch.trim().length > 0) {
        await execFileAsync(
          'git',
          ['apply', '--binary', '--recount', '--whitespace=nowarn', patchPath],
          { cwd: workingDirectory, maxBuffer: MAX_BUFFER },
        );
      }
    },
    async dispose(): Promise<void> {
      await rm(snapshotDir, { recursive: true, force: true });
    },
  };
}

async function createFilesystemCheckpoint(
  workingDirectory: string,
): Promise<WorkspaceCheckpoint> {
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'lockstep-fs-checkpoint-'));
  const snapshotRoot = path.join(snapshotDir, 'workspace');

  await cp(workingDirectory, snapshotRoot, {
    recursive: true,
    force: true,
    errorOnExist: false,
    verbatimSymlinks: true,
    filter: (source) => {
      const relativePath = path.relative(workingDirectory, source);
      if (!relativePath) {
        return true;
      }

      const portable = relativePath.split(path.sep).join('/');
      if (portable === '.git' || portable.startsWith('.git/')) {
        return false;
      }
      if (portable === '.lockstep/worktrees' || portable.startsWith('.lockstep/worktrees/')) {
        return false;
      }

      return true;
    },
  });

  return {
    id: makeCheckpointId('filesystem'),
    kind: 'filesystem',
    metadata: {},
    async restore(): Promise<void> {
      await clearDirectoryContents(workingDirectory);
      await cp(snapshotRoot, workingDirectory, {
        recursive: true,
        force: true,
        errorOnExist: false,
        verbatimSymlinks: true,
      });
    },
    async dispose(): Promise<void> {
      await rm(snapshotDir, { recursive: true, force: true });
    },
  };
}

export async function createWorkspaceCheckpoint(
  workingDirectory: string,
): Promise<WorkspaceCheckpoint> {
  if (await isGitRepository(workingDirectory) && await hasGitHeadCommit(workingDirectory)) {
    return createGitCheckpoint(workingDirectory);
  }

  return createFilesystemCheckpoint(workingDirectory);
}
