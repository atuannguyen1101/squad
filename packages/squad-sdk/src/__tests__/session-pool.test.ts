/**
 * Tests for SessionPool - Case-Insensitive Agent Name Matching + Spawn Queue
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionPool, type SquadSession } from '../client/session-pool.js';

describe('SessionPool - Case-Insensitive Agent Matching', () => {
  let pool: SessionPool;

  beforeEach(() => {
    pool = new SessionPool();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('should find session by agent name case-insensitively', () => {
    const session: SquadSession = {
      id: 'test-session-1',
      agentName: 'TestAgent',
      status: 'active',
      createdAt: new Date(),
    };

    pool.add(session);

    const found1 = pool.findByAgent('TestAgent');
    const found2 = pool.findByAgent('testagent');
    const found3 = pool.findByAgent('TESTAGENT');
    const found4 = pool.findByAgent('TeStAgEnT');

    expect(found1).toBeDefined();
    expect(found2).toBeDefined();
    expect(found3).toBeDefined();
    expect(found4).toBeDefined();

    expect(found1?.id).toBe('test-session-1');
    expect(found2?.id).toBe('test-session-1');
    expect(found3?.id).toBe('test-session-1');
    expect(found4?.id).toBe('test-session-1');
  });

  it('should return undefined for non-existent agent', () => {
    const session: SquadSession = {
      id: 'test-session-1',
      agentName: 'ExistingAgent',
      status: 'active',
      createdAt: new Date(),
    };

    pool.add(session);

    const notFound1 = pool.findByAgent('NonExistentAgent');
    const notFound2 = pool.findByAgent('different');

    expect(notFound1).toBeUndefined();
    expect(notFound2).toBeUndefined();
  });

  it('should handle multiple agents correctly', () => {
    const session1: SquadSession = {
      id: 'session-1',
      agentName: 'Agent1',
      status: 'active',
      createdAt: new Date(),
    };

    const session2: SquadSession = {
      id: 'session-2',
      agentName: 'Agent2',
      status: 'active',
      createdAt: new Date(),
    };

    pool.add(session1);
    pool.add(session2);

    const found1Lower = pool.findByAgent('agent1');
    const found2Upper = pool.findByAgent('AGENT2');

    expect(found1Lower?.agentName).toBe('Agent1');
    expect(found2Upper?.agentName).toBe('Agent2');
  });
});

describe('SessionPool - Spawn Queue', () => {
  let pool: SessionPool;

  beforeEach(() => {
    // Create pool with low max concurrent for testing
    pool = new SessionPool({ maxConcurrent: 2 });
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('should queue spawns when at capacity', () => {
    const session1: SquadSession = {
      id: 'session-1',
      agentName: 'Agent1',
      status: 'active',
      createdAt: new Date(),
    };

    const session2: SquadSession = {
      id: 'session-2',
      agentName: 'Agent2',
      status: 'active',
      createdAt: new Date(),
    };

    const session3: SquadSession = {
      id: 'session-3',
      agentName: 'Agent3',
      status: 'active',
      createdAt: new Date(),
    };

    // Add first two - should succeed
    pool.add(session1);
    pool.add(session2);

    expect(pool.size).toBe(2);
    expect(pool.atCapacity).toBe(true);
    expect(pool.queueLength).toBe(0);

    // Add third - should queue
    pool.add(session3);
    
    expect(pool.size).toBe(2); // Still at capacity
    expect(pool.queueLength).toBe(1); // One in queue
  });

  it('should process queue when slot becomes available', () => {
    const session1: SquadSession = {
      id: 'session-1',
      agentName: 'Agent1',
      status: 'active',
      createdAt: new Date(),
    };

    const session2: SquadSession = {
      id: 'session-2',
      agentName: 'Agent2',
      status: 'active',
      createdAt: new Date(),
    };

    const session3: SquadSession = {
      id: 'session-3',
      agentName: 'Agent3',
      status: 'active',
      createdAt: new Date(),
    };

    // Fill to capacity
    pool.add(session1);
    pool.add(session2);
    
    // Queue one more
    pool.add(session3);
    
    expect(pool.size).toBe(2);
    expect(pool.queueLength).toBe(1);

    // Remove one - should process queue
    pool.remove('session-1');
    
    expect(pool.size).toBe(2); // Back to capacity with queued session
    expect(pool.queueLength).toBe(0); // Queue processed
    expect(pool.get('session-3')).toBeDefined(); // Queued session now in pool
  });

  it('should handle multiple queued spawns in order', () => {
    const sessions: SquadSession[] = [];
    for (let i = 1; i <= 5; i++) {
      sessions.push({
        id: `session-${i}`,
        agentName: `Agent${i}`,
        status: 'active',
        createdAt: new Date(),
      });
    }

    // Add all 5 - first 2 in pool, last 3 in queue
    sessions.forEach(s => pool.add(s));

    expect(pool.size).toBe(2);
    expect(pool.queueLength).toBe(3);

    // Remove one - should process first queued
    pool.remove('session-1');
    expect(pool.size).toBe(2);
    expect(pool.queueLength).toBe(2);
    expect(pool.get('session-3')).toBeDefined();

    // Remove another - should process next queued
    pool.remove('session-2');
    expect(pool.size).toBe(2);
    expect(pool.queueLength).toBe(1);
    expect(pool.get('session-4')).toBeDefined();
  });

  it('should reject queued spawns on shutdown', async () => {
    const session1: SquadSession = {
      id: 'session-1',
      agentName: 'Agent1',
      status: 'active',
      createdAt: new Date(),
    };

    const session2: SquadSession = {
      id: 'session-2',
      agentName: 'Agent2',
      status: 'active',
      createdAt: new Date(),
    };

    const session3: SquadSession = {
      id: 'session-3',
      agentName: 'Agent3',
      status: 'active',
      createdAt: new Date(),
    };

    // Fill to capacity and queue one
    pool.add(session1);
    pool.add(session2);
    pool.add(session3);

    expect(pool.queueLength).toBe(1);

    // Shutdown should clear queue
    await pool.shutdown();

    expect(pool.size).toBe(0);
    expect(pool.queueLength).toBe(0);
  });

  it('should use default maxConcurrent of 5', () => {
    const defaultPool = new SessionPool();
    
    // Add 5 sessions
    for (let i = 1; i <= 5; i++) {
      defaultPool.add({
        id: `session-${i}`,
        agentName: `Agent${i}`,
        status: 'active',
        createdAt: new Date(),
      });
    }

    expect(defaultPool.size).toBe(5);
    expect(defaultPool.atCapacity).toBe(true);
    expect(defaultPool.queueLength).toBe(0);

    // 6th should queue
    defaultPool.add({
      id: 'session-6',
      agentName: 'Agent6',
      status: 'active',
      createdAt: new Date(),
    });

    expect(defaultPool.size).toBe(5);
    expect(defaultPool.queueLength).toBe(1);

    defaultPool.shutdown();
  });
});
