/**
 * Git CLI wrapper utilities — zero dependencies
 *
 * Shared git helpers for Squad CLI commands. Follows the same pattern as
 * gh-cli.ts: thin wrappers around CLI invocations with graceful error handling.
 */

import { execFileSync } from 'node:child_process';

/** Shared options for silent git calls — encoding: utf-8, all stdio piped. */
function execOpts(cwd?: string) {
  return {
    encoding: 'utf-8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  };
}

/**
 * Check if git is available on the system PATH.
 */
export function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], execOpts());
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name via `git branch --show-current`.
 *
 * Returns `null` when:
 * - Not inside a git repository
 * - In detached HEAD state (no current branch)
 * - git is not installed
 *
 * @param cwd — working directory (defaults to process.cwd())
 */
export function getCurrentBranch(cwd?: string): string | null {
  try {
    const branch = execFileSync(
      'git',
      ['branch', '--show-current'],
      execOpts(cwd ?? process.cwd()),
    ).trim();
    return branch || null; // empty string in detached HEAD → null
  } catch {
    return null;
  }
}

/**
 * Get the repository root (top-level directory) via `git rev-parse --show-toplevel`.
 *
 * Returns `null` when not inside a git repository.
 *
 * @param cwd — working directory (defaults to process.cwd())
 */
export function getRepoRoot(cwd?: string): string | null {
  try {
    const root = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      execOpts(cwd ?? process.cwd()),
    ).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Get the remote URL for a given remote name.
 *
 * Returns `null` when the remote doesn't exist or not in a git repo.
 *
 * @param remote — remote name (defaults to 'origin')
 * @param cwd — working directory (defaults to process.cwd())
 */
export function getRemoteUrl(remote = 'origin', cwd?: string): string | null {
  try {
    const url = execFileSync(
      'git',
      ['remote', 'get-url', remote],
      execOpts(cwd ?? process.cwd()),
    ).trim();
    return url || null;
  } catch {
    return null;
  }
}
