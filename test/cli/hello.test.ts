import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { helloCommand } from '../../packages/squad-cli/src/cli/commands/hello.js';

describe('helloCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints "Hello from Team Ben!"', async () => {
    await helloCommand();
    expect(logSpy).toHaveBeenCalledWith('Hello from Team Ben!');
  });
});
