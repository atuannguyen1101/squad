/**
 * Git utility tests — packages/squad-cli/src/cli/core/git-utils.ts
 *
 * Tests the shared git wrapper functions used by CLI commands.
 * Uses the real git CLI (this repo IS a git repo) for integration-style
 * assertions, plus mocked execFileSync for edge cases.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getCurrentBranch, getRepoRoot, getRemoteUrl, gitAvailable } from '../packages/squad-cli/src/cli/core/git-utils.js';

// ── Real git integration tests ─────────────────────────────────

describe('git-utils (integration — real git repo)', () => {
  it('gitAvailable returns true (git is installed in CI and dev)', () => {
    expect(gitAvailable()).toBe(true);
  });

  it('getCurrentBranch returns a non-empty string in a real repo', () => {
    const branch = getCurrentBranch();
    expect(branch).not.toBeNull();
    expect(typeof branch).toBe('string');
    expect(branch!.length).toBeGreaterThan(0);
    // Should not contain whitespace or newlines
    expect(branch).not.toMatch(/\s/);
  });

  it('getCurrentBranch accepts an explicit cwd', () => {
    const branch = getCurrentBranch(process.cwd());
    expect(branch).not.toBeNull();
    expect(typeof branch).toBe('string');
  });

  it('getRepoRoot returns an absolute path', () => {
    const root = getRepoRoot();
    expect(root).not.toBeNull();
    expect(typeof root).toBe('string');
    // Should be an absolute path (Unix / or Windows Q:\ or Q:/)
    expect(root).toMatch(/^(\/|[A-Za-z]:[/\\])/);
  });

  it('getRemoteUrl returns a URL for origin', () => {
    const url = getRemoteUrl('origin');
    // May be null if no remote configured (unlikely in this repo, but safe)
    if (url !== null) {
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    }
  });
});

// ── Edge-case tests with mocked execFileSync ───────────────────

// We mock the entire module at the vi.mock level to intercept execFileSync
// calls made by git-utils.ts.
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

describe('git-utils (edge cases)', () => {
  const execFileSyncMock = vi.mocked(childProcess.execFileSync);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getCurrentBranch returns null when git throws (not a repo)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(getCurrentBranch('/tmp/not-a-repo')).toBeNull();
  });

  it('getCurrentBranch returns null for detached HEAD (empty output)', () => {
    execFileSyncMock.mockReturnValue('');
    expect(getCurrentBranch()).toBeNull();
  });

  it('getCurrentBranch trims whitespace from output', () => {
    execFileSyncMock.mockReturnValue('  feat/my-branch\n');
    expect(getCurrentBranch()).toBe('feat/my-branch');
  });

  it('getRepoRoot returns null when git throws', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(getRepoRoot('/tmp/nowhere')).toBeNull();
  });

  it('getRemoteUrl returns null when remote does not exist', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("fatal: No such remote 'nonexistent'");
    });
    expect(getRemoteUrl('nonexistent')).toBeNull();
  });

  it('getRemoteUrl defaults remote to origin', () => {
    execFileSyncMock.mockReturnValue('https://github.com/example/repo.git\n');
    const url = getRemoteUrl();
    expect(url).toBe('https://github.com/example/repo.git');
    // Verify 'origin' was passed
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('gitAvailable returns false when git is not installed', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(gitAvailable()).toBe(false);
  });
});
