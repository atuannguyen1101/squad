/**
 * Dispatch Utilities - Safe sendAndWait wrapper and semaphore
 *
 * CRITICAL LANDMINES FROM PREVIOUS ATTEMPT:
 * 1. Copilot SDK sendAndWait does NOT enforce its timeout parameter - it hangs indefinitely
 * 2. Promise.race leaves dangling promises - use settled flag to prevent duplicate messages
 * 3. Copilot backend can only handle ~1 concurrent sendAndWait reliably
 *
 * This module provides:
 * - safeSendAndWait: Promise.race wrapper with settled flag protection
 * - DispatchSemaphore: Serializes sendAndWait calls to prevent backend stalls
 */

import type { SquadSession } from '../adapter/types.js';

/**
 * Semaphore to serialize sendAndWait calls.
 * Copilot backend can only handle ~1 concurrent sendAndWait call reliably.
 * Multiple concurrent calls cause all sessions to stall silently.
 */
export class DispatchSemaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Acquire the semaphore. Returns a promise that resolves when permission is granted.
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  /**
   * Get current queue depth (for monitoring/debugging).
   */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Get active count (for monitoring/debugging).
   */
  getActiveCount(): number {
    return this.active;
  }
}

/**
 * Safe wrapper around session.sendAndWait that:
 * 1. Enforces timeout with Promise.race (SDK timeout is not reliable)
 * 2. Uses settled flag to prevent duplicate message pushing from late-resolving promises
 * 3. Properly handles cleanup on timeout
 *
 * @param session - The SDK session to send the message to
 * @param message - The message to send
 * @param timeoutMs - Timeout in milliseconds (default: 90000 = 90s)
 * @returns Promise that resolves with the response or rejects on timeout
 */
export async function safeSendAndWait(
  session: SquadSession,
  message: string,
  timeoutMs: number = 90000
): Promise<unknown> {
  if (!session.sendAndWait) {
    throw new Error('Session does not support sendAndWait');
  }

  let settled = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`sendAndWait timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });

  const sendPromise = session.sendAndWait({ prompt: message }, timeoutMs).then(
    (result) => {
      if (!settled) {
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        return result;
      }
      // If already settled, this result is ignored (prevents duplicate pushes)
      return null;
    },
    (error) => {
      if (!settled) {
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        throw error;
      }
      // If already settled, this error is ignored
      return null;
    }
  );

  return Promise.race([sendPromise, timeoutPromise]);
}

/**
 * Execute a function with semaphore protection.
 * Ensures only maxConcurrent operations run simultaneously.
 *
 * @param semaphore - The dispatch semaphore to use
 * @param fn - The async function to execute
 * @returns Promise that resolves with the function's result
 */
export async function withSemaphore<T>(
  semaphore: DispatchSemaphore,
  fn: () => Promise<T>
): Promise<T> {
  const release = await semaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
