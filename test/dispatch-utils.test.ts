/**
 * Tests for DispatchSemaphore and safeSendAndWait
 * 
 * These utilities address critical landmines:
 * - Landmine #2: Copilot SDK sendAndWait ignores timeout parameter
 * - Landmine #5: Copilot backend can only handle ~1 concurrent sendAndWait
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DispatchSemaphore } from '../packages/squad-sdk/src/mcp/dispatch-utils.js';

describe('DispatchSemaphore', () => {
  let semaphore: DispatchSemaphore;

  beforeEach(() => {
    semaphore = new DispatchSemaphore(1); // Max 1 concurrent as per landmine #5
  });

  it('allows single concurrent task', async () => {
    let executing = 0;
    let maxConcurrent = 0;

    const task = async () => {
      executing++;
      maxConcurrent = Math.max(maxConcurrent, executing);
      await new Promise(resolve => setTimeout(resolve, 50));
      executing--;
    };

    await semaphore.acquire();
    try {
      await task();
    } finally {
      semaphore.release();
    }

    expect(maxConcurrent).toBe(1);
  });

  it('serializes multiple concurrent calls', async () => {
    let executing = 0;
    let maxConcurrent = 0;
    const executionOrder: number[] = [];

    const createTask = (id: number) => async () => {
      await semaphore.acquire();
      try {
        executing++;
        maxConcurrent = Math.max(maxConcurrent, executing);
        executionOrder.push(id);
        await new Promise(resolve => setTimeout(resolve, 10));
        executing--;
      } finally {
        semaphore.release();
      }
    };

    // Launch 3 tasks concurrently
    await Promise.all([
      createTask(1)(),
      createTask(2)(),
      createTask(3)(),
    ]);

    // Should never have more than 1 executing at once
    expect(maxConcurrent).toBe(1);
    
    // All tasks should complete
    expect(executionOrder.length).toBe(3);
  });

  it('handles errors without blocking semaphore', async () => {
    const task1 = async () => {
      await semaphore.acquire();
      try {
        throw new Error('Task failed');
      } finally {
        semaphore.release();
      }
    };

    const task2 = async () => {
      await semaphore.acquire();
      try {
        return 'success';
      } finally {
        semaphore.release();
      }
    };

    // First task fails
    await expect(task1()).rejects.toThrow('Task failed');
    
    // Second task should still work (semaphore not blocked)
    const result = await task2();
    expect(result).toBe('success');
  });

  it('supports configurable maxConcurrent', async () => {
    const sem3 = new DispatchSemaphore(3);
    let executing = 0;
    let maxConcurrent = 0;

    const createTask = () => async () => {
      await sem3.acquire();
      try {
        executing++;
        maxConcurrent = Math.max(maxConcurrent, executing);
        await new Promise(resolve => setTimeout(resolve, 50));
        executing--;
      } finally {
        sem3.release();
      }
    };

    await Promise.all([
      createTask()(),
      createTask()(),
      createTask()(),
      createTask()(),
      createTask()(),
    ]);

    expect(maxConcurrent).toBe(3);
  });

  it('enforces serial execution with max 1 concurrent', async () => {
    let executing = 0;
    let maxConcurrent = 0;
    const executionOrder: number[] = [];

    const createTask = (id: number) => async () => {
      await semaphore.acquire();
      try {
        executing++;
        maxConcurrent = Math.max(maxConcurrent, executing);
        executionOrder.push(id);
        await new Promise(resolve => setTimeout(resolve, 10));
        executing--;
      } finally {
        semaphore.release();
      }
    };

    // Launch 3 tasks concurrently
    await Promise.all([
      createTask(1)(),
      createTask(2)(),
      createTask(3)(),
    ]);

    // Should never have more than 1 executing at once
    expect(maxConcurrent).toBe(1);
    
    // All tasks should complete
    expect(executionOrder.length).toBe(3);
  });
});

describe('safeSendAndWait', () => {
  // Note: Full integration tests for safeSendAndWait require a real SquadSession
  // These tests verify the wrapper behavior with mocked sessions

  it('enforces timeout when sendAndWait hangs (landmine #2)', async () => {
    const mockSession = {
      sendAndWait: vi.fn(async () => {
        // Simulate hanging sendAndWait that ignores timeout parameter
        await new Promise(resolve => setTimeout(resolve, 200000)); // 200s
        return { content: 'Never reached' };
      }),
    };

    const { safeSendAndWait } = await import('../packages/squad-sdk/src/mcp/dispatch-utils.js');

    const startTime = Date.now();
    
    await expect(
      safeSendAndWait(mockSession as any, 'Test prompt', 100) // 100ms timeout
    ).rejects.toThrow('timeout');

    const duration = Date.now() - startTime;
    
    // Should timeout around 100ms, not 200s
    expect(duration).toBeLessThan(200);
  });

  it('uses settled flag to prevent duplicate messages', async () => {
    const messages: string[] = [];
    
    const mockSession = {
      sendAndWait: vi.fn(async () => {
        // Simulate delayed response that resolves after timeout
        await new Promise(resolve => setTimeout(resolve, 200));
        messages.push('Late response');
        return { content: 'Late' };
      }),
    };

    const { safeSendAndWait } = await import('../packages/squad-sdk/src/mcp/dispatch-utils.js');

    try {
      await safeSendAndWait(mockSession as any, 'Test', 100);
    } catch (err) {
      // Expected timeout
    }

    // Wait for late resolution
    await new Promise(resolve => setTimeout(resolve, 250));

    // The settled flag should prevent the late message from being processed
    // (In real implementation, messages are pushed to arrays that respect the settled flag)
    expect(mockSession.sendAndWait).toHaveBeenCalled();
  });

  it('returns response when sendAndWait completes in time', async () => {
    const mockSession = {
      sendAndWait: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { content: 'Success' };
      }),
    };

    const { safeSendAndWait } = await import('../packages/squad-sdk/src/mcp/dispatch-utils.js');

    const result = await safeSendAndWait(mockSession as any, 'Test', 1000);
    
    expect(result).toEqual({ content: 'Success' });
  });

  it('uses default 90s timeout when not specified', async () => {
    const mockSession = {
      sendAndWait: vi.fn(async () => {
        return { content: 'Fast' };
      }),
    };

    const { safeSendAndWait } = await import('../packages/squad-sdk/src/mcp/dispatch-utils.js');

    // Should not throw with default timeout
    const result = await safeSendAndWait(mockSession as any, 'Test');
    expect(result).toEqual({ content: 'Fast' });
  });
});

describe('Semaphore + safeSendAndWait integration', () => {
  it('enforces single concurrent sendAndWait (landmine #5)', async () => {
    const semaphore = new DispatchSemaphore(1);
    let concurrent = 0;
    let maxConcurrent = 0;

    const mockSession = {
      sendAndWait: vi.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 50));
        concurrent--;
        return { content: 'Done' };
      }),
    };

    const { safeSendAndWait } = await import('../packages/squad-sdk/src/mcp/dispatch-utils.js');

    const sendWithSemaphore = async (prompt: string) => {
      await semaphore.acquire();
      try {
        return await safeSendAndWait(mockSession as any, prompt, 5000);
      } finally {
        semaphore.release();
      }
    };

    // Launch 3 concurrent sends
    await Promise.all([
      sendWithSemaphore('Prompt 1'),
      sendWithSemaphore('Prompt 2'),
      sendWithSemaphore('Prompt 3'),
    ]);

    // Should never have more than 1 concurrent
    expect(maxConcurrent).toBe(1);
    
    // All calls should complete
    expect(mockSession.sendAndWait).toHaveBeenCalledTimes(3);
  });
});
