import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { versionCommand } from '../../packages/squad-cli/src/cli/commands/version.js';

describe('versionCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints a valid semver-like version string', async () => {
    await versionCommand();
    expect(logSpy).toHaveBeenCalledOnce();
    const version = logSpy.mock.calls[0]![0] as string;
    // Version should match semver pattern (e.g., 0.8.25 or 0.8.25-build.8)
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('does not print extra output', async () => {
    await versionCommand();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
