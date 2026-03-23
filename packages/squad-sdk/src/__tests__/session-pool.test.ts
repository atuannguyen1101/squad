/**
 * Tests for SessionPool - Case-Insensitive Agent Name Matching
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
