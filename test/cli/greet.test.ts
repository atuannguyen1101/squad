import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { greetCommand } from '../../packages/squad-cli/src/cli/commands/greet.js';

describe('greetCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints "Hello World"', async () => {
    await greetCommand();
    expect(logSpy).toHaveBeenCalledWith('Hello World');
  });
});
